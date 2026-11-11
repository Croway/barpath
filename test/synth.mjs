/* A synthetic snatch, filmed side-on, with a known bar path (the ground truth for the tests).
 *
 *   node test/synth.mjs out.mp4 [--fps 60] [--w 1280 --h 720] [--slowmo 1]
 *
 * Writes out.mp4 and out.truth.json (the plate centre per frame, in pixels and metres).
 * The plate spins and carries markings, a dark "body" moves behind it, the background
 * has clutter, frames get motion blur and sensor noise: what the tracker has to cope with.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--") && !/^\d/.test(a)) || "synth.mp4";
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? Number(args[i + 1]) : d; };
const FPS = opt("fps", 60), W = opt("w", 1280), H = opt("h", 720), SLOW = opt("slowmo", 1), FACE = opt("face", 1);

// ---- the lift: (t s, height m, vertical speed m/s) and (t, forward m, forward speed) keyframes, lifter facing +x
const YK = [[0, 0.225, 0], [0.8, 0.225, 0], [1.35, 0.52, 1.2], [1.47, 0.655, 1.02], [1.62, 0.89, 1.9], [1.81, 1.07, 0],
  [2.0, 0.95, -0.2], [2.1, 0.94, 0], [2.4, 0.94, 0], [3.4, 1.75, 0], [4.5, 1.75, 0]];
const XK = [[0, 0, 0], [0.8, 0, 0], [1.35, -0.04, -0.03], [1.47, -0.05, 0], [1.62, -0.01, 0.35], [1.81, 0.03, 0.05],
  [2.0, 0.0, -0.25], [2.1, -0.02, 0], [2.4, -0.02, 0], [3.4, -0.01, 0], [4.5, -0.01, 0]];
const DUR = 4.5;
function hermite(K, t) {
  t = Math.max(K[0][0], Math.min(K[K.length - 1][0], t));
  let i = 0;
  while (i < K.length - 2 && t > K[i + 1][0]) i++;
  const [t0, p0, m0] = K[i], [t1, p1, m1] = K[i + 1], h = t1 - t0, s = (t - t0) / h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * m1;
}
export const truthAt = (t) => ({ y: hermite(YK, t), x: hermite(XK, t) });

// ---- camera: 266.7 px per metre, floor 40 px from the bottom, start position at 45% of the width
const PPM = (H / 720) * 266.7, FLOOR = H - (H / 720) * 40, X0 = W * 0.45, R = 0.225 * PPM;
const toPx = (p) => ({ x: X0 + FACE * p.x * PPM, y: FLOOR - p.y * PPM });

// ---- static background: wall gradient, floor, a rack, a bench, some posters
const bg = new Float32Array(W * H * 3);
function rect(x0, y0, x1, y1, c) {
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1); x++) {
    const i = (y * W + x) * 3; bg[i] = c[0]; bg[i + 1] = c[1]; bg[i + 2] = c[2];
  }
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3, f = y < FLOOR ? 150 + 40 * (y / H) : 85 + 20 * Math.sin(x / 37);
  bg[i] = f; bg[i + 1] = f * 0.95; bg[i + 2] = f * 0.88;
}
rect(W * 0.08, H * 0.1, W * 0.1, FLOOR, [60, 62, 70]); rect(W * 0.2, H * 0.1, W * 0.22, FLOOR, [60, 62, 70]);
rect(W * 0.08, H * 0.35, W * 0.22, H * 0.37, [200, 40, 40]);
rect(W * 0.72, H * 0.15, W * 0.86, H * 0.4, [40, 90, 160]); rect(W * 0.74, H * 0.6, W * 0.95, H * 0.68, [120, 110, 90]);
rect(0, FLOOR - 3, W, FLOOR, [50, 50, 50]);

// ---- per frame: background + a dark "body" behind the plate + the plate, averaged over the exposure
const plateSpin = (t) => (t < 1.6 ? 0 : Math.min(1, (t - 1.6) / 0.4) * 2.6); // radians, the bar turns over
function drawFrame(t, buf) {
  const sub = [-1 / 240, 0, 1 / 240]; // 1/120 s exposure, 3 sub-samples
  const acc = new Float32Array(W * H * 3);
  for (const ds of sub) {
    const tt = Math.max(0, t + ds), p = toPx(truthAt(tt)), body = { x: p.x - FACE * 0.18 * PPM, y: p.y };
    const img = bg.slice();
    // body: a dark torso and legs that ride with the bar (distracting edges right behind the plate)
    const top = Math.min(FLOOR - 1.7 * PPM + (1.75 - truthAt(tt).y) * 0.4 * PPM, p.y - 0.5 * PPM);
    for (let y = Math.max(0, top | 0); y < FLOOR; y++) for (let x = Math.max(0, (body.x - 0.17 * PPM) | 0); x < Math.min(W, body.x + 0.17 * PPM); x++) {
      const i = (y * W + x) * 3; img[i] = 45; img[i + 1] = 40; img[i + 2] = 52;
    }
    // plate: black bumper, grey lip, steel hub, a white logo and a yellow band that spin with the bar
    const a = plateSpin(tt), ca = Math.cos(a), sa = Math.sin(a);
    for (let y = Math.max(0, (p.y - R - 2) | 0); y < Math.min(H, p.y + R + 2); y++) for (let x = Math.max(0, (p.x - R - 2) | 0); x < Math.min(W, p.x + R + 2); x++) {
      const dx = x + 0.5 - p.x, dy = y + 0.5 - p.y, d = Math.hypot(dx, dy), alpha = Math.max(0, Math.min(1, R - d + 0.5));
      if (alpha <= 0) continue;
      const u = (dx * ca + dy * sa) / R, v = (-dx * sa + dy * ca) / R; // plate coordinates
      let c = [28, 28, 30];
      if (d > 0.9 * R) c = [55, 55, 58];
      else if (d < 0.2 * R) c = d < 0.1 * R ? [90, 90, 95] : [185, 188, 192];
      else if (Math.abs(v) < 0.09 && u > 0.3 && u < 0.75) c = [235, 235, 235];
      else if (d > 0.62 * R && d < 0.7 * R && u < -0.2) c = [220, 190, 30];
      const i = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) img[i + k] = img[i + k] * (1 - alpha) + c[k] * alpha;
    }
    for (let i = 0; i < acc.length; i++) acc[i] += img[i] / sub.length;
  }
  for (let j = 0, i = 0; j < W * H; j++, i += 3) {
    const nz = (Math.random() + Math.random() + Math.random() - 1.5) * 6;
    buf[j * 4] = acc[i] + nz; buf[j * 4 + 1] = acc[i + 1] + nz; buf[j * 4 + 2] = acc[i + 2] + nz; buf[j * 4 + 3] = 255;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // a slow-motion file stores FPS*SLOW real frames per second but plays them at FPS
  const realFps = FPS * SLOW, n = Math.round(DUR * realFps);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", String(FPS), "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const buf = new Uint8ClampedArray(W * H * 4), truth = [];
  for (let f = 0; f < n; f++) {
    const t = f / realFps;
    drawFrame(t, buf);
    const m = truthAt(t), p = toPx(m);
    truth.push({ f, t_video: f / FPS, t, px: p.x, py: p.y, x_m: m.x, y_m: m.y });
    if (!ff.stdin.write(Buffer.from(buf.buffer))) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  // reference numbers, from the analytic path on a fine grid
  let vmax = 0, tv = 0, peak = 0;
  for (let t = 0.8; t < 2.0; t += 0.0005) { const v = (truthAt(t + 0.0005).y - truthAt(t - 0.0005).y) / 0.001; if (v > vmax) { vmax = v; tv = t; } }
  for (let t = 1.5; t < 2.0; t += 0.0005) peak = Math.max(peak, truthAt(t).y);
  let low = 9; for (let t = 1.81; t < 2.4; t += 0.0005) low = Math.min(low, truthAt(t).y);
  writeFileSync(out.replace(/\.\w+$/, ".truth.json"), JSON.stringify({ fps: FPS, slowmo: SLOW, W, H, R, ppm: PPM, face: FACE, start: toPx(truthAt(0)),
    ref: { vmax, t_vmax: tv, peak, catch: low, drop: peak - low, t_liftoff: 0.8 }, frames: truth }));
  console.log(`wrote ${out}: ${n} frames, ${W}x${H} @ ${FPS} fps (x${SLOW} slow-mo), plate r=${R.toFixed(1)} px, vmax ${vmax.toFixed(3)} m/s @ ${tv.toFixed(3)} s, peak ${peak.toFixed(3)} m, catch ${low.toFixed(3)} m`);
}
