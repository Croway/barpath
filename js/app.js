/* Bar Path: the screens and the flow. Get a video (record or pick), mark the plate, track every frame,
 * analyse, show the replay and the charts. Everything runs on the device. */
import { PlateTracker, detectAt } from "./plate.js";
import { analyse, fmtSigned, fmtMetric, fmtPlain, LIFTS } from "./analysis.js";
import * as V from "./video.js";
import * as Pose from "./pose.js";
import * as Rec from "./recorder.js";
import * as Ov from "./overlay.js";
import { Timeline } from "./trim.js";
import { initShare } from "./share.js";
import * as Store from "./store.js";
import { Gallery, mb } from "./gallery.js";
import { Compare } from "./compare.js";
import { drawPath, drawSpeed, drawReps, pathHit, speedHit, fillTip, rampCss, span, where, scrub } from "./charts.js";
import { tr, num, rich, applyDom, setLang, pickLang, getLang, LANGS } from "./i18n.js";
import en from "../locales/en.js";

const $ = (id) => document.getElementById(id);

/* the language first: everything below may show text (the timeline labels its handles as it's built) */
const LANG_KEY = "barpath.lang";
let savedLang = null;
try { savedLang = localStorage.getItem(LANG_KEY); } catch { /* storage unavailable: the phone's language */ }
await setLang(pickLang(savedLang));
applyDom();
{
  const sel = $("langSel");
  sel.replaceChildren(...Object.entries(LANGS).map(([code, name]) => Object.assign(document.createElement("option"), { value: code, textContent: name })));
  sel.value = getLang();
  $("langField").hidden = Object.keys(LANGS).length < 2;
  sel.addEventListener("change", () => { try { localStorage.setItem(LANG_KEY, sel.value); } catch { /* ignore */ } location.reload(); });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const video = $("video"), overlay = $("overlay"), viewer = $("viewer");

const S = {
  src: null, blob: null, name: "lift",
  W: 0, H: 0, duration: 0, fps: 30,
  plate: null, r0: null, start: 0, end: null,
  samples: null, R: null, cursor: null, facingOverride: null,
  mode: "start", abort: null, playing: false, rate: 0.25,
  cam: null, recorder: null, stopLevel: null, poseNote: "",
  file: null, filmed: 0, entryId: null, firstSave: null, thumbFrame: null, videoVersion: 0,
};
window.__barpath = S; // for tests and debugging (the compare view: window.__barpathCompare)

/* ------------------------------------------------------------------ settings */
const KEEP = ["plateMm", "slowmo", "poseModel"];
function readSettings() {
  try { return JSON.parse(localStorage.getItem("barpath.settings") || "{}") || {}; } catch { return {}; }
}
function loadSettings() {
  const s = readSettings();
  for (const k of KEEP) if (s[k] != null && $(k).querySelector(`option[value="${CSS.escape(String(s[k]))}"]`)) $(k).value = s[k];
  $("heightCm").value = s.heightCm ?? "";
}
function saveSettings({ saveHeight = false } = {}) {
  const settings = { ...readSettings(), ...Object.fromEntries(KEEP.map((k) => [k, $(k).value])) };
  if (saveHeight) settings.heightCm = heightCm();
  try { localStorage.setItem("barpath.settings", JSON.stringify(settings)); } catch { /* ignore */ }
}
const kg = () => { const v = parseFloat($("kg").value); return v > 0 && v <= 500 ? v : null; };
const heightCm = () => { const v = parseFloat($("heightCm").value); return v >= 100 && v <= 250 ? v : null; };
const liftOpts = () => ({ plateMm: +$("plateMm").value, slowmo: +$("slowmo").value, facing: +$("facing").value, facingOverride: S.facingOverride, lift: $("liftSel").value, kg: kg(), heightCm: heightCm() });

/* ------------------------------------------------------------------ screens */
function setMode(m) {
  if (S.mode === "results" && m !== "results") flushSave();
  if (S.mode === "camera" && m !== "camera") closeCam();
  S.mode = m;
  document.body.dataset.mode = m; // the app's header shows on the start screen only
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
  flushSave();
  stopPlayback();
  if (S.src) URL.revokeObjectURL(S.src);
  Object.assign(S, { blob: recorded ? file : null, name, src: URL.createObjectURL(file), plate: null, samples: null, R: null, end: null, start: 0, cursor: null, facingOverride: null });
  Object.assign(S, { file, filmed: saved ? saved.card.filmed : file.lastModified || Date.now(), entryId: saved?.card.id ?? null, firstSave: null, thumbFrame: null, runStats: null, videoVersion: saved?.data.videoVersion ?? 0 });
  if (!saved) { loadSettings(); $("liftSel").value = "auto"; $("facing").value = "0"; $("kg").value = ""; } // a new video starts from your defaults
  $("resSaved").textContent = "";
  $("btnDelete").hidden = true;
  hideTrim();
  $("btnSaveVideo").hidden = !recorded;
  $("sizeField").hidden = true;
  $("btnAnalyse").disabled = true;
  rich($("markInstr"), tr("mark.instr"));
  TL.setVideo(0, 30);
  setMode("mark");
  $("videoInfo").textContent = tr("mark.opening");
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
  $("heightCm").value = o.heightCm ?? "";
  Object.assign(S, { start: d.start, end: d.end ?? null, plate: { ...d.plate }, r0: d.plate.r, samples: d.samples, runStats: d.runStats || null, poseNote: d.poseNote || "", facingOverride: o.facingOverride ?? null });
  TL.setRange(S.start, endT());
  $("sizeField").hidden = false;
  $("btnAnalyse").disabled = false;
  videoInfo();
  showResults(true);
  $("resSaved").textContent = tr("res.saved.fromGallery");
  $("btnDelete").hidden = false;
  updateTrim();
}
function videoInfo() {
  $("videoInfo").textContent = tr(S.fps >= 100 ? "mark.videoInfoHighFps" : "mark.videoInfo", { w: S.W, h: S.H, fps: Math.round(S.fps), s: num(S.duration, 1) });
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
    ? `${num(S.start, 2)}–${num(endT(), 2)} s · ${num(endT() - S.start, 2)} s`
    : `${num(t, 2)} s`;
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
  $("btnPreview").textContent = tr("common.stop");
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
  $("btnPreview").textContent = tr("common.play");
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
    $("markInstr").textContent = tr("mark.refound");
  } else {
    $("markInstr").textContent = tr("mark.refindFailed");
  }
  redrawOverlay();
}
overlay.addEventListener("pointerdown", (e) => {
  if (S.mode !== "mark" || !S.W || seekBusy || video.seeking) return;
  stopPreview();
  const t = video.currentTime;
  if (t > endT() - TL.minSpan + 1e-3) {
    $("markInstr").textContent = tr("mark.atEnd");
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
  $("markInstr").textContent = tr(found ? "mark.found" : "mark.notFound");
  readout();
  redrawOverlay();
});
$("plateSize").addEventListener("input", () => { if (S.plate) { S.plate.r = (S.r0 * +$("plateSize").value) / 100; redrawOverlay(); } });

/* ------------------------------------------------------------------ tracking */
async function run() {
  if (!S.plate) return;
  stopPlayback();
  setMode("running");
  $("btnCancel").textContent = tr("common.cancel");
  const ac = new AbortController();
  S.abort = ac;
  const progress = (p, text) => { $("progBar").style.width = `${(100 * clamp(p, 0, 1)).toFixed(1)}%`; $("prog").setAttribute("aria-valuenow", String(Math.round(100 * p))); $("progText").textContent = text; };
  const kind = $("poseModel").value;
  let P = null;
  S.poseNote = "";
  if (kind !== "off") {
    progress(0, tr("run.loadingPose"));
    try { P = await Pose.load(kind); } catch (e) { S.poseNote = tr("run.poseFailed", { error: e?.message || e }); }
  }
  if (ac.signal.aborted) return setMode("mark");
  await V.seek(video, S.start);
  S.thumbFrame = snapshot();
  const tracker = new PlateTracker(S.plate.x, S.plate.y, S.plate.r, S.W, S.H);
  if (P) Pose.beginRun(S.start);
  const first = { t: S.start, x: S.plate.x, y: S.plate.y, r: S.plate.r, ok: true, conf: 1, pose: P ? Pose.detect(P, video, S.start, S.W, S.H) : null };
  const recovery = P?.kind === "full" ? Pose.recovery(P, S.W, S.H, +$("slowmo").value || 1) : null;
  recovery?.observe(first, video);
  const samples = [first];
  const end = S.end ?? S.duration;
  const began = performance.now();
  const resumeVideo = () => { if (!document.hidden && video.paused && !ac.signal.aborted) video.play().catch(() => {}); };
  document.addEventListener("visibilitychange", resumeVideo);
  try {
    await V.runFrames(video, {
      start: S.start, end, fps: S.fps, signal: ac.signal,
      onFrame: (t) => {
        if (t <= samples[samples.length - 1].t + 1e-6) return;
        const roi = tracker.roi(t);
        const s = tracker.update(grab(video, roi.sx, roi.sy, roi.sw, roi.sh, roi.w, roi.h), roi, t);
        s.pose = P ? Pose.detect(P, video, t, S.W, S.H) : null;
        recovery?.observe(s, video);
        samples.push(s);
        Ov.draw(overlay, { W: S.W, H: S.H, plate: s, trail: samples.map((q) => ({ x: q.x, y: q.y, k: null })), pose: s.pose });
      },
      onProgress: (p) => progress(p, tr(P ? "run.trackingBody" : "run.tracking", { n: samples.length })),
    });
  } catch (e) {
    setMode("mark");
    if (e?.name !== "AbortError") $("markInstr").textContent = tr("mark.trackingStopped", { error: e?.message || e });
    shown();
    return;
  } finally { document.removeEventListener("visibilitychange", resumeVideo); }
  if (recovery?.pending) {
    $("btnCancel").textContent = tr("run.skipRecovery");
    const update = p => progress(p, tr("run.recoveringBody"));
    update(0);
    try { await recovery.finish(ac.signal, update); } catch { /* the primary track is complete */ }
  }
  if (S.abort !== ac || S.mode !== "running") return;
  S.samples = samples;
  S.runStats = { frames: samples.length, seconds: (performance.now() - began) / 1000, pose: P ? `${P.kind} on ${P.delegate}` : "off" };
  if (P) {
    S.runStats.bodyFrames = samples.filter(s => s.pose).length;
    S.runStats.recoveredFrames = samples.filter(s => s.recoveredLeg).length;
  }
  showResults(true);
  if (S.mode === "results") saveLift(true);
}
$("btnAnalyse").addEventListener("click", run);
$("btnCancel").addEventListener("click", () => S.abort?.abort());

/* ------------------------------------------------------------------ results */
const SVG = "http://www.w3.org/2000/svg";
/** an icon from the sprite in index.html (#i-<name>), hidden from screen readers: the text next to it says it */
function icon(name, cls = "") {
  const s = document.createElementNS(SVG, "svg"), u = document.createElementNS(SVG, "use");
  s.setAttribute("class", `i ${cls}`.trim());
  s.setAttribute("aria-hidden", "true");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}
/** a value and its unit: no space before ° and % */
const withUnit = (v, unit) => (!unit ? v : /^[°%]/.test(unit) ? `${v}${unit}` : `${v} ${unit}`);
/** how the tracking went: frames, seconds, body tracking (saved as "off" or "<model> on <device>") */
function runInfo(st) {
  const vars = { n: st.frames, s: num(st.seconds, 0) }, on = /^(\S+) on (\S+)$/.exec(st.pose);
  if (st.pose === "off") return tr("res.runInfo.off", vars);
  const model = on ? tr("res.runInfo.on", { ...vars, model: on[1], device: on[2] }) : tr("res.runInfo.other", { ...vars, pose: String(st.pose) });
  const info = [model];
  if (st.bodyFrames !== undefined) info.push(tr("res.runInfo.coverage", { body: st.bodyFrames, total: st.frames }));
  if (st.recoveredFrames) info.push(tr("res.runInfo.recovered", { n: st.recoveredFrames }));
  return info.join(" ");
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
/** a note above the results: a warning tint and icon */
const note = (text) => { const li = el("li"); li.append(icon("warning", "ico warning"), el("span", null, text)); return li; };

function showResults(fresh = false) {
  const R = analyse(S.samples, liftOpts());
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
  // how the lift was recognised (res.liftFrom.<you|body|bar>) and which way the lifter faces (res.facingFrom.<…>)
  const how = tr(`res.liftFrom.${R.liftFrom}`);
  $("resSub").textContent = [
    R.liftFrom !== "you" && R.liftWhy ? tr("res.sub.liftWhy", { lift: LIFTS[R.lift], how, why: R.liftWhy }) : tr("res.sub.lift", { lift: LIFTS[R.lift], how }),
    tr(`res.sub.${R.lift === "bench" ? "head" : "faces"}.${R.facing > 0 ? "right" : "left"}`, { how: tr(`res.facingFrom.${R.facingFrom}`) }),
    R.kg ? `${fmtPlain(R.kg)} kg` : null,
    R.slow > 1 ? tr("res.sub.slowed", { n: R.slow }) : null,
  ].filter(Boolean).join(" · ");
  $("runInfo").textContent = st ? runInfo(st) : "";

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
  notes.replaceChildren(...[...R.notes, S.poseNote].filter(Boolean).map(note));

  // stage timing: one segmented bar (for a set: every rep's lowering, pause and lifting in turn)
  $("stageTitle").textContent = tr(R.reps ? "res.stages.tempo" : "res.stages.title");
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
    const desc = tr(s.rep ? "res.stage.descRep" : "res.stage.desc", { rep: s.rep, name: s.name, s: num(s.dur, 2), pct: Math.round((100 * s.dur) / total) });
    b.setAttribute("aria-label", desc);
    b.title = desc;
    b.append(el("span", null, `${num(s.dur, 2)} s`));
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
    const t = $("repsTable"), depth = R.lift === "squat" && R.side;
    t.replaceChildren();
    const head = el("tr");
    for (const [h, u] of [["rep"], ["range", "cm"], ["mean", "m/s"], ["peak", "m/s"], ...(R.kg ? [["power", "W"]] : []), ["down", "s"], ["up", "s"], ...(depth ? [["depth", "cm"]] : [])]) {
      const th = el("th", null, tr(`res.reps.col.${h}`));
      if (u) th.append(el("span", "u", u));
      head.append(th);
    }
    t.append(head);
    for (const r of R.reps) {
      const row = el("tr");
      row.dataset.rep = r.n;
      const cells = [String(r.n), num(r.rom * 100, 0), num(r.mean, 2), num(r.peak, 2), ...(R.kg ? [r.power === undefined ? "–" : num(r.power, 0)] : []), num(r.down, 2), num(r.up, 2)];
      if (depth) cells.push(r.depth === null || r.depth === undefined ? "–" : `${r.depth >= 0 ? "−" : "+"}${num(Math.abs(r.depth * 45), 0)}`);
      const go = el("button", "go", cells.shift()); // the row is tappable; the button gives it a keyboard way in
      go.type = "button";
      go.setAttribute("aria-label", tr("res.reps.jump", { n: r.n }));
      const first = el("td");
      first.append(go);
      row.append(first);
      for (const c of cells) row.append(el("td", null, c));
      row.addEventListener("click", () => setCursor(r.begin, true));
      t.append(row);
    }
    if (depth) { const row = el("tr"), td = el("td", "n", tr("res.reps.depthNote")); td.colSpan = head.children.length; td.style.textAlign = "left"; row.append(td); t.append(row); }
  }
  requestAnimationFrame(() => { for (const b of bar.children) if (b.scrollWidth > b.clientWidth + 1) b.firstChild.textContent = ""; });

  // checks
  const ul = $("checks");
  ul.replaceChildren();
  for (const c of R.checks) {
    const li = el("li");
    const word = tr(`status.${c.status}`);
    const ico = icon(c.status === "info" ? "dot" : c.status, `ico ${c.status}`);
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
      const row = el("tr"), th = el("th", null, group);
      th.colSpan = 2;
      row.append(th);
      table.append(row);
    }
    const row = el("tr"), a = el("td", null, m.label);
    if (m.note) a.append(el("span", "n", m.note));
    row.append(a, el("td", "v", withUnit(fmtMetric(m), m.unit)));
    table.append(row);
  }

  drawCharts();
  setCursor(S.cursor, true);
  if (!fresh) saveLift(false);
}

function drawCharts() {
  if (!S.R || S.mode !== "results") return;
  S.geoPath = drawPath($("pathChart"), S.R, S.cursor);
  S.geoSpeed = drawSpeed($("speedChart"), S.R, S.cursor);
  if (S.R.reps) {
    const cur = S.R.repOf[S.cursor] || null;
    S.geoReps = drawReps($("repsChart"), S.R, cur);
    for (const row of $("repsTable").querySelectorAll("tr[data-rep]")) row.classList.toggle("on", +row.dataset.rep === cur);
  }
  $("rampKey").style.background = rampCss(S.geoPath.stops);
  $("rampMax").textContent = `${num(S.geoPath.vTop, 1)} m/s`;
}
function hud(i) {
  const R = S.R;
  $("hud").textContent = `${where(R, i)} · ${num(R.vy[i], 2)} m/s · ${num(R.H[i], 2)} m`;
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
    Ov.draw(overlay, { W: S.W, H: S.H, plate: { x: R.xs[i], y: R.ys[i], r: R.rs[i] }, trail, pose: s.pose, recoveredLeg: s.recoveredLeg, side: R.side });
    hud(i);
  } else if (S.mode === "mark") {
    Ov.draw(overlay, { W: S.W, H: S.H, plate: onStart(t) ? S.plate : null }); // the mark belongs to the start frame
  }
}

function bindChart(canvas, hit) {
  const tip = canvas.parentElement.querySelector(".tip");
  const show = (i, p) => {
    fillTip(tip, S.R, i);
    tip.hidden = false;
    const W = canvas.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${clamp(p.x + 14 + tw > W ? p.x - 14 - tw : p.x + 14, 0, W - tw)}px`;
    tip.style.top = `${clamp(p.y - 40, 0, canvas.clientHeight - tip.offsetHeight)}px`;
  };
  scrub(canvas, (p) => { if (!S.R) return; const i = hit(p); setCursor(i, true); show(i, p); }, { hover: true });
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
function stopPlayback() { if (S.playing) { S.playing = false; video.pause(); } $("btnPlay").textContent = tr("common.play"); }
async function play() {
  if (!S.R) return;
  const [i0, i1] = span(S.R), tEnd = S.R.tVideo(i1);
  if (video.currentTime >= tEnd - 0.02) await V.seek(video, S.R.tVideo(i0));
  video.playbackRate = S.rate;
  S.playing = true;
  $("btnPlay").textContent = tr("common.pause");
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
video.addEventListener("pause", () => { if (S.mode === "results") { S.playing = false; $("btnPlay").textContent = tr("common.play"); } });
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
let inputTimer = 0, heightEdited = false;
function applyInputEdits() {
  clearTimeout(inputTimer);
  inputTimer = 0;
  if (heightEdited) saveSettings({ saveHeight: true });
  heightEdited = false;
  if (S.mode === "results") showResults();
}
function queueInputEdit() {
  clearTimeout(inputTimer);
  inputTimer = setTimeout(applyInputEdits, 350);
}
$("kg").addEventListener("input", queueInputEdit);
$("heightCm").addEventListener("input", () => { heightEdited = true; queueInputEdit(); });
$("repsChart").addEventListener("click", (e) => { // a tap: a scroll that starts on the chart doesn't jump
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
// the CSV is data: its stage column stays English (and free of commas) whatever language the app shows
$("btnCsv").addEventListener("click", () => {
  const R = S.R, rows = [`time_s,forward_cm,height_m,vx_m_s,vy_m_s,speed_m_s,${R.P ? "power_w,force_n," : ""}rep,stage,filled_in`];
  for (let i = 0; i < R.n; i++) {
    const k = R.stageOf[i];
    rows.push([(R.T[i] - R.T[R.t0i]).toFixed(4), (R.X[i] * 100).toFixed(2), R.H[i].toFixed(4), R.vx[i].toFixed(3), R.vy[i].toFixed(3), R.speed[i].toFixed(3), ...(R.P ? [R.P[i].toFixed(1), R.F[i].toFixed(1)] : []), R.repOf?.[i] || "", k >= 0 ? en[`stage.${R.stages[k].id}`] : "", R.gap[i]].join(","));
  }
  download(new Blob([rows.join("\n")], { type: "text/csv" }), `${S.name}-bar.csv`);
});
$("btnJson").addEventListener("click", () => {
  const R = S.R, t = (i) => (i === null || i === undefined ? null : +(R.T[i] - R.T[R.t0i]).toFixed(4));
  const { facingOverride, ...settings } = liftOpts();
  settings.facing = facingOverride ?? settings.facing;
  const out = {
    app: "Bar Path", video: { name: S.name, width: S.W, height: S.H, fps: +S.fps.toFixed(2) }, settings,
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
function thumbnail(R, { thumbFrame: f, W, H }) {
  if (!f) return Promise.resolve(null);
  const [i0, i1] = R.span, pad = 1.5 * R.rpx;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = i0; i <= i1; i++) { x0 = Math.min(x0, R.xs[i]); x1 = Math.max(x1, R.xs[i]); y0 = Math.min(y0, R.ys[i]); y1 = Math.max(y1, R.ys[i]); }
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < 0.75) { x0 -= (0.75 * h - w) / 2; w = 0.75 * h; } else { y0 -= (w / 0.75 - h) / 2; h = w / 0.75; }
  const fit = Math.min(1, W / w, H / h);
  x0 += (w - w * fit) / 2; y0 += (h - h * fit) / 2; w *= fit; h *= fit;
  x0 = clamp(x0, 0, W - w); y0 = clamp(y0, 0, H - h);
  const c = document.createElement("canvas"), g = c.getContext("2d"), k = f.width / W;
  c.width = 150; c.height = 200;
  g.drawImage(f, x0 * k, y0 * k, w * k, h * k, 0, 0, c.width, c.height);
  const s = c.width / w, path = () => { g.beginPath(); for (let i = i0; i <= i1; i++) g[i === i0 ? "moveTo" : "lineTo"]((R.xs[i] - x0) * s, (R.ys[i] - y0) * s); };
  g.lineJoin = g.lineCap = "round";
  g.lineWidth = 5; g.strokeStyle = "rgba(0,0,0,0.55)"; path(); g.stroke(); // on footage: the overlay's halo and blue
  g.lineWidth = 2.5; g.strokeStyle = "#3987e5"; path(); g.stroke();
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
}
let savingLift = Promise.resolve();
/** keep this analysis: fresh = just tracked (a new lift, or a lift analysed again); otherwise its settings changed */
function saveLift(fresh) {
  if (!S.R || !S.samples || !Store.available()) return;
  const first = S.firstSave, isNew = fresh && !S.entryId && !first;
  const id = S.entryId ?? first?.id ?? (isNew ? Store.newId() : null);
  if (!id) return;
  const { R, src, thumbFrame, W, H } = S, file = isNew ? S.file : null;
  const card = { id, filmed: S.filmed, saved: Date.now(), name: S.name, title: R.title, lift: R.lift, kg: kg(), tiles: R.tiles.slice(0, 2).map(({ label, value, unit }) => ({ label, value, unit })) };
  const data = { samples: S.samples, plate: { ...S.plate }, start: S.start, end: S.end, fps: S.fps, opts: liftOpts(), runStats: S.runStats, poseNote: S.poseNote, videoVersion: S.videoVersion };
  const isCurrent = () => S.src === src && (S.entryId ?? S.firstSave?.id) === id;
  savingLift = savingLift.then(async () => {
    try {
      if (first && !(await first.done)) return false;
      if (fresh) {
        card.thumb = await thumbnail(R, { thumbFrame, W, H });
        await Store.put(card, data, file);
        galleryCount();
        if (isCurrent()) {
          S.entryId = id;
          S.firstSave = null;
          updateTrim();
        }
      } else {
        await Store.update(id, card, { opts: data.opts });
      }
      if (isCurrent()) {
        $("resSaved").textContent = tr("res.saved.ok");
        $("btnDelete").hidden = false;
      }
      return true;
    } catch (e) {
      if (isCurrent()) {
        if (isNew) S.firstSave = null;
        $("resSaved").textContent = tr("res.saved.failed", { error: e?.message || e });
      }
      return false;
    }
  });
  if (isNew) S.firstSave = { id, done: savingLift };
}

/** commit any pending input before leaving results or reading the stored analysis for trimming */
function flushSave() {
  if (inputTimer) applyInputEdits();
  return savingLift;
}

const GAL = new Gallery(
  { list: $("galList"), filters: $("galFilters"), summary: $("galSummary"), status: $("galStatus"), empty: $("galEmpty"), bar: $("galBar"), barText: $("galBarText"), compare: $("btnGalCompare"), remove: $("btnGalDelete"), trim: $("btnGalTrim") },
  { open: (id) => openSaved(id), compare: (ids) => openCompare(ids) },
);
const CMP = (window.__barpathCompare = new Compare({
  videos: $("cmpVideos"), legend: $("cmpLegend"), scrub: $("cmpScrub"), read: $("cmpRead"), play: $("cmpPlay"), prev: $("cmpPrev"), next: $("cmpNext"),
  rates: $("cmpRates"), path: $("cmpPath"), speed: $("cmpSpeed"), table: $("cmpTable"), note: $("cmpNote"),
}));
let howtoSet = false;
async function galleryCount() {
  const n = await GAL.count();
  $("btnGallery").hidden = n === 0;
  $("btnGallery").textContent = tr("start.galleryCount", { n });
  // the filming guide: open on the first visit, folded away once there are lifts (Record comes first then)
  if (!howtoSet) { howtoSet = true; $("howto").open = n === 0; }
}

/* screens you can go back from with the phone's Back: each gets a history entry, and the one it was opened from
 * is remembered on the entry before it */
let historyVersion = 0;
function push(screen, state = {}) {
  const previous = { ...history.state, screen: history.state?.screen ?? S.mode };
  if (S.mode === "results") {
    previous.screen = "results";
    previous.id = S.entryId ?? S.firstSave?.id ?? null;
    previous.pendingSource = S.entryId ? null : S.src;
  }
  history.replaceState(previous, "");
  history.pushState({ screen, ...state }, "");
  historyVersion++;
}
async function showGallery(fromHistory = false) {
  if (!fromHistory && S.mode !== "gallery") push("gallery");
  if (S.mode === "compare") CMP.close();
  setMode("gallery");
  await savingLift;
  if (S.mode === "gallery") await GAL.refresh();
}
async function openSaved(id, fromHistory = false) {
  const version = historyVersion;
  await flushSave();
  const got = await Store.get(id).catch(() => null);
  if (historyVersion !== version || (!fromHistory && S.mode !== "gallery")) return;
  if (!got) return showGallery(true);
  if (!fromHistory) push("lift", { id });
  const type = got.video.type || "video/mp4";
  await openVideo(new File([got.video], got.card.name, { type }), got.card.name, false, got);
}
async function openCompare(ids, fromHistory = false) {
  const version = historyVersion;
  await flushSave();
  const items = (await Promise.all(ids.map((id) => Store.get(id).catch(() => null)))).filter(Boolean);
  if (historyVersion !== version || (!fromHistory && S.mode !== "gallery")) return;
  if (items.length < 2) return showGallery(true);
  if (!fromHistory) push("compare", { ids });
  setMode("compare");
  const opening = historyVersion;
  const opened = await CMP.open(items).catch(() => false);
  if (!opened && S.mode === "compare" && historyVersion === opening) await showGallery(true);
}
window.addEventListener("popstate", (e) => {
  historyVersion++;
  const to = e.state?.screen ?? "start";
  if (S.mode === "running") S.abort?.abort();
  if (S.mode === "compare" && to !== "compare") CMP.close();
  if (to === "gallery") return showGallery(true);
  if (to === "compare" && e.state.ids) return openCompare(e.state.ids, true);
  if (to === "results" || to === "lift") {
    const id = e.state.id;
    const current = S.entryId ?? S.firstSave?.id;
    const pending = !current && e.state.pendingSource === S.src;
    if (id && (!S.R || (id !== current && !pending))) return openSaved(id, true);
    if (S.R) { setMode("results"); drawCharts(); return seekTo(video.currentTime); }
  }
  if (to === "mark" && S.src) { setMode("mark"); return seekTo(S.start); }
  stopPlayback();
  setMode("start");
  galleryCount();
});
for (const id of ["btnGallery", "btnGallery2"]) $(id).addEventListener("click", () => showGallery());
for (const id of ["btnGalBack", "btnCmpBack"]) $(id).addEventListener("click", () => history.back());
$("btnDelete").addEventListener("click", async () => {
  if (!S.entryId || !confirm(tr("res.deleteConfirm"))) return;
  await Store.remove(S.entryId).catch(() => {});
  S.entryId = null;
  $("btnDelete").hidden = true;
  hideTrim();
  $("resSaved").textContent = tr("res.saved.deleted");
  galleryCount();
});

/* keeping only the analysed part of the saved video (js/clip.js, store.js): offered when it frees at least 5% */
let trimPlan = null;
function hideTrim() { trimPlan = null; $("trimRow").hidden = true; }
async function updateTrim() {
  hideTrim();
  const id = S.entryId;
  if (!id) return;
  try {
    const p = await Store.planTrim(id);
    if (!p || p.card.trimmed || S.entryId !== id || p.r.after > 0.95 * p.r.before) return;
    trimPlan = p;
    $("trimInfo").textContent = tr("res.trim.info", { before: mb(p.r.before), after: mb(p.r.after) });
    $("btnTrim").disabled = false;
    $("trimRow").hidden = false;
  } catch { /* not an MP4 (a WebM recording), or no video track: nothing to offer */ }
}
$("btnTrim").addEventListener("click", async () => {
  const p = trimPlan, src = S.src;
  if (!p || p.card.id !== S.entryId) return;
  const ask = tr("res.trim.confirm", { before: mb(p.r.before), after: mb(p.r.after) }) + (S.blob ? `\n\n${tr("res.trim.confirmRecorded")}` : "");
  if (!confirm(ask)) return;
  $("btnTrim").disabled = true;
  try {
    await flushSave(); // settings changed a moment ago go with it
    await Store.applyTrim(p);
    const got = await Store.get(p.card.id);
    if (S.src !== src || S.mode !== "results") {
      if (S.entryId === p.card.id && S.videoVersion === (p.data.videoVersion ?? 0)) {
        S.entryId = null;
        $("btnDelete").hidden = true;
        $("resSaved").textContent = "";
        hideTrim();
      }
      return;
    }
    // open it again on the shorter video (its times moved with it); no new history entry
    await openVideo(new File([got.video], got.card.name, { type: got.video.type || "video/mp4" }), got.card.name, false, got);
    $("resSaved").textContent = tr("res.trim.done", { size: mb(p.r.after) });
    galleryCount();
  } catch (e) {
    if (S.src !== src) return;
    $("trimInfo").textContent = tr("res.trim.failed", { err: e?.message || e });
    $("btnTrim").disabled = false;
  }
});

/* ------------------------------------------------------------------ getting a video */
$("fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name.replace(/\.\w+$/, ""), false); });
$("captureInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name ? f.name.replace(/\.\w+$/, "") : stamp(), false); });
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `lift-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

// Record hands over to the camera app: browsers get the camera at 30 fps at most (a Galaxy S23 gives web pages
// 30, its camera app 60), and speeds need the frames. The in-app camera, with its level, stays one tap away.
$("btnRecord").addEventListener("click", () => $("captureInput").click());
$("btnCamLevel").addEventListener("click", () => openCam());
let cameraOpening = null;
async function openCam() {
  const opening = new AbortController();
  cameraOpening = opening;
  const cv = $("camVideo");
  $("btnRecToggle").disabled = true;
  setMode("camera");
  $("camInfo").textContent = tr("camera.opening");
  let camera;
  try {
    camera = await Rec.openCamera(cv, opening.signal);
  } catch (e) {
    if (opening.signal.aborted) return;
    setMode("start");
    $("recordHint").textContent = tr("camera.failed", { error: e?.message || e });
    return;
  }
  if (opening.signal.aborted) return;
  S.cam = camera;
  $("btnRecToggle").disabled = false;
  const st = camera.settings;
  Ov.fitViewer($("camViewer"), cv.videoWidth || st.width || 16, cv.videoHeight || st.height || 9);
  const fps = st.frameRate ? Math.round(st.frameRate) : null;
  $("camInfo").textContent = `${tr(fps ? "camera.infoFps" : "camera.info", { w: cv.videoWidth, h: cv.videoHeight, fps })} ${tr(fps && fps < 50 ? "camera.info.slow" : "camera.info.ok")}`;
  let seen = false;
  S.stopLevel = Rec.watchLevel(({ roll, pitch }) => {
    seen = true;
    const ok = Math.abs(roll) < 1.5 && Math.abs(pitch) < 6;
    $("level").dataset.ok = ok ? "1" : "0";
    $("level").querySelector(".bubble").style.transform = `rotate(${(-roll).toFixed(1)}deg)`;
    $("levelRead").textContent = ok ? tr("camera.level.ok") : tr(pitch > 0 ? "camera.level.up" : "camera.level.down", { roll: fmtSigned(roll, 1), pitch: num(Math.abs(pitch), 0) });
  });
  setTimeout(() => { if (!seen && !opening.signal.aborted) $("levelRead").textContent = tr("camera.level.noSensor"); }, 1500);
}
function closeCam() {
  cameraOpening?.abort();
  cameraOpening = null;
  S.stopLevel?.(); S.stopLevel = null;
  Rec.closeCamera($("camVideo"));
  S.cam = null; S.recorder = null;
  clearInterval(S.recTimer);
  $("recBadge").hidden = true;
  const b = $("btnRecToggle");
  b.disabled = true;
  b.dataset.on = "0"; b.textContent = tr("camera.start");
}
$("btnRecToggle").addEventListener("click", async () => {
  const b = $("btnRecToggle");
  if (!S.recorder) {
    S.recorder = Rec.startRecording(S.cam.stream);
    b.dataset.on = "1"; b.textContent = tr("common.stop");
    const t0 = performance.now();
    $("recBadge").hidden = false;
    S.recTimer = setInterval(() => { $("recTime").textContent = num((performance.now() - t0) / 1000, 1); }, 100);
  } else {
    b.disabled = true;
    const recorder = S.recorder;
    const blob = await recorder.stop();
    if (S.recorder !== recorder) return;
    openVideo(blob, stamp(), true);
  }
});
$("btnCamClose").addEventListener("click", () => setMode("start"));

/* ------------------------------------------------------------------ settings changes */
for (const id of ["plateMm", "slowmo"]) $(id).addEventListener("change", () => { saveSettings(); if (S.mode === "results") showResults(); });
$("facing").addEventListener("change", () => { S.facingOverride = null; if (S.mode === "results") showResults(); });
$("poseModel").addEventListener("change", () => { saveSettings(); if (S.mode === "results") $("notes").append(note(tr("res.poseChanged"))); });

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
