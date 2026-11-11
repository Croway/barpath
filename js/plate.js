/* Plate tracking: where is the centre of the near plate in this frame?
 *
 * The plate is a circle of known size, so each frame we look for that circle near
 * where it should be. Every colour edge votes for the point one radius away along
 * its gradient, both ways, because the plate can be lighter or darker than what's
 * behind it. The vote peak is the centre. A least-squares circle fit on the edge
 * pixels that agree with it refines that to a fraction of a pixel. Nothing printed
 * on the plate matters, so it doesn't care that the plate spins in the turnover.
 *
 * Images are {data: RGBA bytes, width, height}, so this runs the same in the
 * browser (ImageData) and in Node tests. Positions in and out are canvas coordinates
 * (pixel i spans i..i+1); inside, pixel indices are used, hence the ±0.5s.
 */

/** plate radius, in processing pixels, that every frame is scaled to */
export const PROC_R = 36;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Sobel gradients, per pixel taken from whichever of R, G, B has the strongest edge */
export function edgeMap(img) {
  const { data, width: w, height: h } = img;
  const n = w * h, gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  const row = 4 * w;
  let max = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = (y * w + x) * 4;
      let best = 0, bx = 0, by = 0;
      for (let c = 0; c < 3; c++) {
        const i = p + c;
        const tl = data[i - row - 4], tc = data[i - row], tr = data[i - row + 4];
        const ml = data[i - 4], mr = data[i + 4];
        const bl = data[i + row - 4], bc = data[i + row], br = data[i + row + 4];
        const sx = tr + 2 * mr + br - (tl + 2 * ml + bl);
        const sy = bl + 2 * bc + br - (tl + 2 * tc + tr);
        const m = sx * sx + sy * sy;
        if (m > best) { best = m; bx = sx; by = sy; }
      }
      const k = y * w + x, m = Math.sqrt(best);
      gx[k] = bx; gy[k] = by; mag[k] = m;
      if (m > max) max = m;
    }
  }
  return { w, h, gx, gy, mag, thr: Math.max(28, 0.1 * max) };
}

/** every edge pixel votes for the centres one radius away; one accumulator per radius, over `win` only */
function vote(E, radii, win) {
  const ww = win.x1 - win.x0 + 1, wh = win.y1 - win.y0 + 1;
  const accs = radii.map(() => new Float32Array(ww * wh));
  const { w, h, gx, gy, mag, thr } = E;
  const rMax = radii[radii.length - 1];
  // only edges that could reach the window matter
  const ex0 = Math.max(1, Math.floor(win.x0 - rMax - 1)), ex1 = Math.min(w - 2, Math.ceil(win.x1 + rMax + 1));
  const ey0 = Math.max(1, Math.floor(win.y0 - rMax - 1)), ey1 = Math.min(h - 2, Math.ceil(win.y1 + rMax + 1));
  for (let y = ey0; y <= ey1; y++) {
    for (let x = ex0; x <= ex1; x++) {
      const k = y * w + x, m = mag[k];
      if (m < thr) continue;
      const ux = gx[k] / m, uy = gy[k] / m;
      for (let ri = 0; ri < radii.length; ri++) {
        const r = radii[ri], acc = accs[ri];
        for (let s = -1; s <= 1; s += 2) {
          const px = x + s * r * ux - win.x0, py = y + s * r * uy - win.y0;
          const ix = Math.floor(px), iy = Math.floor(py);
          if (ix < 0 || iy < 0 || ix >= ww - 1 || iy >= wh - 1) continue;
          const fx = px - ix, fy = py - iy, i = iy * ww + ix;
          acc[i] += (1 - fx) * (1 - fy);
          acc[i + 1] += fx * (1 - fy);
          acc[i + ww] += (1 - fx) * fy;
          acc[i + ww + 1] += fx * fy;
        }
      }
    }
  }
  return { accs, ww, wh };
}

function blur3(a, w, h) {
  const o = new Float32Array(a.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      o[i] = (a[i - w - 1] + a[i - w] + a[i - w + 1] + a[i - 1] + a[i] + a[i + 1] + a[i + w - 1] + a[i + w] + a[i + w + 1]) / 9;
    }
  }
  return o;
}

/** best (centre, radius) per radius, as votes per unit of circumference, optionally pulled toward a prior */
function peaks(E, radii, win, prior) {
  const { accs, ww, wh } = vote(E, radii, win);
  const out = [];
  for (let ri = 0; ri < radii.length; ri++) {
    const B = blur3(accs[ri], ww, wh), norm = 1 / (2 * Math.PI * radii[ri]);
    let bs = -1, bx = 0, by = 0;
    for (let y = 1; y < wh - 1; y++) {
      for (let x = 1; x < ww - 1; x++) {
        let s = B[y * ww + x] * norm;
        if (prior) {
          const dx = x + win.x0 - prior.x, dy = y + win.y0 - prior.y;
          s *= Math.exp(-(dx * dx + dy * dy) / (2 * prior.sigma * prior.sigma));
        }
        if (s > bs) { bs = s; bx = x; by = y; }
      }
    }
    // sub-pixel: parabola through the peak and its neighbours
    const i = by * ww + bx;
    const sub = (l, c, r) => { const d = l - 2 * c + r; return d < 0 ? clamp((0.5 * (l - r)) / d, -0.5, 0.5) : 0; };
    const ox = bx > 0 && bx < ww - 1 ? sub(B[i - 1], B[i], B[i + 1]) : 0;
    const oy = by > 0 && by < wh - 1 ? sub(B[i - ww], B[i], B[i + ww]) : 0;
    out.push({ x: win.x0 + bx + ox, y: win.y0 + by + oy, r: radii[ri], s: bs });
  }
  return out;
}

function solve3(m, v) {
  const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map((c) => det(m.map((row, r) => row.map((x, k) => (k === c ? v[r] : x)))) / d);
}

const BINS = 48;
/**
 * Fits the centre of a circle of KNOWN radius r (Gauss-Newton on the distance to the rim) to the edge pixels
 * within band*r of it whose gradient points along the radius. The radius stays fixed on purpose: plates have a
 * raised lip and printing just inside the rim, and a free radius happily slides onto those whenever the rim
 * itself is faint (a black plate against dark clothes), which drags the centre sideways.
 * `coverage`: the share of the rim (48 angular bins) with supporting pixels, ~1 for a fully visible plate.
 * `rim`: the mean distance of those pixels from the centre; `rms`: how tightly they sit on the circle.
 * With freeR the radius is fitted too (3-parameter Gauss-Newton): only for the first frame, started within a few
 * percent of the rim so the tight band keeps the lip out.
 */
export function fitCentre(E, cx, cy, r, band = 0.06, iters = 3, freeR = false) {
  const { w, h, gx, gy, mag, thr } = E;
  let res = null;
  for (let it = 0; it < iters; it++) {
    const x0 = Math.max(1, Math.floor(cx - r * (1 + band) - 1)), x1 = Math.min(w - 2, Math.ceil(cx + r * (1 + band) + 1));
    const y0 = Math.max(1, Math.floor(cy - r * (1 + band) - 1)), y1 = Math.min(h - 2, Math.ceil(cy + r * (1 + band) + 1));
    const bins = new Uint8Array(BINS);
    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    let sw = 0, sd = 0, se = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * w + x, m = mag[k];
        if (m < thr) continue;
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
        if (d < 1 || Math.abs(d - r) > band * r) continue;
        if (Math.abs((gx[k] * dx + gy[k] * dy) / (m * d)) < 0.85) continue;
        const J = [-dx / d, -dy / d, -1], e = d - r;
        for (let a = 0; a < 3; a++) { g[a] -= m * J[a] * e; for (let b = 0; b < 3; b++) N[a][b] += m * J[a] * J[b]; }
        sw += m; sd += m * d; se += m * e * e; n++;
        bins[Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS] = 1;
      }
    }
    let cov = 0;
    for (const b of bins) cov += b;
    const fail = { x: cx, y: cy, r, rim: r, coverage: cov / BINS, n, fitted: false };
    if (n < 12) return fail;
    let ux, uy, ur = 0;
    if (freeR) {
      const u = solve3(N, g);
      if (!u) return fail;
      [ux, uy, ur] = u;
    } else {
      const det = N[0][0] * N[1][1] - N[0][1] * N[1][0];
      if (det <= 1e-9) return fail;
      ux = (N[1][1] * g[0] - N[0][1] * g[1]) / det;
      uy = (N[0][0] * g[1] - N[1][0] * g[0]) / det;
    }
    const lim = 0.1 * r;
    cx += Math.max(-lim, Math.min(lim, ux));
    cy += Math.max(-lim, Math.min(lim, uy));
    r += Math.max(-0.05 * r, Math.min(0.05 * r, ur));
    res = { x: cx, y: cy, r, rim: sd / sw, rms: Math.sqrt(se / sw), coverage: cov / BINS, n, fitted: true };
    if (Math.hypot(ux, uy, ur) < 0.01) break;
  }
  return res;
}

/**
 * Find the plate around a tap. `img` is a crop around the tap; (tx, ty) the tap in it; radii in its pixels.
 * Every circle centred near the tap is a candidate: hub, printing, lip, rim. The tap is on the plate's middle,
 * and the plate's rim is the crispest, most complete circle there. Raw vote strength can't decide (a rim half
 * hidden by dark clothes or a dark floor scores well below the hub), and neither can size (big circles through
 * clutter collect enough stray edges to look complete): quality = coverage × tightness does.
 */
export function detectAt(img, tx, ty, rMin, rMax, debug = false) {
  const E = edgeMap(img);
  tx -= 0.5; ty -= 0.5;
  const radii = [];
  for (let r = rMin; r <= rMax; r *= 1.02) radii.push(r);
  const R = Math.max(12, 0.35 * rMin + 24);
  const win = { x0: Math.max(1, Math.round(tx - R)), y0: Math.max(1, Math.round(ty - R)), x1: Math.min(E.w - 2, Math.round(tx + R)), y1: Math.min(E.h - 2, Math.round(ty + R)) };
  const cands = peaks(E, radii, win, { x: tx, y: ty, sigma: R });
  const best = Math.max(...cands.map((c) => c.s));
  // local peaks in radius only: a radius just past the rim scores nearly as well as the rim itself
  const local = cands.filter((c, i) => c.s >= 0.15 * best && (i === 0 || c.s >= cands[i - 1].s) && (i === cands.length - 1 || c.s >= cands[i + 1].s));
  const fits = [];
  for (const c of local) {
    const f = fitCentre(E, c.x, c.y, c.r, 0.05, 8, true);
    if (f && f.fitted && Math.hypot(f.x - tx, f.y - ty) < 0.6 * f.r) fits.push(f);
  }
  // quality: how much of the rim has edge pixels, times how tightly they sit on it. A real rim is a crisp line;
  // big circles through clutter (body, floor, wall seams) collect scattered edges that fill the band
  for (const f of fits) f.q = f.coverage * Math.max(0, 1 - f.rms / (0.05 * f.r));
  fits.sort((a, b) => b.r - a.r);
  const qBest = Math.max(0, ...fits.map((f) => f.q));
  if (debug) console.log("fits:", fits.map((f) => `r ${f.r.toFixed(1)} cov ${f.coverage.toFixed(2)} rms/r ${(f.rms / f.r).toFixed(3)} q ${f.q.toFixed(2)}`).join(" | "));
  // the best-quality circle; a larger one only on a near-tie (the rim just outside a crisp lip)
  const pick = fits.find((f) => f.q >= 0.92 * qBest && f.coverage >= 0.4);
  if (pick) return { x: pick.x + 0.5, y: pick.y + 0.5, r: pick.r, coverage: pick.coverage };
  const c = cands.find((k) => k.s === best);
  return { x: c.x + 0.5, y: c.y + 0.5, r: c.r, coverage: 0 };
}

/**
 * Follows the plate frame to frame. Per frame: `roi(t)` says which part of the video to crop and how far to
 * scale it (so the plate is PROC_R pixels across), the caller crops it, `update(img, roi, t)` finds the plate.
 * Positions are in video pixels; t is the video's media time.
 */
export class PlateTracker {
  constructor(x, y, r, W, H) {
    this.r0 = r; this.r = r; this.W = W; this.H = H;
    this.last = { t: null, x, y };
    this.prev = null;
    this.lost = 0;
  }
  predict(t) {
    const L = this.last, P = this.prev;
    if (L.t === null || !P) return { x: L.x, y: L.y, vx: 0, vy: 0, h: 0 };
    const dt = L.t - P.t;
    const vx = dt > 0 ? (L.x - P.x) / dt : 0, vy = dt > 0 ? (L.y - P.y) / dt : 0;
    // coast on the last velocity for at most 0.1 s; after that, widen the search instead of flying off
    const h = Math.min(t - L.t, 0.1);
    return { x: L.x + vx * h, y: L.y + vy * h, vx, vy, h };
  }
  roi(t) {
    const p = this.predict(t);
    const move = Math.hypot(p.vx, p.vy) * (p.h || 0);
    const search = Math.min(1.6 * this.r, (0.3 * this.r + 0.5 * move) * (1 + 0.5 * Math.min(this.lost, 4)));
    const half = Math.min(this.r * 1.2 + search, Math.min(this.W, this.H) / 2);
    const sw = 2 * half, sh = 2 * half;
    const sx = clamp(p.x - half, 0, this.W - sw), sy = clamp(p.y - half, 0, this.H - sh);
    const scale = PROC_R / this.r;
    return { sx, sy, sw, sh, w: Math.max(8, Math.round(sw * scale)), h: Math.max(8, Math.round(sh * scale)), px: p.x, py: p.y, search };
  }
  update(img, roi, t) {
    const E = edgeMap(img);
    const k = img.width / roi.sw; // processing px per video px
    const r = this.r * k, cx = (roi.px - roi.sx) * k - 0.5, cy = (roi.py - roi.sy) * k - 0.5, sr = Math.max(2, roi.search * k);
    const reach = Math.ceil(sr * 1.6);
    const win = { x0: Math.max(1, Math.floor(cx - reach)), y0: Math.max(1, Math.floor(cy - reach)), x1: Math.min(E.w - 2, Math.ceil(cx + reach)), y1: Math.min(E.h - 2, Math.ceil(cy + reach)) };
    let res = null;
    if (win.x1 > win.x0 + 2 && win.y1 > win.y0 + 2) {
      const cands = peaks(E, [0.94 * r, r, 1.06 * r], win, { x: cx, y: cy, sigma: sr });
      const c = cands.reduce((a, b) => (b.s > a.s ? b : a));
      res = fitCentre(E, c.x, c.y, r, 0.06);
      // then let the radius move too, inside the same tight band: the plate's size on screen changes when
      // the camera is close or tilted (it gets further away as it rises), but the band keeps the lip out
      if (res && res.fitted) {
        const g = fitCentre(E, res.x, res.y, r, 0.06, 4, true);
        if (g && g.fitted && Math.abs(g.r - r) < 0.06 * r && g.coverage >= 0.9 * res.coverage) res = g;
      }
    }
    const ok = !!res && res.fitted && res.coverage >= 0.4;
    if (ok) {
      const x = roi.sx + (res.x + 0.5) / k, y = roi.sy + (res.y + 0.5) / k, rv = res.r / k;
      this.prev = this.last.t === null ? null : this.last;
      this.last = { t, x, y };
      this.r = clamp(this.r + 0.5 * (rv - this.r), 0.55 * this.r0, 1.6 * this.r0);
      this.lost = 0;
      return { t, x, y, r: rv, ok: true, conf: res.coverage };
    }
    this.lost++;
    return { t, x: roi.px, y: roi.py, r: this.r, ok: false, conf: res ? res.coverage : 0 };
  }
}
