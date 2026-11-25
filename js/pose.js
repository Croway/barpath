/* Body tracking with MediaPipe Pose Landmarker (33 landmarks). Loaded on first use from vendor/ (bundled,
 * cached by the service worker, works offline; run tools/fetch-vendor.sh), or from a CDN if that copy is
 * missing. Runs on the GPU when the browser allows it, otherwise on the CPU. */
const VERSION = "0.10.21";
const LOCAL = new URL("../vendor/mediapipe/", import.meta.url).href;
const SOURCES = [
  { base: LOCAL, model: (k) => `${LOCAL}pose_landmarker_${k}.task` },
  {
    base: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/`,
    model: (k) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${k}/float16/1/pose_landmarker_${k}.task`,
  },
];
const cache = {};
let clock = 0, offset = 0; // VIDEO mode needs timestamps that only ever increase, across runs too

export async function load(kind) {
  if (cache[kind]) return cache[kind];
  let last;
  for (const src of SOURCES) {
    try {
      const { FilesetResolver, PoseLandmarker } = await import(`${src.base}vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${src.base}wasm`);
      for (const delegate of ["GPU", "CPU"]) {
        try {
          const lm = await PoseLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: src.model(kind), delegate },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          // Use an independent image detector for recovery. A crop fed into the video tracker
          // would move its existing tracked region into a different coordinate system.
          const openRecovery = () => PoseLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: src.model(kind), delegate: "CPU" },
            runningMode: "IMAGE", numPoses: 1,
            minPoseDetectionConfidence: 0.25, minPosePresenceConfidence: 0.35,
          });
          return (cache[kind] = { lm, delegate, kind, local: src.base === LOCAL, openRecovery });
        } catch (e) { last = e; }
      }
    } catch (e) { last = e; }
  }
  throw last;
}

/** call before a pass over a video starting at `start` seconds */
export function beginRun(start) { offset = clock + 1000 - Math.round(start * 1000); }

/** landmarks of the current video frame in video pixels ({x, y, z, v}), or null when nobody is found */
export function detect(P, source, t, W, H) {
  clock = Math.max(clock + 1, offset + Math.round(t * 1000));
  const res = P.lm.detectForVideo(source, clock);
  const L = res?.landmarks?.[0];
  if (!L) return null;
  return L.map((p) => ({ x: p.x * W, y: p.y * H, z: p.z, v: p.visibility ?? 1 }));
}

/** Capture a bounded set of missing frames while the plate is tracked. Only after the video
 * stops do we run the more expensive image detector. 60 crops at 320 px use at most 24 MiB. */
export function recovery(P, W, H, slow = 1) {
  const crops = [], resolution = 320;
  let last, canvas, ctx, retryAt = -Infinity;
  const near = p => p[23].z + p[25].z + p[27].z <= p[24].z + p[26].z + p[28].z ? 0 : 1;
  const visible = p => p?.v >= 0.5;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function capture(sample, source) {
    if (sample.pose) { last = sample; retryAt = -Infinity; return; }
    if (!sample.ok || !last?.ok || sample.t < retryAt || sample.t - last.t > 0.75 * slow || crops.length >= 60) return;
    const prev = last.pose, side = near(prev);
    if (![23, 25, 27].every(i => visible(prev[i + side]))) return;
    const points = prev.filter(visible), xs = points.map(p => p.x), ys = points.map(p => p.y);
    const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
    const size = Math.min(Math.max(W, H), Math.max(5.2 * sample.r, 1.25 * (right - left), 1.25 * (bottom - top)));
    if (!(size > 0)) return;
    const x = (left + right - size) / 2 + sample.x - last.x;
    const y = (top + bottom - size) / 2 + sample.y - last.y;
    retryAt = sample.t + 0.03 * slow;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = canvas.height = resolution;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, resolution, resolution);
    ctx.drawImage(source, x, y, size, size, 0, 0, resolution, resolution);
    crops.push({ sample, prev, side, x, y, size, pixels: ctx.getImageData(0, 0, resolution, resolution) });
  }

  function recover(lm, { sample, prev, side, x, y, size, pixels }) {
    ctx.putImageData(pixels, 0, 0);
    const points = lm.detect(canvas).landmarks?.[0];
    if (!points || near(points) !== side) return;
    const leg = [23, 25, 27].map(i => {
      const p = points[i + side];
      return { x: x + p.x * size, y: y + p.y * size, v: p.visibility ?? 1 };
    });
    if (!leg.every(visible)) return;
    const [hip, knee, ankle] = leg, oldHip = prev[23 + side], oldKnee = prev[25 + side], oldAnkle = prev[27 + side];
    const shin = distance(oldKnee, oldAnkle), thigh = distance(hip, knee), newShin = distance(knee, ankle);
    if (!(shin > 0) || thigh < 0.5 * shin || thigh > 1.8 * shin || newShin < 0.65 * shin || newShin > 1.5 * shin ||
        distance(ankle, oldAnkle) > 0.5 * shin || distance(hip, oldHip) > 1.5 * shin) return;
    // A crouched thigh should not reverse its horizontal direction across a short dropout.
    const oldDx = oldKnee.x - oldHip.x, dx = knee.x - hip.x;
    if (Math.abs(oldDx) > 0.35 * shin && Math.abs(dx) > 0.35 * shin && oldDx * dx < 0) return;
    sample.recoveredLeg = { side: side ? "r" : "l", hip, knee, ankle };
  }

  async function finish(signal, progress) {
    if (!crops.length || signal.aborted) return;
    let active = true, lm, timer, stop;
    const stopped = new Promise(resolve => { stop = () => resolve(null); });
    signal.addEventListener("abort", stop, { once: true });
    try {
      // Optional model startup must never hold a completed primary track indefinitely.
      timer = setTimeout(stop, 8000);
      lm = await Promise.race([stopped, P.openRecovery().then(model => {
        if (active) return model;
        model.close();
        return null;
      })]);
      clearTimeout(timer);
      if (!lm) return;
      for (let i = 0; i < crops.length && !signal.aborted; i++) {
        recover(lm, crops[i]);
        progress((i + 1) / crops.length);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      active = false;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      crops.length = 0;
      lm?.close();
    }
  }
  let captureFailed = false;
  return {
    observe(sample, source) {
      if (captureFailed) return;
      try { capture(sample, source); } catch { captureFailed = true; }
    },
    finish,
    get pending() { return crops.length; },
  };
}
