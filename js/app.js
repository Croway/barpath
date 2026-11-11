/* Bar Path: the screens and the flow. Get a video (record or pick), mark the plate, track every frame,
 * analyse, show the replay and the charts. Everything runs on the device. */
import { PlateTracker, detectAt } from "./plate.js";
import { analyse, fmtSigned, LIFTS } from "./analysis.js";
import * as V from "./video.js";
import * as Pose from "./pose.js";
import * as Rec from "./recorder.js";
import * as Ov from "./overlay.js";
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
};
window.__barpath = S; // for tests and debugging

/* ------------------------------------------------------------------ settings */
const KEEP = ["plateMm", "slowmo", "poseModel"];
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("barpath.settings") || "{}");
    for (const k of KEEP) if (s[k] != null && $(k).querySelector(`option[value="${CSS.escape(String(s[k]))}"]`)) $(k).value = s[k];
  } catch { /* storage unavailable: defaults */ }
}
function saveSettings() {
  try { localStorage.setItem("barpath.settings", JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, $(k).value])))); } catch { /* ignore */ }
}
const opts = () => ({ plateMm: +$("plateMm").value, slowmo: +$("slowmo").value, facing: S.facingOverride ?? +$("facing").value, lift: $("liftSel").value });

/* ------------------------------------------------------------------ screens */
function setMode(m) {
  S.mode = m;
  $("start").hidden = m !== "start";
  $("camera").hidden = m !== "camera";
  $("work").hidden = !["mark", "running", "results"].includes(m);
  $("mark").hidden = m !== "mark";
  $("running").hidden = m !== "running";
  $("results").hidden = m !== "results";
  $("hud").hidden = m !== "results";
  $("settings").hidden = m === "camera" || m === "running";
  for (const id of ["btnPrev", "btnNext", "scrub"]) $(id).disabled = m === "running";
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
async function openVideo(file, name, recorded) {
  stopPlayback();
  if (S.src) URL.revokeObjectURL(S.src);
  Object.assign(S, { blob: recorded ? file : null, name, src: URL.createObjectURL(file), plate: null, samples: null, R: null, end: null, start: 0, cursor: null, facingOverride: null });
  $("btnSaveVideo").hidden = !recorded;
  $("sizeField").hidden = true;
  $("btnAnalyse").disabled = true;
  $("markInstr").innerHTML = "Scrub to the set-up, bar on the floor, then <b>tap the middle of the plate nearest the camera</b>.";
  setMode("mark");
  $("videoInfo").textContent = "Opening the video…";
  try {
    const info = await V.load(video, S.src);
    Object.assign(S, { W: info.W, H: info.H, duration: info.duration });
    Ov.fitViewer(viewer, S.W, S.H);
    S.fps = (await V.probeFps(video)) || 30;
    await V.seek(video, 0);
    shown();
    videoInfo();
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = e.message || String(e);
  }
}
function videoInfo() {
  const parts = [`${S.W}×${S.H}`, `${Math.round(S.fps)} fps`, `${S.duration.toFixed(1)} s`];
  if (S.plate) parts.push(`from ${S.start.toFixed(2)} s to ${(S.end ?? S.duration).toFixed(2)} s`);
  $("videoInfo").textContent = parts.join(" · ") + (S.fps >= 100 ? ". High frame rate: if it plays in real time, keep Video speed on Real time." : "");
}

/* ------------------------------------------------------------------ scrubbing */
let seekBusy = false, seekWant = null;
async function seekTo(t) {
  seekWant = clamp(t, 0, S.duration || 0);
  if (seekBusy) return;
  seekBusy = true;
  try { while (seekWant !== null) { const x = seekWant; seekWant = null; await V.seek(video, x); } } catch { /* a newer seek wins */ }
  seekBusy = false;
  shown();
}
function shown(t = video.currentTime) {
  if (S.duration) $("scrub").value = String(Math.round((t / S.duration) * 10000));
  $("timeRead").textContent = `${t.toFixed(2)} s`;
  redrawOverlay(t);
}
$("scrub").addEventListener("input", () => { stopPlayback(); seekTo((+$("scrub").value / 10000) * S.duration); });
$("btnPrev").addEventListener("click", () => { stopPlayback(); seekTo(video.currentTime - 1 / S.fps); });
$("btnNext").addEventListener("click", () => { stopPlayback(); seekTo(video.currentTime + 1 / S.fps); });

/* ------------------------------------------------------------------ marking the plate */
overlay.addEventListener("pointerdown", (e) => {
  if (S.mode !== "mark" || !S.W) return;
  const rc = overlay.getBoundingClientRect();
  const x = ((e.clientX - rc.left) / rc.width) * S.W, y = ((e.clientY - rc.top) / rc.height) * S.H;
  const m = Math.min(S.W, S.H), side = 0.8 * m, k = 320 / side;
  const sx = clamp(x - side / 2, 0, S.W - side), sy = clamp(y - side / 2, 0, S.H - side);
  const d = detectAt(grab(video, sx, sy, side, side, 320, 320), (x - sx) * k, (y - sy) * k, 0.03 * m * k, 0.3 * m * k);
  let found = d.coverage >= 0.45;
  S.plate = found ? { x: sx + d.x / k, y: sy + d.y / k, r: d.r / k } : { x, y, r: 0.07 * m };
  if (found && Math.hypot(S.plate.x - x, S.plate.y - y) > 0.9 * S.plate.r) { S.plate = { x, y, r: 0.07 * m }; found = false; }
  S.r0 = S.plate.r;
  S.start = video.currentTime;
  $("plateSize").value = "100";
  $("sizeField").hidden = false;
  $("btnAnalyse").disabled = false;
  $("markInstr").textContent = found
    ? "Plate found. Check the circle sits on its outer edge, then Analyse."
    : "Couldn't find the plate's edge here. Tap its middle again, or size the circle to match it.";
  videoInfo();
  redrawOverlay();
});
$("plateSize").addEventListener("input", () => { if (S.plate) { S.plate.r = (S.r0 * +$("plateSize").value) / 100; redrawOverlay(); } });
$("btnEnd").addEventListener("click", () => {
  if (video.currentTime <= S.start + 0.5) { $("markInstr").textContent = "The end has to be after the frame where you marked the plate."; return; }
  S.end = video.currentTime;
  videoInfo();
});

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
}
$("btnAnalyse").addEventListener("click", run);
$("btnCancel").addEventListener("click", () => S.abort?.abort());
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "running" && video.paused) video.play().catch(() => {}); });

/* ------------------------------------------------------------------ results */
const STATUS = { good: ["✓", "Good"], warning: ["!", "Watch"], serious: ["!!", "Work on"] };
const FROM = { you: "set by you", body: "from the body", bar: "guessed from the bar", guess: "guessed" };
const RECOG = { you: "chosen by you", body: "recognised from the body", bar: "recognised from the bar only: check Lift" };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function fmtVal(m) {
  if (m.unit === "cm") return m.label === "Catch vs start" ? fmtSigned(m.value, 0) : m.value.toFixed(m.value < 10 ? 1 : 0);
  if (m.unit === "°" || m.unit === "%" || m.unit === "") return m.value.toFixed(0);
  return m.value.toFixed(2);
}

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
    for (const h of ["Rep", "Range cm", "Mean m/s", "Peak m/s", "Down s", "Up s", ...(depth ? ["Depth cm"] : [])]) head.append(el("th", null, h));
    t.append(head);
    for (const r of R.reps) {
      const tr = el("tr");
      tr.dataset.rep = r.n;
      const cells = [String(r.n), (r.rom * 100).toFixed(0), r.mean.toFixed(2), r.peak.toFixed(2), r.down.toFixed(2), r.up.toFixed(2)];
      if (depth) cells.push(r.depth === null || r.depth === undefined ? "–" : `${r.depth >= 0 ? "−" : "+"}${Math.abs(r.depth * 45).toFixed(0)}`);
      for (const c of cells) tr.append(el("td", null, c));
      tr.addEventListener("click", () => setCursor(r.begin, true));
      t.append(tr);
    }
    if (depth) { const tr = el("tr"), td = el("td", "n", "Depth: hip crease vs the knee, − below parallel (approx.)"); td.colSpan = 7; td.style.textAlign = "left"; tr.append(td); t.append(tr); }
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
    tr.append(a, el("td", "v", `${fmtVal(m)} ${m.unit}`));
    table.append(tr);
  }

  drawCharts();
  setCursor(S.cursor, true);
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
    Ov.draw(overlay, { W: S.W, H: S.H, plate: S.plate });
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
for (const b of document.querySelectorAll(".seg button")) {
  b.addEventListener("click", () => {
    S.rate = +b.dataset.rate;
    for (const o of document.querySelectorAll(".seg button")) o.setAttribute("aria-pressed", String(o === b));
    if (S.playing) video.playbackRate = S.rate;
  });
}

/* result actions */
$("btnFlip").addEventListener("click", () => { S.facingOverride = -S.R.facing; showResults(); });
$("liftSel").addEventListener("change", () => { if (S.mode === "results") showResults(); });
$("repsChart").addEventListener("pointerdown", (e) => {
  if (!S.geoReps) return;
  const x = e.clientX - $("repsChart").getBoundingClientRect().left;
  const c = S.geoReps.cols.find((k) => x >= k.x0 && x < k.x1);
  if (c) setCursor(c.rep.begin, true);
});
$("btnAgain").addEventListener("click", () => { stopPlayback(); setMode("mark"); seekTo(S.start); });
for (const id of ["btnNew", "btnNew2"]) $(id).addEventListener("click", () => { stopPlayback(); setMode("start"); });

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
$("btnCsv").addEventListener("click", () => {
  const R = S.R, rows = ["time_s,forward_cm,height_m,vx_m_s,vy_m_s,speed_m_s,rep,stage,filled_in"];
  for (let i = 0; i < R.n; i++) {
    const k = R.stageOf[i];
    rows.push([(R.T[i] - R.T[R.t0i]).toFixed(4), (R.X[i] * 100).toFixed(2), R.H[i].toFixed(4), R.vx[i].toFixed(3), R.vy[i].toFixed(3), R.speed[i].toFixed(3), R.repOf?.[i] || "", k >= 0 ? R.stages[k].name : "", R.gap[i]].join(","));
  }
  download(new Blob([rows.join("\n")], { type: "text/csv" }), `${S.name}-bar.csv`);
});
$("btnJson").addEventListener("click", () => {
  const R = S.R, t = (i) => (i === null || i === undefined ? null : +(R.T[i] - R.T[R.t0i]).toFixed(4));
  const out = {
    app: "Bar Path", video: { name: S.name, width: S.W, height: S.H, fps: +S.fps.toFixed(2) }, settings: opts(),
    lift: R.lift, title: R.title, recognised: R.liftFrom, facing: R.facing > 0 ? "right" : "left", heights: R.axis.h,
    reps: R.reps ? R.reps.map((r) => ({ rep: r.n, start_s: t(r.begin), range_cm: +(r.rom * 100).toFixed(1), mean_m_s: +r.mean.toFixed(3), peak_m_s: +r.peak.toFixed(3),
      lowering_s: +r.down.toFixed(3), pause_s: +r.pause.toFixed(3), lifting_s: +r.up.toFixed(3), ...(r.depth != null ? { depth_thigh_lengths: +r.depth.toFixed(3) } : {}) })) : undefined,
    events_s: Object.fromEntries(Object.entries(R.ev).map(([k, i]) => [k, t(i)])),
    stages: R.stages.map((s) => ({ ...(s.rep ? { rep: s.rep } : {}), name: s.name, start_s: t(s.i0), seconds: +s.dur.toFixed(3) })),
    measurements: R.metrics.map((m) => ({ ...m, value: +m.value.toFixed(4) })), checks: R.checks,
  };
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), `${S.name}-analysis.json`);
});
$("btnSaveVideo").addEventListener("click", () => { if (S.blob) download(S.blob, `${S.name}.${S.blob.type.includes("mp4") ? "mp4" : "webm"}`); });

/* ------------------------------------------------------------------ getting a video */
$("fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, f.name.replace(/\.\w+$/, ""), false); });
$("captureInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openVideo(f, stamp(), false); });
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `lift-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

$("btnRecord").addEventListener("click", () => (Rec.canRecordInApp() ? openCam() : $("captureInput").click()));
async function openCam() {
  setMode("camera");
  $("camInfo").textContent = "Opening the camera…";
  try {
    S.cam = await Rec.openCamera($("camVideo"));
  } catch (e) {
    setMode("start");
    $("recordHint").textContent = `Couldn't open the camera (${e?.message || e}). You can still record with the camera app and choose the video.`;
    return;
  }
  const cv = $("camVideo"), st = S.cam.settings;
  Ov.fitViewer($("camViewer"), cv.videoWidth || st.width || 16, cv.videoHeight || st.height || 9);
  const fps = st.frameRate ? Math.round(st.frameRate) : null;
  $("camInfo").textContent = `${cv.videoWidth}×${cv.videoHeight}${fps ? ` at ${fps} fps` : ""}.` +
    (fps && fps < 50 ? " The browser gives 30 fps here; for 60 fps or slow motion, record with the camera app and choose the video." : " Side-on, whole lift and floor in frame.");
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
$("recordHint").textContent = Rec.canRecordInApp() ? "" : "Record opens your camera app. In-app recording, with a spirit level, needs the app served over HTTPS.";
setMode("start");
takeShared();
