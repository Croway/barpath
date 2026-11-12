/* Comparing saved lifts: up to four, lined up at lift-off (the first rep's start for a set). Their videos play and
 * scrub together, their bar paths and speeds share one chart each (one categorical colour per lift), and every
 * measurement sits side by side, with the difference when there are two.
 *
 * Time here is τ, seconds from each lift's own lift-off; lift k shows grid index t0i + τ·fs, i.e. video time
 * tv0 + (t0i/fs + τ)·slow. */
import { analyse, LIFTS, fmtMetric } from "./analysis.js";
import * as V from "./video.js";
import * as Ov from "./overlay.js";

const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
export const MAX = 4;
export const when = (ms) => {
  const d = new Date(ms), now = new Date();
  return d.toLocaleString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });
};

export class Compare {
  /** refs: { videos, legend, scrub, read, play, prev, next, rates, path, speed, table, note } */
  constructor(refs) {
    this.r = refs;
    this.L = [];
    this.tau = 0;
    this.rate = 0.25;
    this.playing = false;
    refs.scrub.addEventListener("input", () => { this.stop(); this.go(+refs.scrub.value); });
    refs.prev.addEventListener("click", () => { this.stop(); this.go(this.tau - this.step()); });
    refs.next.addEventListener("click", () => { this.stop(); this.go(this.tau + this.step()); });
    refs.play.addEventListener("click", () => (this.playing ? this.stop() : this.start()));
    for (const b of refs.rates.querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.rate = +b.dataset.rate;
        for (const o of refs.rates.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        if (this.playing) { this.stop(); this.start(); }
      });
    }
    this.chartDrag(refs.speed, (x) => this.geoS && this.geoS.tauAt(x));
    this.chartDrag(refs.path, (x, y) => this.geoP && this.geoP.tauAt(x, y));
  }
  step() { return 1 / Math.max(...this.L.map((l) => l.R.fs)); }

  /** items: [{ card, data, video: Blob }], already loaded from the store */
  async open(items) {
    this.close();
    const r = this.r;
    this.L = items.map((it, k) => {
      const R = analyse(it.data.samples, it.data.opts);
      return { card: it.card, data: it.data, blob: it.video, k, R, color: `--s${k + 1}` };
    }).filter((l) => !l.R.error);
    const lifts = new Set(this.L.map((l) => l.R.lift));
    r.note.hidden = lifts.size < 2;
    r.note.textContent = lifts.size < 2 ? "" : `These are different lifts (${[...lifts].map((x) => LIFTS[x]).join(", ")}): they're lined up at the start of the lift, and heights may be measured differently.`;

    // range of τ covered by any lift
    this.lo = Math.min(...this.L.map(({ R }) => (R.span[0] - R.t0i) / R.fs));
    this.hi = Math.max(...this.L.map(({ R }) => (R.span[1] - R.t0i) / R.fs));
    r.scrub.min = String(this.lo); r.scrub.max = String(this.hi); r.scrub.step = "any";

    r.legend.replaceChildren();
    r.videos.replaceChildren();
    r.videos.dataset.n = String(this.L.length);
    for (const l of this.L) {
      const li = el("li");
      li.style.setProperty("--c", `var(${l.color})`);
      const sw = el("span", "sw", String(l.k + 1));
      li.append(sw, el("span", "ttl", `${l.R.title}${l.R.kg ? ` · ${l.R.kg} kg` : ""}`), el("span", "when", when(l.card.filmed)));
      r.legend.append(li);

      const tile = el("figure", "cmp-tile");
      tile.style.setProperty("--c", `var(${l.color})`);
      const view = el("div", "viewer");
      const video = el("video"), canvas = el("canvas");
      video.muted = true; video.playsInline = true;
      view.append(video, canvas, el("span", "tag", String(l.k + 1)));
      tile.append(view, el("figcaption", null, `${l.R.kg ? `${l.R.kg} kg · ` : ""}${l.R.title} · ${when(l.card.filmed)}`));
      r.videos.append(tile);
      Object.assign(l, { video, canvas, view, url: URL.createObjectURL(l.blob), busy: null, want: null });
    }
    await Promise.all(this.L.map(async (l) => {
      const info = await V.load(l.video, l.url);
      Object.assign(l, { W: info.W, H: info.H });
      Ov.fitViewer(l.view, info.W, info.H);
    }));
    this.table();
    this.go(0);
  }

  close() {
    this.stop();
    for (const l of this.L) { l.video.removeAttribute("src"); l.video.load(); URL.revokeObjectURL(l.url); }
    this.L = [];
  }

  /* τ for lift l: its grid index and video time */
  idx(l, tau) { const { R } = l; return clamp(Math.round(R.t0i + tau * R.fs), R.span[0], R.span[1]); }
  vt(l, tau) { return l.R.tVideo(this.idx(l, tau)); }

  /** show everyone at τ: seek each video (latest request wins), redraw */
  go(tau) {
    this.tau = clamp(tau, this.lo, this.hi);
    for (const l of this.L) this.seek(l, this.vt(l, this.tau));
    this.draw();
  }
  seek(l, t) {
    l.want = t;
    l.busy ??= (async () => {
      try { while (l.want !== null) { const x = l.want; l.want = null; await V.seek(l.video, x); } } catch { /* a newer seek wins */ }
      l.busy = null;
      this.overlay(l);
    })();
    return l.busy;
  }

  /* together: wall clock in real seconds, each video at rate × its slow-motion factor, nudged back when it drifts */
  async start() {
    if (this.tau >= this.hi - 1e-3) this.go(this.lo);
    this.playing = true;
    this.r.play.textContent = "Pause";
    await Promise.all(this.L.map((l) => this.seek(l, this.vt(l, this.tau))));
    if (!this.playing) return;
    for (const l of this.L) { l.video.playbackRate = this.rate * l.R.slow; l.video.play().catch(() => {}); }
    let last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      this.tau += ((now - last) / 1000) * this.rate;
      last = now;
      if (this.tau >= this.hi) { this.tau = this.hi; this.stop(); this.draw(); return; }
      for (const l of this.L) {
        const want = this.vt(l, this.tau), end = l.R.tVideo(l.R.span[1]);
        if (want >= end - 1e-3) { if (!l.video.paused) l.video.pause(); continue; } // this one has finished: hold its last frame
        if (l.video.paused && !l.video.seeking) l.video.play().catch(() => {});
        if (Math.abs(l.video.currentTime - want) > 0.15 * Math.max(1, l.R.slow)) l.video.currentTime = want;
        this.overlay(l);
      }
      this.draw(false);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.r.play.textContent = "Play";
    for (const l of this.L) l.video.pause();
  }

  /* drawing */
  overlay(l) {
    const { R } = l, i = R.indexAt(l.video.currentTime), trail = [];
    for (let j = R.span[0]; j <= i; j++) trail.push({ x: R.xs[j], y: R.ys[j], k: null });
    Ov.draw(l.canvas, { W: l.W, H: l.H, plate: { x: R.xs[i], y: R.ys[i], r: R.rs[i] }, trail, color: tok(l.color) });
  }
  draw(all = true) {
    this.r.scrub.value = String(this.tau);
    this.r.read.textContent = `${this.tau >= 0 ? "+" : "−"}${Math.abs(this.tau).toFixed(2)} s from lift-off`;
    this.geoP = drawPaths(this.r.path, this.L, this.tau, this);
    this.geoS = drawSpeeds(this.r.speed, this.L, this.tau, this);
    if (all) for (const l of this.L) if (!l.busy) this.overlay(l);
  }
  chartDrag(canvas, at) {
    const move = (e) => {
      const r = canvas.getBoundingClientRect(), tau = at(e.clientX - r.left, e.clientY - r.top);
      if (tau !== undefined && tau !== null) { this.stop(); this.go(tau); }
    };
    canvas.addEventListener("pointerdown", move);
    canvas.addEventListener("pointermove", (e) => { if (e.buttons) move(e); });
  }

  /** every measurement side by side; with two lifts, the difference second minus first */
  table() {
    const t = this.r.table, two = this.L.length === 2;
    t.replaceChildren();
    const head = el("tr");
    head.append(el("th", null, ""));
    for (const l of this.L) { const th = el("th", "col"); th.style.setProperty("--c", `var(${l.color})`); th.append(el("span", "sw", String(l.k + 1))); head.append(th); }
    if (two) head.append(el("th", "col", "2 − 1"));
    t.append(head);
    const rows = new Map(), groups = [];
    for (const l of this.L) for (const m of l.R.metrics) {
      const key = `${m.group}\u0000${m.label}`;
      if (!groups.includes(m.group)) groups.push(m.group);
      if (!rows.has(key)) rows.set(key, { group: m.group, label: m.label, unit: m.unit, note: m.note, vals: [] });
      rows.get(key).vals[l.k] = m;
    }
    let group = null;
    for (const row of [...rows.values()].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group))) {
      if (row.group !== group) {
        group = row.group;
        const tr = el("tr"), th = el("th", "grp", group);
        th.colSpan = this.L.length + 1 + (two ? 1 : 0);
        tr.append(th);
        t.append(tr);
      }
      const tr = el("tr"), a = el("td", null, row.label);
      if (row.unit) a.append(el("span", "n", row.unit));
      tr.append(a);
      for (const l of this.L) { const m = row.vals[l.k]; tr.append(el("td", "v", m ? fmtMetric(m) : "–")); }
      if (two) {
        const [m1, m2] = [row.vals[0], row.vals[1]];
        const d = m1 && m2 && !m1.category && m1.unit === m2.unit && Number.isFinite(m1.value) && Number.isFinite(m2.value) ? fmtMetric({ ...m2, value: m2.value - m1.value }, true) : "–";
        tr.append(el("td", "v d", d));
      }
      t.append(tr);
    }
  }
}

/* ------------------------------------------------------------------ the charts */
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
const fmt = (v, d) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d).replace("-", "−");
function grid(ctx, m, w, h, xs, ys, px, py, xfmt, yfmt) {
  ctx.lineWidth = 1;
  for (const v of ys) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(py(v)) + 0.5); ctx.lineTo(w - m.r, Math.round(py(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(yfmt(v), m.l - 6, py(v));
  }
  for (const v of xs) {
    ctx.strokeStyle = v === 0 ? tok("--axis") : tok("--grid");
    ctx.beginPath(); ctx.moveTo(Math.round(px(v)) + 0.5, m.t); ctx.lineTo(Math.round(px(v)) + 0.5, h - m.b); ctx.stroke();
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(xfmt(v), px(v), h - m.b + 5);
  }
}
function dot(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fillStyle = tok("--surface"); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
}

/** every lift's bar path in its colour, on shared axes; a dot where each is at τ */
function drawPaths(canvas, L, tau, C) {
  const h = Math.min(440, Math.max(320, Math.round(canvas.parentElement.clientWidth * 1.05)));
  const { ctx, w } = setup(canvas, h);
  let ext = 10, top = 0, bot = 0;
  for (const { R } of L) for (let i = R.span[0]; i <= R.span[1]; i++) { ext = Math.max(ext, Math.abs(R.X[i]) * 100 + 3); top = Math.max(top, R.H[i]); bot = Math.min(bot, R.H[i]); }
  ext = Math.ceil(ext / 5) * 5;
  top = Math.ceil((top + 0.08) * 4) / 4;
  bot = bot < 0 ? Math.floor((bot - 0.08) * 4) / 4 : 0;
  const m = { l: 38, r: 10, t: 26, b: 34 };
  const px = (xcm) => m.l + ((xcm + ext) / (2 * ext)) * (w - m.l - m.r);
  const py = (hm) => h - m.b - ((hm - bot) / (top - bot)) * (h - m.t - m.b);
  grid(ctx, m, w, h, ticks(-ext, ext, 5), ticks(bot, top, 6), px, py, (v) => (v > 0 ? `+${v}` : fmt(v, 0)), (v) => fmt(v, v % 1 ? 2 : 1));
  const R0 = L[0].R;
  ctx.fillStyle = tok("--muted"); ctx.textBaseline = "top";
  ctx.textAlign = "left"; ctx.fillText(R0.axis.h, 4, 2);
  ctx.fillText(R0.axis.x[0], m.l, h - 13);
  ctx.textAlign = "right"; ctx.fillText(R0.axis.x[1], w - m.r, h - 13);
  ctx.textAlign = "center"; ctx.fillText("cm", (m.l + w - m.r) / 2, h - 13);
  ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const { R, color } of L) {
    ctx.strokeStyle = tok(color);
    ctx.beginPath();
    for (let i = R.span[0]; i <= R.span[1]; i++) (i === R.span[0] ? ctx.moveTo : ctx.lineTo).call(ctx, px(R.X[i] * 100), py(R.H[i]));
    ctx.stroke();
  }
  for (const l of L) { const i = C.idx(l, tau); dot(ctx, px(l.R.X[i] * 100), py(l.R.H[i]), 5, tok(l.color)); }
  return {
    tauAt(x, y) { // the nearest point of any path
      let best = null, bd = Infinity;
      for (const { R } of L) for (let i = R.span[0]; i <= R.span[1]; i++) {
        const d = (px(R.X[i] * 100) - x) ** 2 + (py(R.H[i]) - y) ** 2;
        if (d < bd) { bd = d; best = (i - R.t0i) / R.fs; }
      }
      return best;
    },
  };
}

/** every lift's vertical bar speed against time from its lift-off; a line at τ */
function drawSpeeds(canvas, L, tau, C) {
  const h = 240;
  const { ctx, w } = setup(canvas, h);
  let lo = 0, hi = 0;
  for (const { R } of L) for (let i = R.span[0]; i <= R.span[1]; i++) { lo = Math.min(lo, R.vy[i]); hi = Math.max(hi, R.vy[i]); }
  lo = Math.min(-0.5, Math.floor(lo * 2) / 2); hi = Math.ceil((hi + 0.15) * 2) / 2;
  const m = { l: 38, r: 10, t: 24, b: 26 };
  const px = (s) => m.l + ((s - C.lo) / (C.hi - C.lo || 1)) * (w - m.l - m.r);
  const py = (v) => h - m.b - ((v - lo) / (hi - lo)) * (h - m.t - m.b);
  grid(ctx, m, w, h, ticks(C.lo, C.hi, 6), ticks(lo, hi, 5), px, py, (v) => fmt(v, 1), (v) => fmt(v, 1));
  ctx.fillStyle = tok("--muted"); ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("m/s", 4, 0);
  ctx.textAlign = "right"; ctx.fillText("s from lift-off", w - m.r, 0);
  ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const { R, color } of L) {
    ctx.strokeStyle = tok(color);
    ctx.beginPath();
    for (let i = R.span[0]; i <= R.span[1]; i++) (i === R.span[0] ? ctx.moveTo : ctx.lineTo).call(ctx, px((i - R.t0i) / R.fs), py(R.vy[i]));
    ctx.stroke();
  }
  ctx.strokeStyle = tok("--ink-2"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(px(tau)) + 0.5, m.t); ctx.lineTo(Math.round(px(tau)) + 0.5, h - m.b); ctx.stroke();
  for (const l of L) { const i = C.idx(l, tau); dot(ctx, px((i - l.R.t0i) / l.R.fs), py(l.R.vy[i]), 4, tok(l.color)); }
  return { tauAt: (x) => C.lo + clamp((x - m.l) / (w - m.l - m.r), 0, 1) * (C.hi - C.lo) };
}
