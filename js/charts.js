/* Canvas charts for the results: the bar path (side view) and bar speed over time.
 * Colours are read from the CSS tokens at draw time, so both themes stay in step. */
import { STAGES, fmtPlain } from "./analysis.js";
import { tr, num } from "./i18n.js";

const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hex = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'; // --fs-xs

/** the sequential speed ramp, faint (slow) to strong (fast), for this theme */
export const rampStops = () => tok("--ramp").split(",").map((s) => hex(s.trim()));
export function rampAt(stops, k) {
  k = clamp(k, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k)), f = k - i, a = stops[i], b = stops[i + 1];
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(",")})`;
}
export const rampCss = (stops) => `linear-gradient(90deg, ${stops.map((s) => `rgb(${s.join(",")})`).join(", ")})`;

function setup(canvas, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1), w = Math.max(200, canvas.parentElement.clientWidth);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  return { ctx, w, h };
}
function ticks(lo, hi, n) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const fmt = (v, d) => num(Math.abs(v) < 1e-9 ? 0 : v, d).replace("-", "−");
function dot(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fillStyle = tok("--surface"); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
}
/** a label beside the point (x, y): on the side asked if it fits the canvas and misses what's in `placed` (labels
 * and dots already drawn), else the other side, else nudged up or down; over a surface halo, so lines running
 * under it don't strike it through. Its box is added to `placed`. */
function label(ctx, text, x, y, side, w, placed = []) {
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width, other = side === "left" ? "right" : "left";
  const box = (s, dy) => { const x0 = s === "left" ? x - 9 - tw : x + 9; return { x0, x1: x0 + tw, y0: y + dy - 8, y1: y + dy + 8, dy }; };
  const inside = (b) => b.x0 >= 2 && b.x1 <= w - 2;
  const free = (b) => inside(b) && !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  const tries = [box(side, 0), box(other, 0), box(side, -14), box(side, 14), box(other, -14), box(other, 14)];
  const b = tries.find(free) || tries.find(inside) || tries[0];
  placed.push(b);
  ctx.textAlign = "left";
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = tok("--surface");
  ctx.strokeText(text, b.x0, y + b.dy);
  ctx.fillStyle = tok("--ink-2");
  ctx.fillText(text, b.x0, y + b.dy);
}
const dotBox = (x, y, r) => ({ x0: x - r - 2, x1: x + r + 2, y0: y - r - 2, y1: y + r + 2 });

/**
 * Scrubbing a chart: a finger scrubs only once it moves sideways, or with a tap; moving up or down is left to the
 * page, which scrolls (the canvas has touch-action: pan-y). A mouse or pen scrubs from the press, and a mouse
 * also on hover when `hover`. `at({x, y})` gets canvas CSS px.
 */
export function scrub(canvas, at, { hover = false } = {}) {
  let start = null, axis = null; // a finger: where it went down; "x" once it moves sideways, "y" if up or down
  const xy = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") { at(xy(e)); return; }
    start = { x: e.clientX, y: e.clientY }; axis = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") { if (e.buttons || (hover && e.pointerType === "mouse")) at(xy(e)); return; }
    if (!start) return;
    if (!axis) {
      const dx = Math.abs(e.clientX - start.x), dy = Math.abs(e.clientY - start.y);
      if (Math.max(dx, dy) < 6) return;
      axis = dx > dy ? "x" : "y";
    }
    if (axis === "x") at(xy(e));
  });
  canvas.addEventListener("pointerup", (e) => { if (e.pointerType === "touch" && start && !axis) at(xy(e)); start = null; });
  canvas.addEventListener("pointercancel", () => { start = null; axis = null; });
}

/** the part of the recording worth plotting (the analysis decides: the pull, or the whole set) */
export const span = (R) => R.span;
const where = (R, i) => {
  const k = R.stageOf[i];
  if (k >= 0) return R.reps ? tr("chart.where.repStage", { rep: R.stages[k].rep, stage: R.stages[k].name }) : R.stages[k].name;
  return i < R.t0i ? tr("chart.where.before") : R.reps && R.repOf[i] ? tr("chart.where.rep", { n: R.repOf[i] }) : R.reps ? tr("chart.where.between") : tr("chart.where.after");
};
export { where };

/* ------------------------------------------------------------------ bar path */
export function drawPath(canvas, R, cursor) {
  const h = clamp(Math.round(canvas.parentElement.clientWidth * 1.05), 320, 440);
  const { ctx, w } = setup(canvas, h);
  const [i0, i1] = span(R);
  let ext = 10, top = 0, bot = 0, vTop = 0;
  for (let i = i0; i <= i1; i++) { ext = Math.max(ext, Math.abs(R.X[i]) * 100 + 3); top = Math.max(top, R.H[i]); bot = Math.min(bot, R.H[i]); vTop = Math.max(vTop, R.speed[i]); }
  ext = Math.ceil(ext / 5) * 5;
  top = Math.ceil((top + 0.08) * 4) / 4;
  bot = bot < 0 ? Math.floor((bot - 0.08) * 4) / 4 : 0; // heights below the start (a squat, a bench) go negative
  vTop = Math.max(1, Math.ceil(vTop * 4) / 4);
  const m = { l: 38, r: 10, t: 26, b: 34 };
  const px = (xcm) => m.l + ((xcm + ext) / (2 * ext)) * (w - m.l - m.r);
  const py = (hm) => h - m.b - ((hm - bot) / (top - bot)) * (h - m.t - m.b);

  // grid, axes
  ctx.lineWidth = 1;
  for (const v of ticks(bot, top, 6)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(fmt(v, v % 1 ? 2 : 1), m.l - 6, py(v));
  }
  for (const v of ticks(-ext, ext, 5)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(Math.round(px(v)) + 0.5, m.t); ctx.lineTo(Math.round(px(v)) + 0.5, h - m.b); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(v > 0 ? `+${fmtPlain(v)}` : fmt(v, 0), px(v), h - m.b + 5);
  }
  ctx.fillStyle = tok("--muted"); ctx.textBaseline = "top";
  ctx.textAlign = "left"; ctx.fillText(R.axis.h, 4, 2);
  ctx.textAlign = "left"; ctx.fillText(R.axis.x[0], m.l, h - 13);
  ctx.textAlign = "right"; ctx.fillText(R.axis.x[1], w - m.r, h - 13);
  ctx.textAlign = "center"; ctx.fillText("cm", (m.l + w - m.r) / 2, h - 13);

  // the path, coloured by speed
  const stops = rampStops();
  ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let i = i0 + 1; i <= i1; i++) {
    ctx.strokeStyle = rampAt(stops, R.speed[i] / vTop);
    ctx.beginPath(); ctx.moveTo(px(R.X[i - 1] * 100), py(R.H[i - 1])); ctx.lineTo(px(R.X[i] * 100), py(R.H[i])); ctx.stroke();
  }

  // the analysis's marks: labelled sparingly (one per kind), the rest as plain dots
  // (every dot first, then the labels around them)
  const ink = tok("--ink"), placed = [];
  for (const mk of R.marks) {
    const x = px(R.X[mk.i] * 100), y = py(R.H[mk.i]), r = mk.name ? 4 : 3;
    dot(ctx, x, y, r, ink);
    placed.push(dotBox(x, y, r));
  }
  for (const mk of R.marks) if (mk.name) label(ctx, mk.name, px(R.X[mk.i] * 100), py(R.H[mk.i]), mk.side, w, placed);
  if (cursor !== null && cursor >= i0 && cursor <= i1) dot(ctx, px(R.X[cursor] * 100), py(R.H[cursor]), 5, tok("--accent"));
  return { i0, i1, px, py, vTop, stops };
}

/** nearest point of the path to (x, y) in canvas px */
export function pathHit(geo, R, x, y) {
  let best = geo.i0, bd = Infinity;
  for (let i = geo.i0; i <= geo.i1; i++) {
    const d = (geo.px(R.X[i] * 100) - x) ** 2 + (geo.py(R.H[i]) - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* ------------------------------------------------------------------ bar speed over time */
export function drawSpeed(canvas, R, cursor) {
  const h = 240;
  const { ctx, w } = setup(canvas, h);
  const [i0, i1] = span(R);
  const t = (i) => (i - R.t0i) / R.fs;
  let lo = 0, hi = 0;
  for (let i = i0; i <= i1; i++) { lo = Math.min(lo, R.vy[i]); hi = Math.max(hi, R.vy[i]); }
  lo = Math.min(-0.5, Math.floor(lo * 2) / 2); hi = Math.ceil((hi + 0.15) * 2) / 2;
  const m = { l: 38, r: 10, t: 24, b: 26 };
  const px = (s) => m.l + ((s - t(i0)) / (t(i1) - t(i0))) * (w - m.l - m.r);
  const py = (v) => h - m.b - ((v - lo) / (hi - lo)) * (h - m.t - m.b);

  // stage washes, a 2px surface gap between them
  ctx.globalAlpha = 0.14;
  for (const s of R.stages) {
    const a = px(t(s.i0)) + 1, b = px(t(s.i1)) - 1;
    if (b > a) { ctx.fillStyle = tok(`--s${s.slot}`); ctx.fillRect(a, m.t, b - a, h - m.t - m.b); }
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  for (const v of ticks(lo, hi, 5)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(fmt(v, 1), m.l - 6, py(v));
  }
  for (const v of ticks(t(i0), t(i1), 6)) {
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(`${fmt(v, 1)}`, px(v), h - m.b + 5);
  }
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("m/s", 4, 0);
  ctx.textAlign = "right"; ctx.fillText(R.axis.t, w - m.r, 0);

  ctx.strokeStyle = tok("--accent"); ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) (i === i0 ? ctx.moveTo : ctx.lineTo).call(ctx, px(t(i)), py(R.vy[i]));
  ctx.stroke();

  dot(ctx, px(t(R.ev.vmax)), py(R.vy[R.ev.vmax]), 4, tok("--accent"));
  label(ctx, `${num(R.vy[R.ev.vmax], 2)} m/s`, px(t(R.ev.vmax)), py(R.vy[R.ev.vmax]), "right", w);

  if (cursor !== null && cursor >= i0 && cursor <= i1) {
    ctx.strokeStyle = tok("--ink-2"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(px(t(cursor))) + 0.5, m.t); ctx.lineTo(Math.round(px(t(cursor))) + 0.5, h - m.b); ctx.stroke();
    dot(ctx, px(t(cursor)), py(R.vy[cursor]), 4, tok("--accent"));
  }
  return { i0, i1, px, py, t, m, w };
}

export function speedHit(geo, x) {
  const frac = clamp((x - geo.m.l) / (geo.w - geo.m.l - geo.m.r), 0, 1);
  return Math.round(geo.i0 + frac * (geo.i1 - geo.i0));
}

/** tooltip content for sample i: value first, labels after; built with textContent */
export function fillTip(tip, R, i) {
  tip.replaceChildren();
  const b = document.createElement("b");
  b.textContent = tr("chart.tip.speed", { v: num(R.vy[i], 2) });
  tip.append(b);
  const k = R.stageOf[i];
  const rows = [
    [`${R.H[i] < 0 ? "−" : ""}${num(Math.abs(R.H[i]), 2)} ${R.axis.h} · ${R.X[i] >= 0 ? "+" : "−"}${num(Math.abs(R.X[i] * 100), 1)} cm`, null],
    [`${num((i - R.t0i) / R.fs, 2)} ${R.axis.t}`, null],
    [where(R, i), k >= 0 ? `--s${R.stages[k].slot}` : null],
  ];
  for (const [text, color] of rows) {
    const r = document.createElement("div");
    r.className = "row";
    if (color) { const key = document.createElement("span"); key.className = "key"; key.style.borderColor = tok(color); r.append(key); }
    r.append(document.createTextNode(text));
    tip.append(r);
  }
}

/* ------------------------------------------------------------------ mean lifting speed per rep */
/** columns, one per rep, value at the cap; the rep under the cursor is the accent, the others a lighter step */
export function drawReps(canvas, R, curRep) {
  const h = 200;
  const { ctx, w } = setup(canvas, h);
  const reps = R.reps, m = { l: 38, r: 10, t: 28, b: 26 };
  const top = Math.max(0.5, Math.ceil(Math.max(...reps.map((r) => r.mean)) * 1.15 * 4) / 4);
  const slot = (w - m.l - m.r) / reps.length, bw = Math.min(24, slot * 0.6);
  const py = (v) => h - m.b - (v / top) * (h - m.t - m.b);
  ctx.lineWidth = 1;
  for (const v of ticks(0, top, 4)) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(fmt(v, 2), m.l - 6, py(v));
  }
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("m/s", 4, 0);
  const stops = rampStops(), base = py(0);
  const cols = [];
  reps.forEach((r, k) => {
    const cx = m.l + slot * (k + 0.5), y = py(r.mean), x = cx - bw / 2, rad = Math.min(4, bw / 2, base - y);
    ctx.fillStyle = r.n === curRep || curRep === null ? tok("--accent") : rampAt(stops, 0.15);
    ctx.beginPath(); // 4px rounded data end, square at the baseline
    ctx.moveTo(x, base); ctx.lineTo(x, y + rad); ctx.quadraticCurveTo(x, y, x + rad, y); ctx.lineTo(x + bw - rad, y);
    ctx.quadraticCurveTo(x + bw, y, x + bw, y + rad); ctx.lineTo(x + bw, base); ctx.closePath(); ctx.fill();
    ctx.fillStyle = tok("--ink-2"); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    if (slot >= 30) ctx.fillText(num(r.mean, 2), cx, y - 3);
    ctx.fillStyle = tok("--muted"); ctx.textBaseline = "top"; ctx.fillText(String(r.n), cx, base + 5);
    cols.push({ x0: cx - slot / 2, x1: cx + slot / 2, rep: r });
  });
  return { cols };
}
export { STAGES };
