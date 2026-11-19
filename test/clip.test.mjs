// Keeping part of a video (js/clip.js): clips made with ffmpeg in the layouts phones and browsers write, cut, then
// checked with ffmpeg: every kept frame is byte-identical to the original's (framemd5) and sits at its old time
// minus the offset clip.js reports; the kept part covers the asked range (from its keyframe; a frame or two past the
// end with B-frames, which earlier frames need to decode); audio is kept; the file decodes cleanly.
//   node test/clip.test.mjs            (needs ffmpeg and ffprobe; skips without them)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trimVideo } from "../js/clip.js";

const has = (c) => spawnSync(c, ["-version"]).status === 0;
if (!has("ffmpeg") || !has("ffprobe")) { console.log("SKIP clip test: needs ffmpeg and ffprobe"); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "clip-"));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
};
const SRC = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=60:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8"];
const CASES = {
  "h264 B-frames + aac, moov at the end": [...SRC, "-c:v", "libx264", "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "x.mp4"],
  "h264, moov first (faststart)": [...SRC, "-c:v", "libx264", "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "x.mp4"],
  "h264 without B-frames, no audio": ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=8", "-c:v", "libx264", "-g", "30", "-bf", "0", "-pix_fmt", "yuv420p", "x.mp4"],
  "hevc (hvc1) B-frames + aac": [...SRC, "-c:v", "libx265", "-x265-params", "keyint=60:min-keyint=60:bframes=3:log-level=error", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "x.mp4"],
  "quicktime .mov": [...SRC, "-c:v", "libx264", "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mov", "x.mp4"],
  "fragmented (MediaRecorder-like)": [...SRC, "-c:v", "libx264", "-g", "60", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "x.mp4"],
};
/** every video frame: { pts (s), md5 }, in presentation order: hashes from framemd5, exact times from ffprobe (framemd5
 * rounds times to its own timebase, which loses times off the frame grid) */
const times = (f) => {
  const md5 = run("ffmpeg", ["-v", "error", "-i", f, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framemd5", "-"]).split("\n")
    .filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").map((x) => x.trim())[5]);
  const pts = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", f]))
    .frames.map((x) => Number(x.best_effort_timestamp_time));
  if (md5.length !== pts.length) throw new Error(`${f}: ${md5.length} hashes, ${pts.length} times`);
  return md5.map((m, i) => ({ pts: pts[i], md5: m }));
};
const streams = (f) => run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", f]).trim().split("\n");

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };
for (const [name, args] of Object.entries(CASES)) {
  const src = join(dir, "x.mp4"), out = join(dir, "y.mp4");
  run("ffmpeg", ["-v", "error", "-y", ...args.slice(0, -1), src]);
  const blob = new Blob([readFileSync(src)]);
  for (const [from, to] of [[2.5, 5.2], [0.2, 3], [4.1, null]]) {
    const r = await trimVideo(blob, from, to);
    writeFileSync(out, Buffer.from(await r.blob.arrayBuffer()));
    const A = times(src), B = times(out);
    const clean = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"], { encoding: "utf8" });
    // each kept frame: the same picture, at the old time minus the offset
    const byMd5 = new Map(A.map((a) => [a.md5 + "@" + a.pts.toFixed(4), a]));
    const matched = B.filter((b) => byMd5.has(b.md5 + "@" + (b.pts + r.offset).toFixed(4))).length;
    const shownFrom = B.length ? Math.min(...B.map((b) => b.pts + r.offset)) : NaN, shownTo = B.length ? Math.max(...B.map((b) => b.pts + r.offset)) : NaN;
    const want = A.filter((a) => a.pts >= from - 1e-6 && (to === null || a.pts <= to + 1e-6)).length;
    const covered = B.length >= want && shownFrom <= from + 1e-6 && (to === null ? Math.abs(shownTo - Math.max(...A.map((a) => a.pts))) < 1e-3 : shownTo >= to - 1 / 30 && shownTo <= to + 0.1);
    ok(clean.status === 0 && !clean.stderr.trim() && matched === B.length && covered && Math.abs(Math.min(...B.map((b) => b.pts))) < 1e-6 && streams(out).length === streams(src).length,
      `${name}: ${from}–${to ?? "end"} s → ${B.length} frames (asked ${want}), from ${shownFrom.toFixed(3)} s, offset ${r.offset.toFixed(4)} s, ` +
      `${matched}/${B.length} identical at old − offset, ${(r.after / 1e6).toFixed(2)} of ${(r.before / 1e6).toFixed(2)} MB${clean.stderr.trim() ? `, decode: ${clean.stderr.trim().slice(0, 120)}` : ""}`);
  }
  let code = null;
  try { await trimVideo(blob, 0, null); } catch (e) { code = e.code; }
  ok(code === "nothing", `${name}: the whole video → "nothing" (${code})`);
}
let code = null;
run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=2", "-c:v", "libvpx", join(dir, "w.webm")]);
try { await trimVideo(new Blob([readFileSync(join(dir, "w.webm"))]), 0.5, 1); } catch (e) { code = e.code; }
ok(code === "format", `WebM → "format" (${code})`);
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
