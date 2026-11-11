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
          return (cache[kind] = { lm, delegate, kind, local: src.base === LOCAL });
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
