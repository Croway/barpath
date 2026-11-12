/* The timeline under the video: a filmstrip of the clip with two handles that choose the part to analyse, and a
 * playhead. Made for a thumb: the handles sit outside the selection (so they never cover each other), a touch on
 * the strip moves the nearer handle there, and the frame buttons nudge whichever handle was touched last.
 *
 *   mode "trim"   handles draggable (choosing the part); no playhead unless one is set
 *   mode "scrub"  handles fixed; dragging moves the playhead within the selection (results)
 *   mode "off"    nothing moves (while tracking)
 *
 * Callbacks: onInput(what, t) while dragging, onCommit(what, t, nudged) on release (nudged: a frame step, not a
 * drag); what is "in", "out" or "head".
 */
import { seek, load } from "./video.js";

const HANDLE = 22; // px each handle sticks out beyond the selection; also the strip's side padding

export class Timeline {
  constructor(root, { onInput, onCommit }) {
    this.root = root;
    this.onInput = onInput;
    this.onCommit = onCommit;
    this.duration = 0;
    this.fps = 30;
    this.minSpan = 0.5;
    this.a = 0; this.b = 0; this.head = null;
    this.mode = "off";
    this.active = "in";
    const div = (cls) => { const d = document.createElement("div"); d.className = cls; root.append(d); return d; };
    this.film = document.createElement("canvas");
    this.film.className = "film";
    root.append(this.film);
    this.shadeL = div("shade");
    this.shadeR = div("shade");
    this.sel = div("sel");
    this.hIn = div("handle in");
    this.hOut = div("handle out");
    this.hHead = div("head");
    for (const [h, label] of [[this.hIn, "Start of the part to analyse"], [this.hOut, "End of the part to analyse"]]) {
      h.setAttribute("role", "slider");
      h.setAttribute("aria-label", label);
      h.tabIndex = 0;
      h.addEventListener("keydown", (e) => this.key(e, h === this.hIn ? "in" : "out"));
      h.addEventListener("focus", () => this.setActive(h === this.hIn ? "in" : "out"));
    }
    this.hHead.setAttribute("aria-hidden", "true");
    root.addEventListener("pointerdown", (e) => this.down(e));
    root.addEventListener("pointermove", (e) => this.move(e));
    for (const ev of ["pointerup", "pointercancel"]) root.addEventListener(ev, (e) => this.up(e));
    new ResizeObserver(() => this.layout()).observe(root);
  }

  setVideo(duration, fps) {
    this.duration = duration;
    this.fps = fps || 30;
    this.minSpan = Math.min(0.5, duration / 2);
    this.a = 0; this.b = duration; this.head = null;
    this.active = "in";
    this.clearFilm();
    this.layout();
  }
  setRange(a, b) { this.a = a; this.b = b; this.layout(); }
  setHead(t) { this.head = t; this.layout(); }
  setMode(m) { this.mode = m; this.root.dataset.mode = m; this.drag = null; this.layout(); }
  setActive(w) { this.active = w; this.layout(); }

  /* geometry: times ↔ x within the strip, between the paddings the handles stick out into */
  get w() { return this.root.clientWidth - 2 * HANDLE; }
  x(t) { return HANDLE + (this.duration ? (t / this.duration) * this.w : 0); }
  t(x) { return this.duration ? Math.max(0, Math.min(this.duration, ((x - HANDLE) / this.w) * this.duration)) : 0; }

  layout() {
    const xa = this.x(this.a), xb = this.x(this.b), W = this.root.clientWidth;
    const px = (el, l, w) => { el.style.left = `${l}px`; el.style.width = `${Math.max(0, w)}px`; };
    px(this.shadeL, HANDLE, xa - HANDLE);
    px(this.shadeR, xb, W - HANDLE - xb);
    px(this.sel, xa, xb - xa);
    this.hIn.style.left = `${xa - HANDLE}px`;
    this.hOut.style.left = `${xb}px`;
    this.hIn.dataset.on = String(this.mode === "trim" && this.active === "in");
    this.hOut.dataset.on = String(this.mode === "trim" && this.active === "out");
    this.hHead.hidden = this.head === null;
    if (this.head !== null) this.hHead.style.left = `${this.x(this.head)}px`;
    const fix = (h, v, lo, hi) => {
      h.setAttribute("aria-valuemin", lo.toFixed(2));
      h.setAttribute("aria-valuemax", hi.toFixed(2));
      h.setAttribute("aria-valuenow", v.toFixed(2));
      h.setAttribute("aria-valuetext", `${v.toFixed(2)} seconds`);
      h.setAttribute("aria-disabled", String(this.mode !== "trim"));
    };
    fix(this.hIn, this.a, 0, this.b - this.minSpan);
    fix(this.hOut, this.b, this.a + this.minSpan, this.duration);
    if (this.film.width && Math.abs(this.film.clientWidth * devicePixelRatio - this.film.width) > 2) this.filmDirty?.();
  }

  /** move a handle or the playhead to t, keeping the selection at least minSpan long */
  apply(what, t) {
    if (what === "in") this.a = Math.max(0, Math.min(t, this.b - this.minSpan));
    else if (what === "out") this.b = Math.min(this.duration, Math.max(t, this.a + this.minSpan));
    else this.head = Math.max(this.a, Math.min(this.b, t));
    this.layout();
    return what === "in" ? this.a : what === "out" ? this.b : this.head;
  }

  down(e) {
    if (this.mode === "off" || !this.duration || e.button > 0) return;
    const r = this.root.getBoundingClientRect(), x = e.clientX - r.left;
    let what = "head", grab = 0;
    if (this.mode === "trim") {
      const xa = this.x(this.a), xb = this.x(this.b);
      // a touch on a handle (or just inside the selection next to it) drags it from where it was touched
      const onIn = x >= xa - HANDLE - 8 && x <= xa + 10, onOut = x >= xb - 10 && x <= xb + HANDLE + 8;
      if (onIn && onOut) what = Math.abs(x - (xa - HANDLE / 2)) <= Math.abs(x - (xb + HANDLE / 2)) ? "in" : "out";
      else if (onIn) what = "in";
      else if (onOut) what = "out";
      else what = Math.abs(x - xa) <= Math.abs(x - xb) ? "in" : "out"; // on the strip: the nearer handle jumps there
      if (onIn || onOut) grab = x - (what === "in" ? xa : xb);
      this.active = what;
    }
    e.preventDefault();
    this.root.setPointerCapture(e.pointerId);
    this.drag = { what, grab, id: e.pointerId };
    this.onInput(what, this.apply(what, this.t(x - grab)));
  }
  move(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const r = this.root.getBoundingClientRect();
    this.onInput(this.drag.what, this.apply(this.drag.what, this.t(e.clientX - r.left - this.drag.grab)));
  }
  up(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const { what } = this.drag;
    this.drag = null;
    this.onCommit(what, what === "in" ? this.a : what === "out" ? this.b : this.head);
  }

  /** nudge the active handle (or the playhead) by n frames: the ‹ › buttons and the arrow keys */
  step(n, what = this.mode === "trim" ? this.active : "head") {
    if (this.mode === "off") return;
    const cur = what === "in" ? this.a : what === "out" ? this.b : this.head ?? this.a;
    const t = this.apply(what, cur + n / this.fps);
    this.onInput(what, t);
    this.onCommit(what, t, true);
  }
  key(e, what) {
    const k = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -this.fps, PageUp: this.fps }[e.key];
    if (k === undefined || this.mode !== "trim") return;
    e.preventDefault();
    this.active = what;
    this.step(k, what);
  }

  /* the filmstrip: thumbnails of the whole clip, decoded by a second, off-screen video element so the main one
   * stays free for the user */
  clearFilm() {
    this.filmAbort?.abort();
    this.film.width = this.film.height = 0;
    this.filmDirty = null;
  }
  async filmstrip(src) {
    this.clearFilm();
    const ac = new AbortController();
    this.filmAbort = ac;
    const v = document.createElement("video");
    let thumbs = [];
    const paint = () => {
      const c = this.film, dpr = devicePixelRatio || 1;
      c.width = Math.round(c.clientWidth * dpr);
      c.height = Math.round(c.clientHeight * dpr);
      const g = c.getContext("2d");
      g.clearRect(0, 0, c.width, c.height);
      for (const th of thumbs) {
        const x0 = Math.round((th.i / th.n) * c.width), x1 = Math.round(((th.i + 1) / th.n) * c.width);
        g.drawImage(th.img, x0, 0, x1 - x0, c.height);
      }
    };
    this.filmDirty = () => { if (thumbs.length) paint(); };
    try {
      const info = await load(v, src);
      if (ac.signal.aborted) return;
      const c = this.film, aspect = info.W / info.H;
      const n = Math.max(3, Math.min(16, Math.ceil(c.clientWidth / (c.clientHeight * aspect))));
      const th = Math.round(c.clientHeight * (devicePixelRatio || 1)), tw = Math.max(8, Math.round(((c.clientWidth / n) * th) / c.clientHeight));
      for (let i = 0; i < n; i++) {
        await seek(v, ((i + 0.5) / n) * info.duration);
        if (ac.signal.aborted) return;
        // each thumbnail: the middle of the frame, cropped to the slot's shape
        const img = document.createElement("canvas");
        img.width = tw; img.height = th;
        const sw = Math.min(info.W, (info.H * tw) / th), sh = Math.min(info.H, (info.W * th) / tw);
        img.getContext("2d").drawImage(v, (info.W - sw) / 2, (info.H - sh) / 2, sw, sh, 0, 0, tw, th);
        thumbs = [...thumbs, { i, n, img }];
        paint();
      }
    } catch { /* no filmstrip: the timeline still works */ } finally {
      v.removeAttribute("src");
      v.load();
    }
  }
}
