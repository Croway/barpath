/* Getting frames out of a video in order, each with its real timestamp.
 *
 * The video plays slowly and requestVideoFrameCallback hands over each frame as it's shown, with its
 * media time. If processing falls behind, the browser skips frames; the timestamps stay true, the
 * playback rate drops so it catches up, and the analysis works on whatever frames it got.
 * Phones record variable frame rate in low light, so per-frame timestamps matter.
 */
export const hasRVFC = typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
const MIN_RATE = 0.0625;

export function once(el, name, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { el.removeEventListener(name, on); reject(new Error(`Timed out waiting for ${name}`)); }, ms);
    const on = (e) => { clearTimeout(t); resolve(e); };
    el.addEventListener(name, on, { once: true });
  });
}

/** load a video, including MediaRecorder WebM, whose duration is unknown until it has been read to the end */
export async function load(video, src) {
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await new Promise((resolve, reject) => {
    const done = (fn, arg) => () => { clearTimeout(timer); video.removeEventListener("loadedmetadata", ok); video.removeEventListener("error", bad); fn(arg); };
    const ok = done(resolve);
    const bad = done(reject, new Error("This video can't be played here. Try an MP4 from the phone's camera app."));
    const timer = setTimeout(done(reject, new Error("The video took too long to open.")), 20000);
    video.addEventListener("loadedmetadata", ok);
    video.addEventListener("error", bad);
    video.src = src;
  });
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e7;
    for (let i = 0; i < 50 && !Number.isFinite(video.duration); i++) await new Promise((r) => setTimeout(r, 50));
    await seek(video, 0);
  }
  if (video.readyState < 2) await once(video, "loadeddata", 20000);
  return { W: video.videoWidth, H: video.videoHeight, duration: video.duration };
}

export async function seek(video, t) {
  t = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : t, t));
  if (Math.abs(video.currentTime - t) < 1e-4 && !video.seeking) return;
  const done = once(video, "seeked", 8000);
  video.currentTime = t;
  await done;
}

/** frames per second of the file, from the gaps between frames played slowly (null if it can't tell) */
export async function probeFps(video) {
  if (!hasRVFC) return null;
  const t0 = video.currentTime, times = [];
  video.playbackRate = 0.25;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; video.pause(); resolve(); } };
    const cb = (now, m) => { times.push(m.mediaTime); if (times.length >= 16) finish(); else if (!done) video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
    video.addEventListener("ended", finish, { once: true });
    setTimeout(finish, 4000);
    video.play().catch(finish);
  });
  video.playbackRate = 1;
  await seek(video, t0);
  const d = [];
  for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 1e-4) d.push(x); }
  if (d.length < 4) return null;
  d.sort((a, b) => a - b);
  return 1 / d[Math.floor(d.length * 0.25)];
}

/**
 * Calls onFrame(t) for each frame from `start` to `end` (media time, seconds) while the frame is the video's
 * current image, so onFrame can draw it. Resolves when done; rejects with AbortError if `signal` aborts.
 */
export async function runFrames(video, { start, end, fps, onFrame, onProgress, signal }) {
  await seek(video, start);
  if (!hasRVFC) return stepFrames(video, { start, end, fps, onFrame, onProgress, signal });
  const fd = 1 / fps, maxRate = Math.min(1, 24 / fps);
  let rate = maxRate, last = null, calm = 0;
  video.playbackRate = rate;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      video.pause();
      video.playbackRate = 1;
      video.removeEventListener("ended", onEnded);
      err ? reject(err) : resolve();
    };
    const onEnded = () => finish();
    video.addEventListener("ended", onEnded);
    const cb = (now, meta) => {
      if (finished) return;
      if (signal?.aborted) return finish(new DOMException("Cancelled", "AbortError"));
      const t = meta.mediaTime;
      if (t > end + fd / 2) return finish();
      try { onFrame(t); } catch (e) { return finish(e); }
      if (last !== null) {
        if ((t - last) / fd > 1.5) { rate = Math.max(MIN_RATE, rate * 0.8); calm = 0; video.playbackRate = rate; }
        else if (++calm > 20 && rate < maxRate) { rate = Math.min(maxRate, rate * 1.1); calm = 0; video.playbackRate = rate; }
      }
      last = t;
      onProgress?.((t - start) / Math.max(1e-3, end - start));
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    video.play().catch((e) => finish(e));
  });
}

/** fallback without requestVideoFrameCallback: seek frame by frame (slower, same result) */
async function stepFrames(video, { start, end, fps, onFrame, onProgress, signal }) {
  const fd = 1 / fps;
  for (let t = start; t <= end + 1e-6; t += fd) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    await seek(video, t);
    onFrame(video.currentTime);
    onProgress?.((t - start) / Math.max(1e-3, end - start));
  }
}
