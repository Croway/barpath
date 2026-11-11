/* Runs the plate tracker over a video the way the browser does (crop + scale per frame) and
 * compares it with the ground truth from synth.mjs.
 *
 *   node test/track.test.mjs synth.mp4 [--miss 0.2]    (--miss: tap this far off-centre, as a share of the radius)
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PlateTracker, detectAt } from "../js/plate.js";

const file = process.argv[2];
const miss = (() => { const i = process.argv.indexOf("--miss"); return i >= 0 ? Number(process.argv[i + 1]) : 0.2; })();
const T = JSON.parse(readFileSync(file.replace(/\.\w+$/, ".truth.json"), "utf8"));
const { W, H } = T;

/** what ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h) + getImageData gives: bilinear resample of a crop */
export function crop(frame, W, sx, sy, sw, sh, w, h) {
  const out = new Uint8ClampedArray(w * h * 4), fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = Math.min(W - 1.001, Math.max(0, sx + (x + 0.5) * fx - 0.5)), Y = Math.max(0, sy + (y + 0.5) * fy - 0.5);
    const x0 = Math.floor(X), y0 = Math.floor(Y), ax = X - x0, ay = Y - y0;
    for (let c = 0; c < 4; c++) {
      const p = (r, k) => frame[(r * W + k) * 4 + c];
      out[(y * w + x) * 4 + c] = (p(y0, x0) * (1 - ax) + p(y0, x0 + 1) * ax) * (1 - ay) + (p(y0 + 1, x0) * (1 - ax) + p(y0 + 1, x0 + 1) * ax) * ay;
    }
  }
  return { data: out, width: w, height: h };
}

const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdio: ["ignore", "pipe", "inherit"] });
const size = W * H * 4;
let pending = Buffer.alloc(0), f = 0, tracker = null;
const samples = [];
const t0 = performance.now();
let procMs = 0;
for await (const chunk of ff.stdout) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= size) {
    const frame = new Uint8ClampedArray(pending.subarray(0, size));
    pending = pending.subarray(size);
    const t = f / T.fps;
    const a = performance.now();
    if (!tracker) {
      // the user taps near the middle of the plate; the app crops half the frame height around it
      const tap = { x: T.start.x + miss * T.R, y: T.start.y - miss * T.R * 0.6 };
      const side = Math.min(W, H) * 0.5, k = 256 / side;
      const sx = Math.max(0, Math.min(W - side, tap.x - side / 2)), sy = Math.max(0, Math.min(H - side, tap.y - side / 2));
      const img = crop(frame, W, sx, sy, side, side, 256, 256);
      const d = detectAt(img, (tap.x - sx) * k, (tap.y - sy) * k, 0.025 * H * k, 0.22 * H * k);
      const det = { x: sx + d.x / k, y: sy + d.y / k, r: d.r / k };
      console.log(`tap off by ${(miss * 100).toFixed(0)}% of r -> found centre (${det.x.toFixed(1)}, ${det.y.toFixed(1)}) r=${det.r.toFixed(1)}  truth (${T.start.x.toFixed(1)}, ${T.start.y.toFixed(1)}) r=${T.R.toFixed(1)}  coverage ${d.coverage.toFixed(2)}`);
      tracker = new PlateTracker(det.x, det.y, det.r, W, H);
    }
    const roi = tracker.roi(t);
    const img = crop(frame, W, roi.sx, roi.sy, roi.sw, roi.sh, roi.w, roi.h);
    const s = tracker.update(img, roi, t);
    procMs += performance.now() - a;
    samples.push(s);
    f++;
  }
}
const err = samples.map((s, i) => Math.hypot(s.x - T.frames[i].px, s.y - T.frames[i].py));
const okN = samples.filter((s) => s.ok).length;
const sorted = [...err].sort((a, b) => a - b), q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
const mm = 1000 / T.ppm;
console.log(`${f} frames, ${okN} tracked (${((100 * okN) / f).toFixed(1)}%), ${(procMs / f).toFixed(2)} ms/frame incl. crop`);
console.log(`centre error: median ${q(0.5).toFixed(2)} px (${(q(0.5) * mm).toFixed(1)} mm), p95 ${q(0.95).toFixed(2)} px (${(q(0.95) * mm).toFixed(1)} mm), max ${q(1).toFixed(2)} px (${(q(1) * mm).toFixed(1)} mm)`);
const rs = samples.filter((s) => s.ok).map((s) => s.r).sort((a, b) => a - b);
console.log(`radius: median ${rs[rs.length >> 1].toFixed(2)} px (truth ${T.R.toFixed(2)})`);
writeFileSync(file.replace(/\.\w+$/, ".samples.json"), JSON.stringify(samples));
// The synthetic scene is harder than real footage on purpose: the left half of the rim is invisible against the
// dark body while a crisp lip sits just inside it, so the tap can settle on a rim/lip blend (radius a few % small).
// Real plates show the rim all round (see the real-clip run), so the bar here: radius within 5%, centre within 15 mm.
const rErr = Math.abs(rs[rs.length >> 1] - T.R) / T.R;
if (q(0.95) * mm > 15 || okN < 0.95 * f || rErr > 0.05) { console.error(`FAIL: p95 ${(q(0.95) * mm).toFixed(1)} mm, radius off ${(rErr * 100).toFixed(1)}%, ${okN}/${f} frames`); process.exit(1); }
console.log("PASS");
