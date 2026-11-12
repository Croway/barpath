/* Bar Path: the screens and the flow. Get a video (record or pick), mark the plate, track every frame,
 * analyse, show the replay and the charts. Everything runs on the device. */
import { PlateTracker, detectAt } from "./plate.js";
import { analyse, fmtSigned, fmtMetric, LIFTS } from "./analysis.js";
import * as V from "./video.js";
import * as Pose from "./pose.js";
import * as Rec from "./recorder.js";
import * as Ov from "./overlay.js";
import { Timeline } from "./trim.js";
import { initShare } from "./share.js";
import * as Store from "./store.js";
import { Gallery } from "./gallery.js";
import { Compare } from "./compare.js";
import { drawPath, drawSpeed, drawReps, pathHit, speedHit, fillTip, rampCss, span, where } from "./charts.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const video = $("video"), overlay = $("overlay"), viewer = $("viewer");

const S = {
  src: null, blob: null, name: "lift",
  W: 0, H: 0, duration: 0, fps: 30,
  plate: null, r0: null, start: 0, end: null,
  samples: null, R: null, cursor: null, facingOverride: null,
  mode: "start", abort: null, playing: false, rate: 0.25,
  cam: null, recorder: null, stopLevel: null, poseNote: "",
  file: null, filmed: 0, entryId: null, thumbFrame: null, // the gallery: the source file, when it was filmed, its saved id
};
window.__barpath = S; // for tests and debugging (the compare view: window.__barpathCompare)

/* ------------------------------------------------------------------ settings */
const KEEP = ["plateMm", "slowmo", "poseModel"];
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("barpath.settings") || "{}");
    for (const k of KEEP) if (s[k] != null && $(k).querySelector(`option[value="${CSS.escape(String(s[k]))}"]`)) $(k).value = s[k];
    $("heightCm").value = s.heightCm ? String(s.heightCm) : "";
  } catch { /* storage unavailable: defaults */ }
}
function saveSettings() {
  try { localStorage.setItem("barpath.settings", JSON.stringify({ ...Object.fromEntries(KEEP.map((k) => [k, $(k).value])), heightCm: heightCm() })); } catch { /* ignore */ }
}
const kg = () => { const v = parseFloat($("kg").value); return v > 0 && v <= 500 ? v : null; };
const heightCm = () => { const v = parseFloat($("heightCm").value); return v >= 100 && v <= 250 ? v : null; };
const opts = () => ({ plateMm: +$("plateMm").value, slowmo: +$("slowmo").value, facing: S.facingOverride ?? +$("facing").value, lift: $("liftSel").value, kg: kg(), heightCm: heightCm() });

/* ------------------------------------------------------------------ screens */
function setMode(m) {
  S.mode = m;
  $("start").hidden = m !== "start";
  $("gallery").hidden = m !== "gallery";
  $("compare").hidden = m !== "compare";
  if (m === "gallery" || m === "compare") stopPlayback();
  $("camera").hidden = m !== "camera";
  $("work").hidden = !["mark", "running", "results"].includes(m);
  $("mark").hidden = m !== "mark";
  $("running").hidden = m !== "running";
  $("results").hidden = m !== "results";
  $("hud").hidden = m !== "results";
  $("settings").hidden = ["camera", "running", "gallery", "compare"].includes(m);
  for (const id of ["btnPrev", "btnNext"]) $(id).disabled = m === "running";
  $("btnPreview").hidden = m !== "mark";
  stopPreview();
  TL.setMode(m === "mark" ? "trim" : m === "results" ? "scrub" : "off");
  if (m === "mark") TL.setHead(null);
  readout();
}

/* ------------------------------------------------------------------ frames → pixels */
const work = document.createElement("canvas");
work.width = work.height = 512;
const wctx = work.getContext("2d", { willReadFrequently: true });
function grab(src, sx, sy, sw, sh, w, h) {
  if (w > work.width || h > work.height) { work.width = Math.max(work.width, w); work.height = Math.max(work.height, h); }
  wctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return wctx.getImageData(0, 0, w, h);
}

/* ------------------------------------------------------------------ open a video */
/** saved: { card, data } from the gallery: the analysis comes back as it was, without tracking again */
async function openVideo(file, name, recorded, saved = null) {
  stopPlayback();
  if (S.src) URL.revokeObjectURL(S.src);
  Object.assign(S, { blob: recorded ? file : null, name, src: URL.createObjectURL(file), plate: null, samples: null, R: null, end: null, start: 0, cursor: null, facingOverride: null });
  Object.assign(S, { file, filmed: saved ? saved.card.filmed : file.lastModified || Date.now(), entryId: saved?.card.id ?? null, thumbFrame: null, runStats: null });
  if (!saved) { loadSettings(); $("liftSel").value = "auto"; $("facing").value = "0"; $("kg").value = ""; } // a new video starts from your defaults
  $("resSaved").textContent = "";
  $("btnDelete").hidden = true;
  $("btnSaveVideo").hidden = !recorded;
  $("sizeField").hidden = true;
  $("btnAnalyse").disabled = true;
  $("markInstr").replaceChildren(
    "Drag the handles under the video to the part with the lift: the start just before it, bar still. Then ",
    Object.assign(document.createElement("b"), { textContent: "tap the middle of the plate nearest the camera" }), ".");
  TL.setVideo(0, 30);
  setMode("mark");
  $("videoInfo").textContent = "Opening the video…";
  try {
    const info = await V.load(video, S.src);
    Object.assign(S, { W: info.W, H: info.H, duration: info.duration });
    Ov.fitViewer(viewer, S.W, S.H);
    S.fps = saved?.data.fps || (await V.probeFps(video)) || 30;
    await V.seek(video, saved ? saved.data.start : 0);
    TL.setVideo(S.duration, S.fps);
    TL.filmstrip(S.src);
    if (saved) return restore(saved.data);
    shown();
    videoInfo();
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = e.message || String(e);
  }
}
/** a saved lift: its part, plate, tracked frames and settings, then its results */
function restore(d) {
  const o = d.opts || {};
  for (const k of ["plateMm", "slowmo", "facing"]) if (o[k] !== undefined && $(k).querySelector(`option[value="${CSS.escape(String(o[k]))}"]`)) $(k).value = String(o[k]);
  $("liftSel").value = o.lift || "auto";
  $("kg").value = o.kg ? String(o.kg) : "";
  if (o.heightCm) $("heightCm").value = String(o.heightCm);
  Object.assign(S, { start: d.start, end: d.end ?? null, plate: { ...d.plate }, r0: d.plate.r, samples: d.samples, runStats: d.runStats || null, poseNote: d.poseNote || "", facingOverride: o.facingOverride ?? null });
  TL.setRange(S.start, endT());
  $("sizeField").hidden = false;
  $("btnAnalyse").disabled = false;
  videoInfo();
  showResults(true);
  $("resSaved").textContent = "From the gallery on this phone. Mark again to change the part or the plate.";
  $("btnDelete").hidden = false;
}
function videoInfo() {
  const parts = [`${S.W}×${S.H}`, `${Math.round(S.fps)} fps`, `${S.duration.toFixed(1)} s`];
  $("videoInfo").textContent = parts.join(" · ") + (S.fps >= 100 ? ". High frame rate: if it plays in real time, keep Video speed on Real time." : "");
}

/* ------------------------------------------------------------------ scrubbing and choosing the part */
let seekBusy = null, seekWant = null;
/** seek, coalescing a burst of requests (a drag) into the latest; resolves when the video has settled */
function seekTo(t) {
  seekWant = clamp(t, 0, S.duration || 0);
  seekBusy ??= (async () => {
    try { while (seekWant !== null) { const x = seekWant; seekWant = null; await V.seek(video, x); } } catch { /* a newer seek wins */ }
    seekBusy = null;
    shown();
  })();
  return seekBusy;
}
const endT = () => S.end ?? S.duration;
function shown(t = video.currentTime) {
  if (S.mode === "results") TL.setHead(clamp(t, S.start, endT()));
  readout(t);
  redrawOverlay(t);
}
/** under the timeline: the chosen part while choosing it, the position in the video otherwise */
function readout(t = video.currentTime) {
  $("timeRead").textContent = S.mode === "mark" && !preview
    ? `${S.start.toFixed(2)}–${endT().toFixed(2)} s · ${(endT() - S.start).toFixed(2)} s`
    : `${t.toFixed(2)} s`;
}
const onStart = (t) => Math.abs(t - S.start) < 0.5 / S.fps; // is the video showing the frame the analysis starts on?

const TL = new Timeline($("timeline"), {
  onInput(what, t) {
    stopPlayback();
    stopPreview();
    if (what === "in") S.start = t;
    if (what === "out") S.end = t >= S.duration - 1e-6 ? null : t;
    if (what === "head" && S.R) { S.cursor = S.R.indexAt(t); drawCharts(); }
    seekTo(t);
    readout();
  },
  async onCommit(what, t, nudged) {
    if (S.mode !== "mark") return;
    // the plate is marked on the start frame: let go of the end and the picture goes back there
    if (what === "out" && !nudged) await seekTo(S.start);
    if (what === "in") { await seekTo(S.start); refindPlate(); }
  },
});
$("btnPrev").addEventListener("click", () => { stopPlayback(); TL.step(-1); });
$("btnNext").addEventListener("click", () => { stopPlayback(); TL.step(1); });

/* play the chosen part, to check the whole lift is in it */
let preview = false;
async function startPreview() {
  stopPlayback();
  preview = true;
  $("btnPreview").textContent = "Stop";
  await seekTo(S.start);
  if (!preview) return;
  video.playbackRate = 1;
  const frame = (t) => {
    if (!preview) return false;
    if (t >= endT()) { stopPreview(); return false; }
    TL.setHead(t);
    readout(t);
    redrawOverlay(t);
    return true;
  };
  if (V.hasRVFC) { const cb = (now, m) => { if (frame(m.mediaTime)) video.requestVideoFrameCallback(cb); }; video.requestVideoFrameCallback(cb); }
  else { const loop = () => { if (frame(video.currentTime)) requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  video.addEventListener("ended", stopPreview, { once: true });
  video.play().catch(() => stopPreview());
}
function stopPreview() {
  if (!preview) return;
  preview = false;
  video.pause();
  $("btnPreview").textContent = "Play";
  TL.setHead(null);
  seekTo(S.start);
}
$("btnPreview").addEventListener("click", () => (preview ? stopPreview() : startPreview()));

/* ------------------------------------------------------------------ marking the plate */
/** the plate around (x, y) on the frame shown; found = its rim was seen, otherwise a guess the user sizes */
function findPlate(x, y) {
  const m = Math.min(S.W, S.H), side = 0.8 * m, k = 320 / side;
  const sx = clamp(x - side / 2, 0, S.W - side), sy = clamp(y - side / 2, 0, S.H - side);
  const d = detectAt(grab(video, sx, sy, side, side, 320, 320), (x - sx) * k, (y - sy) * k, 0.03 * m * k, 0.3 * m * k);
  const p = { x: sx + d.x / k, y: sy + d.y / k, r: d.r / k };
  return d.coverage >= 0.45 && Math.hypot(p.x - x, p.y - y) <= 0.9 * p.r ? { ...p, found: true } : { x, y, r: 0.07 * m, found: false };
}
/** the start moved after the plate was marked: find it again on the new start frame, near where it was */
function refindPlate() {
  if (!S.plate || S.mode !== "mark" || !onStart(video.currentTime)) return;
  const p = findPlate(S.plate.x, S.plate.y);
  if (p.found && Math.abs(p.r - S.plate.r) < 0.25 * S.plate.r) {
    S.plate = { x: p.x, y: p.y, r: p.r };
    S.r0 = p.r;
    $("plateSize").value = "100";
    $("markInstr").textContent = "Plate found again on the new start frame. Check the circle sits on its outer edge, then Analyse.";
  } else {
    $("markInstr").textContent = "New start frame: check the circle still sits on the plate. If it doesn't, tap the plate's middle.";
  }
  redrawOverlay();
}
overlay.addEventListener("pointerdown", (e) => {
  if (S.mode !== "mark" || !S.W || seekBusy || video.seeking) return;
  stopPreview();
  const t = video.currentTime;
  if (t > endT() - TL.minSpan + 1e-3) {
    $("markInstr").textContent = "This is the end of the part to analyse. Tap the plate on its first frame, shown now.";
    seekTo(S.start);
    return;
  }
  const rc = overlay.getBoundingClientRect();
  const p = findPlate(((e.clientX - rc.left) / rc.width) * S.W, ((e.clientY - rc.top) / rc.height) * S.H), found = p.found;
  S.plate = { x: p.x, y: p.y, r: p.r };
  S.r0 = S.plate.r;
  if (!onStart(t)) { S.start = t; TL.setRange(S.start, endT()); } // the analysis starts on the frame the plate is marked on
  $("plateSize").value = "100";
  $("sizeField").hidden = false;
  $("btnAnalyse").disabled = false;
  $("markInstr").textContent = found
    ? "Plate found. Check the circle sits on its outer edge, then Analyse."
    : "Couldn't find the plate's edge here. Tap its middle again, or size the circle to match it.";
  readout();
  redrawOverlay();
});
$("plateSize").addEventListener("input", () => { if (S.plate) { S.plate.r = (S.r0 * +$("plateSize").value) / 100; redrawOverlay(); } });

/* ------------------------------------------------------------------ tracking */
async function run() {
  if (!S.plate) return;
  stopPlayback();
  setMode("running");
  const ac = new AbortController();
  S.abort = ac;
  const progress = (p, text) => { $("progBar").style.width = `${(100 * clamp(p, 0, 1)).toFixed(1)}%`; $("prog").setAttribute("aria-valuenow", String(Math.round(100 * p))); $("progText").textContent = text; };
  const kind = $("poseModel").value;
  let P = null;
  S.poseNote = "";
  if (kind !== "off") {
    progress(0, "Loading body tracking…");
    try { P = await Pose.load(kind); } catch (e) { S.poseNote = `Body tracking couldn't load (${e?.message || e}), so this is the bar only.`; }
  }
  if (ac.signal.aborted) return setMode("mark");
  await V.seek(video, S.start);
  S.thumbFrame = snapshot();
  const tracker = new PlateTracker(S.plate.x, S.plate.y, S.plate.r, S.W, S.H);
  if (P) Pose.beginRun(S.start);
  const first = { t: S.start, x: S.plate.x, y: S.plate.y, r: S.plate.r, ok: true, conf: 1, pose: P ? Pose.detect(P, video, S.start, S.W, S.H) : null };
  const samples = [first];
  const end = S.end ?? S.duration;
  const began = performance.now();
  try {
    await V.runFrames(video, {
      start: S.start, end, fps: S.fps, signal: ac.signal,
      onFrame: (t) => {
        if (t <= samples[samples.length - 1].t + 1e-6) return;
        const roi = tracker.roi(t);
        const s = tracker.update(grab(video, roi.sx, roi.sy, roi.sw, roi.sh, roi.w, roi.h), roi, t);
        s.pose = P ? Pose.detect(P, video, t, S.W, S.H) : null;
        samples.push(s);
        Ov.draw(overlay, { W: S.W, H: S.H, plate: s, trail: samples.map((q) => ({ x: q.x, y: q.y, k: null })), pose: s.pose });
      },
      onProgress: (p) => progress(p, `Tracking the plate${P ? " and body" : ""}… ${samples.length} frames`),
    });
  } catch (e) {
    setMode("mark");
    if (e?.name !== "AbortError") $("markInstr").textContent = `Tracking stopped: ${e?.message || e}`;
    shown();
    return;
  }
  S.samples = samples;
  S.runStats = { frames: samples.length, seconds: (performance.now() - began) / 1000, pose: P ? `${P.kind} on ${P.delegate}` : "off" };
  showResults(true);
  if (S.mode === "results") saveLift(true);
}
$("btnAnalyse").addEventListener("click", run);
$("btnCancel").addEventListener("click", () => S.abort?.abort());
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "running" && video.paused) video.play().catch(() => {}); });

/* ------------------------------------------------------------------ results */
const STATUS = { good: ["✓", "Good"], warning: ["!", "Watch"], serious: ["!!", "Work on"] };
const FROM = { you: "set by you", body: "from the body", bar: "guessed from the bar", guess: "guessed" };
const RECOG = { you: "chosen by you", body: "recognised from the body", bar: "recognised from the bar only: check Lift" };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function showResults(fresh = false) {
  const R = analyse(S.samples, opts());
  if (R.error) {
    setMode("mark");
    $("markInstr").textContent = R.error;
    shown();
    return;
  }
  S.R = R;
  setMode("results");
  if (fresh || S.cursor === null || S.cursor >= R.n) S.cursor = R.t0i;

  $("resTitle").textContent = R.title;
  const st = S.runStats;
  $("resSub").textContent = [
    `${LIFTS[R.lift]} ${RECOG[R.liftFrom] || ""}${R.liftFrom !== "you" && R.liftWhy ? ` (${R.liftWhy})` : ""}`,
    `${R.lift === "bench" ? "head to the" : "faces"} ${R.facing > 0 ? "right" : "left"} (${FROM[R.facingFrom]})`,
    R.kg ? `${R.kg} kg` : null,
    R.slow > 1 ? `slowed ${R.slow}×` : null,
    st ? `${st.frames} frames in ${st.seconds.toFixed(0)} s, body tracking ${st.pose}` : null,
  ].filter(Boolean).join(" · ");

  // headline numbers
  const tiles = $("tiles");
  tiles.replaceChildren();
  const tile = (label, value, unit, note) => {
    const t = el("div", "tile");
    t.append(el("div", "label", label));
    const v = el("div", "value", value);
    v.append(el("small", null, unit));
    t.append(v, el("div", "note", note));
    tiles.append(t);
  };
  for (const t of R.tiles) tile(t.label, t.value, t.unit, t.note);

  $("kgHint").hidden = !!R.kg;
  const notes = $("notes");
  notes.replaceChildren(...[...R.notes, S.poseNote].filter(Boolean).map((n) => el("li", null, n)));

  // stage timing: one segmented bar (for a set: every rep's lowering, pause and lifting in turn)
  $("stageTitle").textContent = R.reps ? "Tempo" : "Stage timing";
  const bar = $("stageBar"), leg = $("stageLegend");
  bar.replaceChildren(); leg.replaceChildren();
  const total = R.stages.reduce((a, s) => a + s.dur, 0), named = new Set();
  for (const s of R.stages) {
    const b = el("div", "blk");
    b.style.flex = `${s.dur} 1 0`;
    b.style.background = `var(--s${s.slot})`;
    b.style.color = `var(--s${s.slot}-on)`;
    b.tabIndex = 0;
    b.setAttribute("role", "button");
    const desc = `${s.rep ? `Rep ${s.rep} · ` : ""}${s.name}: ${s.dur.toFixed(2)} s (${Math.round((100 * s.dur) / total)}%)`;
    b.setAttribute("aria-label", desc);
    b.title = desc;
    b.append(el("span", null, `${s.dur.toFixed(2)} s`));
    const go = () => setCursor(s.i0, true);
    b.addEventListener("click", go);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    bar.append(b);
    if (named.has(s.id)) continue; // the legend names each kind of stage once, in order
    named.add(s.id);
    const li = el("li");
    const sw = el("span", "sw");
    sw.style.background = `var(--s${s.slot})`;
    li.append(sw, document.createTextNode(s.name));
    leg.append(li);
  }

  // reps: mean lifting speed per rep, and every rep's numbers
  $("repsCard").hidden = !R.reps;
  if (R.reps) {
    const t = $("repsTable"), depth = R.reps.some((r) => r.depth !== undefined && r.depth !== null);
    t.replaceChildren();
    const head = el("tr");
    for (const h of ["Rep", "Range cm", "Mean m/s", "Peak m/s", ...(R.kg ? ["Power W"] : []), "Down s", "Up s", ...(depth ? ["Depth cm"] : [])]) head.append(el("th", null, h));
    t.append(head);
    for (const r of R.reps) {
      const tr = el("tr");
      tr.dataset.rep = r.n;
      const cells = [String(r.n), (r.rom * 100).toFixed(0), r.mean.toFixed(2), r.peak.toFixed(2), ...(R.kg ? [r.power === undefined ? "–" : r.power.toFixed(0)] : []), r.down.toFixed(2), r.up.toFixed(2)];
      if (depth) cells.push(r.depth === null || r.depth === undefined ? "–" : `${r.depth >= 0 ? "−" : "+"}${Math.abs(r.depth * 45).toFixed(0)}`);
      for (const c of cells) tr.append(el("td", null, c));
      tr.addEventListener("click", () => setCursor(r.begin, true));
      t.append(tr);
    }
    if (depth) { const tr = el("tr"), td = el("td", "n", "Depth: hip crease vs the knee, − below parallel (approx.)"); td.colSpan = 8; td.style.textAlign = "left"; tr.append(td); t.append(tr); }
  }
  requestAnimationFrame(() => { for (const b of bar.children) if (b.scrollWidth > b.clientWidth + 1) b.firstChild.textContent = ""; });

  // checks
  const ul = $("checks");
  ul.replaceChildren();
  for (const c of R.checks) {
    const li = el("li");
    const [icon, word] = STATUS[c.status];
    const ico = el("span", `ico ${c.status}`, icon);
    ico.setAttribute("aria-hidden", "true");
    const body = el("div");
    const ttl = el("div", "ttl", c.title);
    ttl.append(el("span", null, word));
    body.append(ttl, el("div", "txt", c.text));
    li.append(ico, body);
    ul.append(li);
  }

  // every measurement
  const table = $("table");
  table.replaceChildren();
  let group = null;
  for (const m of R.metrics) {
    if (m.group !== group) {
      group = m.group;
      const tr = el("tr"), th = el("th", null, group);
      th.colSpan = 2;
      tr.append(th);
      table.append(tr);
    }
    const tr = el("tr"), a = el("td", null, m.label);
    if (m.note) a.append(el("span", "n", m.note));
    tr.append(a, el("td", "v", `${fmtMetric(m)} ${m.unit}`));
    table.append(tr);
  }

  drawCharts();
  setCursor(S.cursor, true);
  if (!fresh) queueSave();
}

function drawCharts() {
  if (!S.R || S.mode !== "results") return;
  S.geoPath = drawPath($("pathChart"), S.R, S.cursor);
  S.geoSpeed = drawSpeed($("speedChart"), S.R, S.cursor);
  if (S.R.reps) {
    const cur = S.R.repOf[S.cursor] || null;
    S.geoReps = drawReps($("repsChart"), S.R, cur);
    for (const tr of $("repsTable").querySelectorAll("tr[data-rep]")) tr.classList.toggle("on", +tr.dataset.rep === cur);
  }
  $("rampKey").style.background = rampCss(S.geoPath.stops);
  $("rampMax").textContent = `${S.geoPath.vTop.toFixed(1)} m/s`;
}
function hud(i) {
  const R = S.R;
  $("hud").textContent = `${where(R, i)} · ${R.vy[i].toFixed(2)} m/s · ${R.H[i].toFixed(2)} m`;
}
function setCursor(i, seek) {
  if (!S.R) return;
  S.cursor = clamp(i, 0, S.R.n - 1);
  drawCharts();
  hud(S.cursor);
  if (seek) { stopPlayback(); seekTo(S.R.tVideo(S.cursor)); }
}

/* the replay overlay at video time t */
function nearestSample(t) {
  const a = S.samples;
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid; else hi = mid; }
  return Math.abs(a[lo].t - t) <= Math.abs(a[hi].t - t) ? a[lo] : a[hi];
}
function redrawOverlay(t = video.currentTime) {
  if (!S.W) return;
  if (S.mode === "results" && S.R) {
    const R = S.R, i = R.indexAt(t), [i0] = span(R), vTop = S.geoPath?.vTop || 2;
    const trail = [];
    for (let j = i0; j <= i; j++) trail.push({ x: R.xs[j], y: R.ys[j], k: R.speed[j] / vTop });
    const s = nearestSample(t);
    Ov.draw(overlay, { W: S.W, H: S.H, plate: { x: R.xs[i], y: R.ys[i], r: R.rs[i] }, trail, pose: s.pose, side: R.side });
    hud(i);
  } else if (S.mode === "mark") {
    Ov.draw(overlay, { W: S.W, H: S.H, plate: onStart(t) ? S.plate : null }); // the mark belongs to the start frame
  }
}

function bindChart(canvas, hit) {
  const tip = canvas.parentElement.querySelector(".tip");
  const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const show = (i, p) => {
    fillTip(tip, S.R, i);
    tip.hidden = false;
    const W = canvas.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${clamp(p.x + 14 + tw > W ? p.x - 14 - tw : p.x + 14, 0, W - tw)}px`;
    tip.style.top = `${clamp(p.y - 40, 0, canvas.clientHeight - tip.offsetHeight)}px`;
  };
  const move = (e) => { if (!S.R) return; const p = at(e), i = hit(p); setCursor(i, true); show(i, p); };
  canvas.addEventListener("pointerdown", move);
  canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) move(e); });
  canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
  canvas.addEventListener("pointercancel", () => { tip.hidden = true; });
  canvas.addEventListener("keydown", (e) => {
    if (!S.R || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    setCursor(S.cursor + (e.key === "ArrowRight" ? 1 : -1) * Math.max(1, Math.round(S.R.fs / 30)), true);
  });
}
bindChart($("pathChart"), (p) => pathHit(S.geoPath, S.R, p.x, p.y));
bindChart($("speedChart"), (p) => speedHit(S.geoSpeed, p.x));

/* replay */
function stopPlayback() { if (S.playing) { S.playing = false; video.pause(); } $("btnPlay").textContent = "Play"; }
async function play() {
  if (!S.R) return;
  const [i0, i1] = span(S.R), tEnd = S.R.tVideo(i1);
  if (video.currentTime >= tEnd - 0.02) await V.seek(video, S.R.tVideo(i0));
  video.playbackRate = S.rate;
  S.playing = true;
  $("btnPlay").textContent = "Pause";
  const frame = (t) => {
    if (!S.playing) return false;
    if (t >= tEnd) { stopPlayback(); return false; }
    S.cursor = S.R.indexAt(t);
    drawCharts();
    shown(t);
    return true;
  };
  if (V.hasRVFC) {
    const cb = (now, m) => { if (frame(m.mediaTime)) video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
  } else {
    const loop = () => { if (frame(video.currentTime)) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  video.play().catch(() => stopPlayback());
}
$("btnPlay").addEventListener("click", () => (S.playing ? stopPlayback() : play()));
video.addEventListener("pause", () => { if (S.mode === "results") { S.playing = false; $("btnPlay").textContent = "Play"; } });
for (const b of document.querySelectorAll("#rates button")) {
  b.addEventListener("click", () => {
    S.rate = +b.dataset.rate;
    for (const o of document.querySelectorAll("#rates button")) o.setAttribute("aria-pressed", String(o === b));
    if (S.playing) video.playbackRate = S.rate;
  });
}

/* result actions */
$("btnFlip").addEventListener("click", () => { S.facingOverride = -S.R.facing; showResults(); });
$("liftSel").addEventListener("change", () => { if (S.mode === "results") showResults(); });
let kgTimer = 0;
$("kg").addEventListener("input", () => { clearTimeout(kgTimer); kgTimer = setTimeout(() => { if (S.mode === "results") showResults(); }, 350); });
let heightTimer = 0;
$("heightCm").addEventListener("input", () => { clearTimeout(heightTimer); heightTimer = setTimeout(() => { saveSettings(); if (S.mode === "results") showResults(); }, 350); });
$("repsChart").addEventListener("pointerdown", (e) => {
  if (!S.geoReps) return;
  const x = e.clientX - $("repsChart").getBoundingClientRect().left;
  const c = S.geoReps.cols.find((k) => x >= k.x0 && x < k.x1);
  if (c) setCursor(c.rep.begin, true);
});
$("btnAgain").addEventListener("click", () => { stopPlayback(); setMode("mark"); TL.setRange(S.start, endT()); seekTo(S.start); });
for (const id of ["btnNew", "btnNew2"]) $(id).addEventListener("click", () => { stopPlayback(); setMode("start"); galleryCount(); });

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
$("btnCsv").addEventListener("click", () => {
  const R = S.R, rows = [`time_s,forward_cm,height_m,vx_m_s,vy_m_s,speed_m_s,${R.P ? "power_w,force_n," : ""}rep,stage,filled_in`];
  for (let i = 0; i < R.n; i++) {
    const k = R.stageOf[i];
    rows.push([(R.T[i] - R.T[R.t0i]).toFixed(4), (R.X[i] * 100).toFixed(2), R.H[i].toFixed(4), R.vx[i].toFixed(3), R.vy[i].toFixed(3), R.speed[i].toFixed(3), ...(R.P ? [R.P[i].toFixed(1), R.F[i].toFixed(1)] : []), R.repOf?.[i] || "", k >= 0 ? R.stages[k].name : "", R.gap[i]].join(","));
  }
  download(new Blob([rows.join("\n")], { type: "text/csv" }), `${S.name}-bar.csv`);
});
$("btnJson").addEventListener("click", () => {
  const R = S.R, t = (i) => (i === null || i === undefined ? null : +(R.T[i] - R.T[R.t0i]).toFixed(4));
  const out = {
    app: "Bar Path", video: { name: S.name, width: S.W, height: S.H, fps: +S.fps.toFixed(2) }, settings: opts(),
    lift: R.lift, title: R.title, recognised: R.liftFrom, facing: R.facing > 0 ? "right" : "left", heights: R.axis.h,
    reps: R.reps ? R.reps.map((r) => ({ rep: r.n, start_s: t(r.begin), range_cm: +(r.rom * 100).toFixed(1), mean_m_s: +r.mean.toFixed(3), peak_m_s: +r.peak.toFixed(3),
      lowering_s: +r.down.toFixed(3), pause_s: +r.pause.toFixed(3), lifting_s: +r.up.toFixed(3), ...(r.power !== undefined ? { mean_lifting_power_w: +r.power.toFixed(1) } : {}), ...(r.depth != null ? { depth_thigh_lengths: +r.depth.toFixed(3) } : {}) })) : undefined,
    events_s: Object.fromEntries(Object.entries(R.ev).map(([k, i]) => [k, t(i)])),
    stages: R.stages.map((s) => ({ ...(s.rep ? { rep: s.rep } : {}), name: s.name, start_s: t(s.i0), seconds: +s.dur.toFixed(3) })),
    measurements: R.metrics.map((m) => ({ ...m, value: +m.value.toFixed(4) })), checks: R.checks,
  };
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), `${S.name}-analysis.json`);
});
$("btnSaveVideo").addEventListener("click", () => { if (S.blob) download(S.blob, `${S.name}.${S.blob.type.includes("mp4") ? "mp4" : "webm"}`); });

/* ------------------------------------------------------------------ the gallery: analysed lifts kept on this phone */
/** the frame the analysis starts on, small, for the gallery's thumbnail */
function snapshot() {
  const k = Math.min(1, 720 / Math.max(S.W, S.H)), c = document.createElement("canvas");
  c.width = Math.round(S.W * k); c.height = Math.round(S.H * k);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return c;
}
/** a 3:4 crop of the start frame around the bar's path, with the path drawn on it */
function thumbnail(R) {
  const f = S.thumbFrame;
  if (!f) return Promise.resolve(null);
  const [i0, i1] = R.span, pad = 1.5 * R.rpx;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = i0; i <= i1; i++) { x0 = Math.min(x0, R.xs[i]); x1 = Math.max(x1, R.xs[i]); y0 = Math.min(y0, R.ys[i]); y1 = Math.max(y1, R.ys[i]); }
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < 0.75) { x0 -= (0.75 * h - w) / 2; w = 0.75 * h; } else { y0 -= (w / 0.75 - h) / 2; h = w / 0.75; }
  const fit = Math.min(1, S.W / w, S.H / h);
  x0 += (w - w * fit) / 2; y0 += (h - h * fit) / 2; w *= fit; h *= fit;
  x0 = clamp(x0, 0, S.W - w); y0 = clamp(y0, 0, S.H - h);
  const c = document.createElement("canvas"), g = c.getContext("2d"), k = f.width / S.W;
  c.width = 150; c.height = 200;
  g.drawImage(f, x0 * k, y0 * k, w * k, h * k, 0, 0, c.width, c.height);
  const s = c.width / w, path = () => { g.beginPath(); for (let i = i0; i <= i1; i++) g[i === i0 ? "moveTo" : "lineTo"]((R.xs[i] - x0) * s, (R.ys[i] - y0) * s); };
  g.lineJoin = g.lineCap = "round";
  g.lineWidth = 5; g.strokeStyle = "rgba(0,0,0,0.55)"; path(); g.stroke(); // on footage: the overlay's halo and blue
  g.lineWidth = 2.5; g.strokeStyle = "#3987e5"; path(); g.stroke();
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
}
const liftOpts = () => ({ plateMm: +$("plateMm").value, slowmo: +$("slowmo").value, facing: +$("facing").value, facingOverride: S.facingOverride, lift: $("liftSel").value, kg: kg(), heightCm: heightCm() });
/** keep this analysis: fresh = just tracked (a new lift, or a lift analysed again); otherwise its settings changed */
async function saveLift(fresh) {
  if (!S.R || !S.samples || !Store.available() || (!fresh && !S.entryId)) return;
  const R = S.R, id = S.entryId ?? Store.newId(), isNew = !S.entryId;
  const card = { id, filmed: S.filmed, saved: Date.now(), name: S.name, title: R.title, lift: R.lift, kg: kg(), tiles: R.tiles.slice(0, 2).map(({ label, value, unit }) => ({ label, value, unit })) };
  const data = { samples: S.samples, plate: S.plate, start: S.start, end: S.end, fps: S.fps, opts: liftOpts(), runStats: S.runStats, poseNote: S.poseNote };
  try {
    if (fresh) {
      card.thumb = await thumbnail(R);
      await Store.put(card, data, isNew ? S.file : null);
      S.entryId = id;
      galleryCount();
    } else await Store.update(id, card, { opts: data.opts });
    $("resSaved").textContent = "Saved in the gallery, on this phone.";
    $("btnDelete").hidden = false;
  } catch (e) {
    $("resSaved").textContent = `Couldn't keep it in the gallery (${e?.message || e}).`;
  }
}
let saveTimer = 0;
const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveLift(false), 400); };

const GAL = new Gallery(
  { list: $("galList"), filters: $("galFilters"), summary: $("galSummary"), empty: $("galEmpty"), bar: $("galBar"), barText: $("galBarText"), compare: $("btnGalCompare"), remove: $("btnGalDelete") },
  { open: (id) => openSaved(id), compare: (ids) => openCompare(ids) },
);
const CMP = (window.__barpathCompare = new Compare({
  videos: $("cmpVideos"), legend: $("cmpLegend"), scrub: $("cmpScrub"), read: $("cmpRead"), play: $("cmpPlay"), prev: $("cmpPrev"), next: $("cmpNext"),
  rates: $("cmpRates"), path: $("cmpPath"), speed: $("cmpSpeed"), table: $("cmpTable"), note: $("cmpNote"),
}));
async function galleryCount() {
  const n = await GAL.count();
  $("btnGallery").hidden = n === 0;
  $("btnGallery").textContent = `Gallery · ${n}`;
}

/* screens you can go back from with the phone's Back: each gets a history entry, and the one it was opened from
 * is remembered on the entry before it */
function push(screen) {
  history.replaceState({ ...history.state, screen: history.state?.screen ?? S.mode }, "");
  history.pushState({ screen }, "");
}
async function showGallery(fromHistory = false) {
  if (!fromHistory && S.mode !== "gallery") push("gallery");
  if (S.mode === "compare") CMP.close();
  setMode("gallery");
  await GAL.refresh();
}
async function openSaved(id) {
  const got = await Store.get(id).catch(() => null);
  if (!got) { GAL.refresh(); return; }
  push("lift");
  const type = got.video.type || "video/mp4";
  await openVideo(new File([got.video], got.card.name, { type }), got.card.name, false, got);
}
async function openCompare(ids) {
  const items = (await Promise.all(ids.map((id) => Store.get(id).catch(() => null)))).filter(Boolean);
  if (items.length < 2) return;
  push("compare");
  setMode("compare");
  await CMP.open(items);
}
window.addEventListener("popstate", (e) => {
  const to = e.state?.screen ?? "start";
  if (S.mode === "running") S.abort?.abort();
  if (S.mode === "compare" && to !== "compare") CMP.close();
  if (to === "gallery") return showGallery(true);
  if ((to === "results" || to === "lift") && S.R) { setMode("results"); drawCharts(); return seekTo(video.currentTime); }
  if (to === "mark" && S.src) { setMode("mark"); return seekTo(S.start); }
  stopPlayback();
  setMode("start");
  galleryCount();
});
for (const id of ["btnGallery", "btnGallery2"]) $(id).addEventListener("click", () => showGallery());
for (const id of ["btnGalBack", "btnCmpBack"]) $(id).addEventListener("click", () => history.back());
$("btnDelete").addEventListener("click", async () => {
  if (!S.entryId || !confirm("Delete this lift from Bar Path's gallery? A video in your phone's Gallery app isn't affected.")) return;
  await Store.remove(S.entryId).catch(() => {});
  S.entryId = null;
  $("btnDelete").hidden = true;
  $("resSaved").textContent = "Deleted from the gallery.";
  galleryCount();
});

/* ------------------------------------------------------------------ getting a video */
$("fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name.replace(/\.\w+$/, ""), false); });
$("captureInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name ? f.name.replace(/\.\w+$/, "") : stamp(), false); });
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `lift-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

// Record hands over to the camera app: browsers get the camera at 30 fps at most (a Galaxy S23 gives web pages
// 30, its camera app 60), and speeds need the frames. The in-app camera, with its level, stays one tap away.
$("btnRecord").addEventListener("click", () => $("captureInput").click());
$("btnCamLevel").addEventListener("click", () => openCam());
async function openCam() {
  setMode("camera");
  $("camInfo").textContent = "Opening the camera…";
  try {
    S.cam = await Rec.openCamera($("camVideo"));
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = `Couldn't open the camera here (${e?.message || e}). Record opens the camera app instead.`;
    return;
  }
  const cv = $("camVideo"), st = S.cam.settings;
  Ov.fitViewer($("camViewer"), cv.videoWidth || st.width || 16, cv.videoHeight || st.height || 9);
  const fps = st.frameRate ? Math.round(st.frameRate) : null;
  $("camInfo").textContent = `${cv.videoWidth}×${cv.videoHeight}${fps ? ` at ${fps} fps` : ""}.` +
    (fps && fps < 50 ? " The browser gives 30 fps here; for 60 fps, use Record (the camera app)." : " Side-on, whole lift and floor in frame.");
  let seen = false;
  S.stopLevel = Rec.watchLevel(({ roll, pitch }) => {
    seen = true;
    const ok = Math.abs(roll) < 1.5 && Math.abs(pitch) < 6;
    $("level").dataset.ok = ok ? "1" : "0";
    $("level").querySelector(".bubble").style.transform = `rotate(${(-roll).toFixed(1)}deg)`;
    $("levelRead").textContent = ok ? "Level ✓" : `Tilt ${fmtSigned(roll, 1)}° · ${pitch > 0 ? "up" : "down"} ${Math.abs(pitch).toFixed(0)}°`;
  });
  setTimeout(() => { if (!seen) $("levelRead").textContent = "Level: no motion sensor"; }, 1500);
}
function closeCam() {
  S.stopLevel?.(); S.stopLevel = null;
  Rec.closeCamera($("camVideo"), S.cam?.stream);
  S.cam = null; S.recorder = null;
  clearInterval(S.recTimer);
  $("recBadge").hidden = true;
  const b = $("btnRecToggle");
  b.dataset.on = "0"; b.textContent = "Start recording";
}
$("btnRecToggle").addEventListener("click", async () => {
  const b = $("btnRecToggle");
  if (!S.recorder) {
    S.recorder = Rec.startRecording(S.cam.stream);
    b.dataset.on = "1"; b.textContent = "Stop";
    const t0 = performance.now();
    $("recBadge").hidden = false;
    S.recTimer = setInterval(() => { $("recTime").textContent = ((performance.now() - t0) / 1000).toFixed(1); }, 100);
  } else {
    b.disabled = true;
    const blob = await S.recorder.stop();
    b.disabled = false;
    closeCam();
    openVideo(blob, stamp(), true);
  }
});
$("btnCamClose").addEventListener("click", () => { closeCam(); setMode("start"); });

/* ------------------------------------------------------------------ settings changes */
for (const id of ["plateMm", "slowmo"]) $(id).addEventListener("change", () => { saveSettings(); if (S.mode === "results") showResults(); });
$("facing").addEventListener("change", () => { S.facingOverride = null; if (S.mode === "results") showResults(); });
$("poseModel").addEventListener("change", () => { saveSettings(); if (S.mode === "results") $("notes").append(el("li", null, "Body tracking changes apply the next time you analyse (Mark again → Analyse).")); });

/* ------------------------------------------------------------------ redraw on resize / theme */
let rz = 0;
const redraw = () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { drawCharts(); redrawOverlay(); }); };
window.addEventListener("resize", redraw);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
new ResizeObserver(redraw).observe(viewer);

/* ------------------------------------------------------------------ installable app (PWA) */
const standalone = matchMedia("(display-mode: standalone)").matches;
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* still works online without it */ });
  navigator.storage?.persist?.().catch(() => {});
}
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("btnInstall").hidden = false; });
window.addEventListener("appinstalled", () => { installPrompt = null; $("btnInstall").hidden = true; });
$("btnInstall").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $("btnInstall").hidden = true;
});
$("shareHint").hidden = !standalone;
// an iPhone never offers Install: say how to add it to the home screen instead
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
$("installHint").hidden = !iOS || standalone || navigator.standalone === true;
initShare({ dialog: $("shareDlg"), open: $("btnShareApp"), qr: $("shareQr"), link: $("shareLink"), note: $("shareNote"), send: $("btnShareSend"), copy: $("btnShareCopy"), close: $("btnShareClose") });

/** a video shared to the app (manifest share_target): the service worker keeps it, the app opens it */
async function takeShared() {
  if (!new URLSearchParams(location.search).has("shared")) return false;
  history.replaceState(null, "", location.pathname);
  try {
    const c = await caches.open("barpath-share"), res = await c.match("shared-video");
    if (!res) return false;
    await c.delete("shared-video");
    const blob = await res.blob(), name = decodeURIComponent(res.headers.get("X-File-Name") || "shared-video");
    openVideo(new File([blob], name, { type: blob.type || "video/mp4" }), name.replace(/\.\w+$/, ""), false);
    return true;
  } catch { return false; }
}

loadSettings();
$("btnCamLevel").hidden = !Rec.canRecordInApp();
setMode("start");
galleryCount();
takeShared();
