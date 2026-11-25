import assert from "node:assert/strict";
import { recovery } from "../js/pose.js";

let crop;
const ctx = {
  fillRect() {},
  drawImage(source, x, y, size) { crop = { x, y, size }; },
  getImageData() { return crop; },
  putImageData(pixels) { crop = pixels; },
};
globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
const pose = Array.from({ length: 33 }, () => ({ x: 500, y: 400, z: 0, v: 0 }));
for (const [i, x, y] of [[23, 500, 420], [25, 580, 430], [27, 565, 526]]) pose[i] = { x, y, z: -0.1, v: 1 };
const anchor = { t: 0, x: 500, y: 400, r: 100, ok: true, pose };
const missed = () => ({ ...anchor, t: 0.02, pose: null });
const queue = (openRecovery, sample) => {
  const r = recovery({ openRecovery }, 1000, 1000);
  r.observe(anchor, {});
  r.observe(sample, {});
  return r;
};

let opened = 0, closed = 0;
const detector = {
  detect() {
    return { landmarks: [pose.map(p => ({ x: (p.x - crop.x) / crop.size, y: (p.y - crop.y) / crop.size, z: p.z, visibility: p.v }))] };
  },
  close() { closed++; },
};
const s = missed();
const r = queue(async () => { opened++; return detector; }, s);
assert.equal(opened, 0, "no secondary inference or model load during plate tracking");
await r.finish(new AbortController().signal, () => {});
assert.equal(s.pose, null, "an accepted leg does not supply landmarks for the face, torso or arms");
assert.deepEqual(s.recoveredLeg, {
  side: "l", hip: { x: 500, y: 420, v: 1 }, knee: { x: 580, y: 430, v: 1 }, ankle: { x: 565, y: 526, v: 1 },
});
assert.equal(closed, 1);

let arrive;
const ac = new AbortController(), interrupted = missed();
const loading = queue(() => new Promise(resolve => { arrive = resolve; }), interrupted);
const finished = loading.finish(ac.signal, () => {});
ac.abort();
await finished;
arrive(detector);
await Promise.resolve();
assert.equal(closed, 2, "release a model that finishes loading after cancellation");
assert.equal(interrupted.recoveredLeg, undefined);
console.log("Pose recovery passed");
