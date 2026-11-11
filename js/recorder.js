/* Recording inside the app: rear camera, 1080p, 60 fps when the phone allows, with a spirit level.
 * Browsers only give pages the camera over HTTPS (or localhost); elsewhere the app hands over to the
 * phone's camera app instead (an <input capture> file picker). */

export const canRecordInApp = () =>
  !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

export async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  });
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  const track = stream.getVideoTracks()[0];
  return { stream, track, settings: track.getSettings?.() || {} };
}

export function closeCamera(video, stream) {
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

function pickType() {
  const types = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

export function startRecording(stream) {
  const type = pickType();
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 16_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(500);
  return {
    stop: () => new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: (rec.mimeType || type || "video/webm").split(";")[0] }));
      rec.stop();
    }),
  };
}

/**
 * Spirit level from the accelerometer: roll = how far the picture is rotated, pitch = how far the camera
 * points up or down. Calls onLevel({roll, pitch}) in degrees. Returns a function that stops it.
 */
export function watchLevel(onLevel) {
  const handler = (e) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null) return;
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    let roll = (Math.atan2(g.x, g.y) * 180) / Math.PI - angle;
    roll = ((roll + 540) % 360) - 180;
    const pitch = (Math.atan2(g.z, Math.hypot(g.x, g.y)) * 180) / Math.PI;
    onLevel({ roll, pitch });
  };
  window.addEventListener("devicemotion", handler);
  return () => window.removeEventListener("devicemotion", handler);
}
