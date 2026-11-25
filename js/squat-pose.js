// RTMPose-m Body7. Only seek and process the frames around a squat's bar reversals.
import { median } from "./analysis.js";

const assets = new URL("../vendor/rtmpose-m-384-ort-1.31.1/", import.meta.url).href;
const width = 288, height = 384;

// Fit a single athlete crop to the observed plate travel. Percentiles discard occasional
// jumps of the plate tracker; margins are in plate radii, independent of video resolution.
function athleteCrop(samples, W, H, scale, diameter) {
  const plate = samples.filter(s => s.ok && s.r > 0);
  if (plate.length < 3) return null;
  const r = median(plate.map(s => s.r)) * 0.45 / diameter;
  const bounds = key => {
    const a = plate.map(s => s[key]).sort((x, y) => x - y);
    const at = q => {
      const i = (a.length - 1) * q, low = Math.floor(i);
      return a[low] + (a[Math.ceil(i)] - a[low]) * (i - low);
    };
    return [at(0.01), at(0.99)];
  };
  const [left, right] = bounds("x"), [top, bottom] = bounds("y");
  const px = value => Math.floor(value * scale);
  const x = Math.max(0, px(left - 2.45 * r)), y = Math.max(0, px(top - 1.95 * r));
  return { x, y, w: Math.min(W, px(right + 2.45 * r)) - x, h: Math.min(H, px(bottom + 3.45 * r)) - y };
}

async function detector() {
  const ort = await import(assets + "ort.webgpu.min.mjs");
  ort.env.logLevel = "error";
  ort.env.wasm.wasmPaths = assets;
  ort.env.wasm.numThreads = 1;
  const url = assets + "model.onnx";
  let session;
  if (navigator.gpu) {
    try { session = await ort.InferenceSession.create(url, { executionProviders: ["webgpu"] }); }
    catch { /* browsers without a usable GPU can still run the short pass on WASM */ }
  }
  session ??= await ort.InferenceSession.create(url, { executionProviders: ["wasm"] });
  return { ort, session };
}

function simccPeak(output, joint) {
  const size = output.dims[2], start = joint * size, data = output.data;
  let best = start;
  for (let i = start + 1; i < start + size; i++) if (data[i] > data[best]) best = i;
  return { pixel: (best - start) / 2, score: data[best] };
}

function readLegs({ ort, session }, crop, frame, frameScale) {
  const source = frame.getContext("2d");
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const scale = Math.min(width / crop.w, height / crop.h);
  const w = Math.max(1, Math.round(crop.w * scale)), h = Math.max(1, Math.round(crop.h * scale));
  const dx = Math.floor((width - w) / 2), dy = Math.floor((height - h) / 2);
  const pixels = width * height, input = new Float32Array(3 * pixels);
  return async video => {
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, width, height);
    source.drawImage(video, 0, 0, frame.width, frame.height);
    ctx.drawImage(frame, crop.x, crop.y, crop.w, crop.h, dx, dy, w, h);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < pixels; i++) {
      input[i] = (rgba[i * 4] - 123.675) / 58.395;
      input[i + pixels] = (rgba[i * 4 + 1] - 116.28) / 57.12;
      input[i + 2 * pixels] = (rgba[i * 4 + 2] - 103.53) / 57.375;
    }
    const tensor = new ort.Tensor("float32", input, [1, 3, height, width]);
    let outputs;
    try {
      outputs = await session.run({ [session.inputNames[0]]: tensor });
      const joint = j => {
        const x = simccPeak(outputs[session.outputNames[0]], j), y = simccPeak(outputs[session.outputNames[1]], j);
        return { x: (crop.x + (x.pixel - dx) * crop.w / w) / frameScale, y: (crop.y + (y.pixel - dy) * crop.h / h) * video.videoHeight / frame.height, v: Math.min(x.score, y.score) };
      };
      return { l: { hip: joint(11), knee: joint(13), ankle: joint(15) }, r: { hip: joint(12), knee: joint(14), ankle: joint(16) } };
    } finally {
      tensor.dispose();
      for (const value of Object.values(outputs || {})) value.dispose();
    }
  };
}

// A paused seek may display the previous frame briefly. Only record the decoder's actual PTS.
function seekFrame(video, t, tolerance, signal) {
  return new Promise(resolve => {
    let handle;
    const finish = pts => {
      clearTimeout(timer);
      video.cancelVideoFrameCallback(handle);
      signal.removeEventListener("abort", cancel);
      resolve(pts);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, 1500);
    const frame = (_, m) => {
      if (Math.abs(m.mediaTime - t) <= tolerance) finish(m.mediaTime);
      else handle = video.requestVideoFrameCallback(frame);
    };
    handle = video.requestVideoFrameCallback(frame);
    signal.addEventListener("abort", cancel, { once: true });
    video.currentTime = Math.min(video.duration, t + Math.min(0.001, tolerance / 2));
  });
}

export async function refineSquat(video, samples, R, fps, signal, progress) {
  if (R.lift !== "squat" || !R.reps?.length || !video.requestVideoFrameCallback || signal.aborted) return 0;
  // Downsample the displayed frame before the final crop, using the same filtering
  // for full-resolution phone videos as for the validated 540-pixel reference frames.
  const frame = document.createElement("canvas");
  const ratio = Math.min(1, 540 / Math.min(video.videoWidth, video.videoHeight));
  frame.width = Math.round(video.videoWidth * ratio);
  frame.height = Math.round(video.videoHeight * ratio);
  const frameScale = frame.width / video.videoWidth;
  const cropFor = rows => athleteCrop(rows, frame.width, frame.height, frameScale, R.plate);
  const crop = cropFor(samples);
  if (!crop || crop.w <= 0 || crop.h <= 0) return 0;
  const half = Math.max(0.09, 2 / R.fs) * R.slow;
  const windows = R.reps.map(rep => {
    const center = R.tVideo(rep.p), rows = samples.filter(s => Math.abs(s.t - center) <= half);
    // Slow motion can supply many almost identical observations. Keep both sides of the turn.
    const tracked = rows.length <= 13 ? rows : Array.from({ length: 13 }, (_, i) => rows[Math.round(i * (rows.length - 1) / 12)]);
    const start = R.tVideo(rep.begin), end = R.tVideo(rep.end);
    const local = cropFor(samples.filter(s => s.t >= start && s.t <= end));
    // Keep a steady crop between reps unless a walkout or a moving camera
    // enlarged the full-set crop substantially beyond this rep's plate travel.
    const useLocal = local && local.w > 0 && local.h > 0 && (crop.w > 1.25 * local.w || crop.h > 1.25 * local.h);
    return { rows: tracked, region: useLocal ? local : crop };
  }).filter(w => w.rows.length >= 3);
  const total = windows.reduce((n, w) => n + w.rows.length, 0);
  if (!total) return 0;
  let model, finished = false, timer, stop;
  const stopped = new Promise(resolve => { stop = () => resolve(null); });
  signal.addEventListener("abort", stop, { once: true });
  let count = 0, done = 0;
  try {
    timer = setTimeout(stop, 90000);
    model = await Promise.race([stopped, detector().then(async value => {
      if (!finished) return value;
      await value.session.release();
      return null;
    })]);
    clearTimeout(timer);
    if (!model || signal.aborted) return 0;
    progress(0);
    for (const { rows, region } of windows) {
      const detect = readLegs(model, region, frame, frameScale);
      const batch = [];
      for (const s of rows) {
        if (signal.aborted) return count;
        const pts = await seekFrame(video, s.t, 0.5 / fps, signal);
        if (pts !== null && (!batch.length || pts > batch.at(-1).pts + 1e-5)) {
          batch.push({ s, pts, legs: await detect(video) });
        }
        progress(++done / total);
      }
      if (signal.aborted) return count;
      if (batch.length >= 3 && batch.length >= rows.length * 0.75) {
        for (const { s, pts, legs } of batch) s.depthLegs = { ...legs, offset: pts - s.t };
        count += batch.length;
      }
    }
    return count;
  } finally {
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (model) await model.session.release();
  }
}
