/* From the tracked plate (and the body, when tracked) to the lift: which lift it is, its stages or reps,
 * measurements and checks.
 *
 * Lifts
 *   snatch, clean     one pull from the floor: first pull, transition, second pull, turnover, catch, recovery
 *                     (and a jerk after a clean). Without the body the first pull / transition split comes
 *                     from the dip in bar speed, when there is one, else the first pull ends where the bar is
 *                     furthest back.
 *   squat, bench      reps that go down first: lowering, pause, lifting (each leg while the bar moves > 0.02 m/s)
 *   deadlift, press   reps that go up first: lifting, pause (lockout), lowering
 * Recognised from the body when it's tracked (lying down; bar low, at the hips or at the shoulders; how fast
 * and which way the bar moves), from the bar alone otherwise, or chosen by the user.
 *
 * Coordinates: X metres forward (the way the lifter faces; toward the head on a bench), H metres up. For lifts
 * from the floor H is the bar centre's height above the floor (it starts there, at the plate's radius);
 * otherwise it's measured from where the bar started. Scale comes from the plate: a bumper is 450 mm across.
 *
 * Texts come from the catalog (i18n.js), in the language set when analyse() runs; names (LIFTS, STAGES, PATH_TYPES)
 * are looked up when read, so importing this module needs no language yet.
 */
import { tr, num } from "./i18n.js";

/** { id: its name }, the name read from the catalog each time */
const names = (prefix, ids) => Object.freeze(Object.defineProperties({}, Object.fromEntries(ids.map((id) => [id, { enumerable: true, get: () => tr(prefix + id) }]))));
const stage = (id, slot) => ({ get name() { return tr(`stage.${id}`); }, slot });

export const STAGES = {
  first: stage("first", 1),
  pull: stage("pull", 1),
  transition: stage("transition", 2),
  second: stage("second", 3),
  turnover: stage("turnover", 4), // peak speed to peak height: pulling under the still-rising bar
  catch: stage("catch", 5),       // peak height until the bar stops dropping
  recovery: stage("recovery", 6),
  // rep lifts use the first three slots only (they are validated against each other in any order)
  up: stage("up", 1),
  down: stage("down", 2),
  pause: stage("pause", 3),
};

export const LIFTS = names("lift.", ["snatch", "clean", "deadlift", "squat", "bench", "press"]);

// MediaPipe pose landmark indices
export const LM = {
  nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};

/* ------------------------------------------------------------------ signal helpers */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function median(a) {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2])) : NaN;
}
/** linear interpolation of (t, v) samples onto the grid T; holds the ends */
function resample(t, v, T) {
  const out = new Float64Array(T.length);
  let j = 0;
  for (let i = 0; i < T.length; i++) {
    const x = T[i];
    while (j < t.length - 2 && t[j + 1] < x) j++;
    if (x <= t[0]) out[i] = v[0];
    else if (x >= t[t.length - 1]) out[i] = v[t.length - 1];
    else { const u = (x - t[j]) / (t[j + 1] - t[j] || 1); out[i] = v[j] + (v[j + 1] - v[j]) * u; }
  }
  return out;
}
/** 2nd-order Butterworth low-pass, run forwards and backwards (no lag; 4th-order response) */
export function filtfilt(x, fc, fs) {
  const n = x.length;
  if (n < 8 || fc >= fs / 2.2) return Float64Array.from(x);
  const K = Math.tan((Math.PI * fc) / fs), Q = Math.SQRT1_2, nrm = 1 / (1 + K / Q + K * K);
  const b0 = K * K * nrm, b1 = 2 * b0, b2 = b0, a1 = 2 * (K * K - 1) * nrm, a2 = (1 - K / Q + K * K) * nrm;
  const pad = Math.min(n - 1, Math.round(fs / fc) * 2);
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) { ext[i] = 2 * x[0] - x[pad - i]; ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i]; }
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  const run = (a) => {
    const y = new Float64Array(a.length);
    y[0] = y[1] = a[0];
    for (let i = 2; i < a.length; i++) y[i] = b0 * a[i] + b1 * a[i - 1] + b2 * a[i - 2] - a1 * y[i - 1] - a2 * y[i - 2];
    return y;
  };
  const f = run(ext).reverse(), g = run(f).reverse();
  return g.slice(pad, pad + n);
}
function deriv(x, fs) {
  const n = x.length, d = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) d[i] = ((x[i + 1] - x[i - 1]) * fs) / 2;
  if (n > 1) { d[0] = (x[1] - x[0]) * fs; d[n - 1] = (x[n - 1] - x[n - 2]) * fs; }
  return d;
}
function argmax(a, i0, i1) { let b = i0; for (let i = i0; i <= i1; i++) if (a[i] > a[b]) b = i; return b; }
function argmin(a, i0, i1) { let b = i0; for (let i = i0; i <= i1; i++) if (a[i] < a[b]) b = i; return b; }
const angle = (a, b, c) => { // angle at b, degrees
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  return (Math.acos(clamp((v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1), -1, 1)) * 180) / Math.PI;
};

/* ------------------------------------------------------------------ body */
/** which side of the body faces the camera: MediaPipe's z is smaller nearer the camera */
function nearSide(samples) {
  let l = 0, r = 0, n = 0;
  for (const s of samples) {
    const p = s.pose;
    if (!p) continue;
    l += p[LM.lHip].z + p[LM.lKnee].z + p[LM.lAnkle].z;
    r += p[LM.rHip].z + p[LM.rKnee].z + p[LM.rAnkle].z;
    n++;
  }
  return n < 5 ? null : l <= r ? "l" : "r";
}
function facingFromBody(samples) {
  let s = 0, n = 0;
  for (const q of samples) {
    const p = q.pose;
    if (!p) continue;
    for (const [toe, heel] of [[LM.lToe, LM.lHeel], [LM.rToe, LM.rHeel]]) {
      if (p[toe].v > 0.5 && p[heel].v > 0.5) { s += Math.sign(p[toe].x - p[heel].x); n++; }
    }
  }
  return n >= 6 && Math.abs(s) / n > 0.3 ? Math.sign(s) : 0;
}

/* ------------------------------------------------------------------ shared front end */
/** time grid, smoothed plate track, per-frame scale, body helpers: everything both analysers start from */
function prepare(samples, opts) {
  const slow = opts.slowmo > 0 ? opts.slowmo : 1;
  const plate = (opts.plateMm || 450) / 1000;
  const good = samples.filter((s) => s.ok);
  if (good.length < 10 || good.length < 0.3 * samples.length) return { error: tr("error.plateLost") };
  const tv0 = samples[0].t;
  const real = (tv) => (tv - tv0) / slow;
  const dts = [];
  for (let i = 1; i < samples.length; i++) { const d = real(samples[i].t) - real(samples[i - 1].t); if (d > 1e-5) dts.push(d); }
  const fs = clamp(Math.round(1 / median(dts)), 20, 480);
  const n = Math.floor(real(samples[samples.length - 1].t) * fs) + 1;
  if (n < 0.5 * fs) return { error: tr("error.tooShort") };
  const T = Float64Array.from({ length: n }, (_, i) => i / fs);
  const gt = good.map((s) => real(s.t));
  // 10 Hz keeps the peak of a second pull (within ~3% of a sharp one) while calming tracking noise. Run forwards and
  // backwards, a 2nd-order filter's −3 dB point drops to ~0.8 of its setting: about 8 Hz at 60 fps, near the optimum
  // for 60 Hz data (Yu et al. 1999: (1.4845 + 0.1523·√fs)² Hz). Slow motion takes that optimum once it passes 10 Hz
  // (above ~120 fps), capped at 15: peak speed then loses ~1% instead of 2%.
  const fc = Math.min(Math.max(10, Math.min(15, (1.4845 + 0.1523 * Math.sqrt(fs)) ** 2)), fs / 4);
  const xs = filtfilt(resample(gt, good.map((s) => s.x), T), fc, fs);
  const ys = filtfilt(resample(gt, good.map((s) => s.y), T), fc, fs);
  // gaps: grid points more than 0.1 s from any tracked frame
  const gap = new Uint8Array(n);
  { let j = 0; for (let i = 0; i < n; i++) { while (j < gt.length - 1 && gt[j + 1] <= T[i]) j++; const d = Math.min(Math.abs(T[i] - gt[j]), j + 1 < gt.length ? Math.abs(gt[j + 1] - T[i]) : 9); gap[i] = d > 0.1 ? 1 : 0; } }

  /* scale: the plate is `plate` m across, so its size on screen gives metres per pixel. Frame by frame, because
   * that size changes when the camera is close or tilted (the plate moves away from a low camera as it rises):
   * each frame's movement is converted at that frame's scale. */
  const rs = filtfilt(resample(gt, good.map((s) => s.r), T), Math.min(2, fs / 4), fs);
  const Xr = new Float64Array(n), Hr = new Float64Array(n); // + X = to the right in the picture, + H = up
  for (let i = 1; i < n; i++) {
    const m = plate / (rs[i] + rs[i - 1]);
    Xr[i] = Xr[i - 1] + (xs[i] - xs[i - 1]) * m;
    Hr[i] = Hr[i - 1] - (ys[i] - ys[i - 1]) * m;
  }
  const rpx = median(good.map((s) => s.r)), mpp = plate / 2 / rpx;

  const side = nearSide(samples);
  const posed = samples.filter((s) => s.pose);
  const L = (p, name) => p[LM[side + name]];
  const poseAt = (i) => { // the pose of the frame nearest grid index i
    const tv = tv0 + T[i] * slow;
    let lo = 0, hi = posed.length - 1;
    if (hi < 0) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (posed[mid].t < tv) lo = mid; else hi = mid; }
    const b = Math.abs(posed[lo].t - tv) <= Math.abs(posed[hi].t - tv) ? posed[lo] : posed[hi];
    return Math.abs(b.t - tv) < 0.15 * slow ? b.pose : null;
  };
  return { samples, slow, plate, tv0, real, fs, n, T, xs, ys, gap, rs, Xr, Hr, rpx, mpp, side, L, poseAt, poseCover: posed.length / samples.length };
}

const seen = (...pts) => pts.every((p) => p && p.v > 0.3);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// A front rack can hide the face behind the plate. Look for a sustained arm position at the stand.
function finishPosition(sig, stand, facing) {
  if (!sig.side) return null;
  const votes = [];
  for (const s of sig.samples) {
    const t = sig.real(s.t);
    if (Math.abs(t - stand) > 0.15 || !s.pose) continue;
    const joint = (name) => sig.L(s.pose, name);
    const sh = joint("Shoulder"), el = joint("Elbow"), wr = joint("Wrist"), hp = joint("Hip");
    if (![sh, el, wr, hp].every(p => p.v >= 0.5)) continue;
    const torso = distance(sh, hp), bend = angle(sh, el, wr);
    if (torso <= 0 || distance(sh, el) < 0.1 * torso) continue;
    const height = (sh.y - wr.y) / torso;
    const overhead = height > 0.65 && el.y < sh.y && bend > 145;
    const rack = Math.abs(height) < 0.45 && facing * (el.x - sh.x) > 0.12 * torso && bend < 155;
    votes.push({ t, type: overhead ? "snatch" : rack ? "clean" : null });
  }
  for (const type of ["snatch", "clean"]) {
    const agree = votes.filter(v => v.type === type);
    if (agree.length >= 3 && agree.length >= 0.7 * votes.length && agree.at(-1).t - agree[0].t >= 0.06) return type;
  }
  return null;
}
/** torso lean from vertical, degrees: + forward (shoulders ahead of the hips, the way the lifter faces), − back */
const leanOf = (sh, hp, facing) => (Math.atan2(facing * (sh.x - hp.x), hp.y - sh.y) * 180) / Math.PI;

/** the body at rest before the bar first moves: lying down? where the bar sits on it (0 ankles .. 1 shoulders) */
function bodyAtRest(sig, i0, i1) {
  const { side, L, poseAt, ys } = sig;
  if (!side) return null;
  const torso = [], onBody = [], above = [];
  for (let i = i0; i <= i1; i += Math.max(1, Math.round(sig.fs / 30))) {
    const p = poseAt(i);
    if (!p) continue;
    const sh = L(p, "Shoulder"), hp = L(p, "Hip"), an = L(p, "Ankle");
    if (!seen(sh, hp)) continue;
    const tl = Math.hypot(sh.x - hp.x, sh.y - hp.y);
    torso.push((Math.atan2(Math.abs(sh.x - hp.x), Math.abs(hp.y - sh.y)) * 180) / Math.PI);
    above.push((sh.y - ys[i]) / (tl || 1)); // bar above the shoulders, in torso lengths (image y grows down)
    if (seen(an) && an.y - sh.y > 20) onBody.push((an.y - ys[i]) / (an.y - sh.y));
  }
  if (torso.length < 3) return null;
  // lying = torso flat AND the bar held above the shoulders. A deadlift set-up has a flat torso too, but the
  // bar hangs below the shoulders.
  return { lying: median(torso) > 55 && median(above) > 0.3, onBody: onBody.length >= 3 ? median(onBody) : null };
}

/**
 * Which lift. Returns {lift, from, why}; lift "olympic" means snatch or clean, settled by the olympic analyser
 * from where the bar ends up, unless the user chose one. Squat vs press from the bar's biggest trip from rest,
 * not its first move: unracking lifts the bar a little before a squat goes down.
 */
function recognise(sig, chosen) {
  if (chosen && LIFTS[chosen]) return { lift: chosen, from: "you", why: tr("why.chosen") };
  const { n, fs, Hr, side, L, poseAt, ys } = sig;
  const h0 = median(Hr.slice(0, Math.max(1, Math.round(0.2 * fs))));
  const iMove = Hr.findIndex((h) => Math.abs(h - h0) > 0.04);
  if (iMove < 0) return { lift: null };
  let down = 0, up = 0;
  for (let i = 0; i < n; i++) { down = Math.max(down, h0 - Hr[i]); up = Math.max(up, Hr[i] - h0); }
  const squatty = down > 0.2 && down > up;
  // a pull: where the bar ends up says what it was. Deadlifts finish at the hips, cleans at the shoulders,
  // snatches overhead. Speed can't tell: a fast light deadlift and a slow heavy clean overlap.
  const iTop = argmax(Hr, iMove, Math.min(n - 1, iMove + Math.round(3 * fs)));
  const rise = Hr[iTop] - h0;
  let topOnBody = null;
  if (side) {
    const v = [];
    for (let i = iTop; i <= Math.min(n - 1, iTop + Math.round(0.3 * fs)); i++) {
      const p = poseAt(i);
      const sh = p && L(p, "Shoulder"), an = p && L(p, "Ankle");
      if (p && seen(sh, an) && an.y - sh.y > 20) v.push((an.y - ys[i]) / (an.y - sh.y));
    }
    if (v.length >= 2) topOnBody = median(v);
  }
  const pull = (from) => { // from: floor, hips, upFirst
    const where = tr(`why.where.${from}`);
    if (topOnBody !== null) return topOnBody < 0.85 ? { lift: "deadlift", from: "body", why: tr("why.finishesHips", { where }) } : { lift: "olympic", from: "body", why: tr("why.finishesHigh", { where }) };
    return { lift: rise < 0.9 ? "deadlift" : "olympic", from: "bar", why: tr("why.rises", { where, cm: Math.round(rise * 100) }) };
  };
  const body = bodyAtRest(sig, Math.max(0, iMove - Math.round(0.5 * fs)), iMove);
  if (body) {
    if (body.lying) return { lift: "bench", from: "body", why: tr("why.lying") };
    if (body.onBody !== null) {
      if (body.onBody < 0.45) return pull("floor");
      if (body.onBody > 0.72) return squatty ? { lift: "squat", from: "body", why: tr("why.squatBody") } : { lift: "press", from: "body", why: tr("why.pressBody") };
      return pull("hips");
    }
  }
  // the bar alone: which way it travels furthest, and how far a pull rises
  if (squatty) return { lift: "squat", from: "bar", why: tr("why.squatBar") };
  const r = pull("upFirst");
  return { ...r, from: "bar" };
}

/* ------------------------------------------------------------------ the analysis */
/**
 * samples: [{t: video media time s, x, y, r: plate centre and radius in video px, ok, pose?: 33 × {x, y, z, v} in video px}]
 * opts: {plateMm=450, slowmo=1, facing: 1 right | -1 left | 0 auto, lift: 'auto' | one of LIFTS, kg: the load, for power}
 */
export function analyse(samples, opts = {}) {
  if (opts.facingOverride != null) opts = { ...opts, facing: opts.facingOverride };
  const sig = prepare(samples, opts);
  if (sig.error) return sig;
  const chosen = opts.lift && opts.lift !== "auto" ? opts.lift : opts.type && opts.type !== "auto" ? opts.type : null;
  const mv = recognise(sig, chosen);
  if (!mv.lift) return { error: tr("error.neverMoves") };
  const R = mv.lift === "olympic" || mv.lift === "snatch" || mv.lift === "clean"
    ? olympic(sig, opts, mv.lift === "olympic" ? null : mv.lift)
    : reps(sig, opts, mv.lift);
  if (R.error) return R;
  const { n, fs, T, tv0, slow } = sig;
  if (opts.kg > 0) addPower(R, opts.kg, fs);
  return {
    ...R, liftFrom: mv.lift === "olympic" ? R.typeFrom : mv.from, liftWhy: mv.why,
    fs, n, T, xs: sig.xs, ys: sig.ys, rs: sig.rs, gap: sig.gap, tv0, slow, mpp: sig.mpp, rpx: sig.rpx, plate: sig.plate, side: sig.side, poseCover: sig.poseCover,
    tVideo: (i) => tv0 + T[i] * slow, indexAt: (tv) => clamp(Math.round(((tv - tv0) / slow) * fs), 0, n - 1),
  };
}

/* ------------------------------------------------------------------ power, with the load */
const G = 9.81;
/**
 * The force on the bar, m(g + a), and the power going into it: the rate of change of the bar's energy,
 * m·g·h + ½m·v² (forward and up), smoothed at 6 Hz. That equals F·v, but smoothing the product rather than the
 * acceleration alone keeps a smoothed acceleration from being multiplied by a sharper speed, which read peak power
 * 3–5% high. Acceleration is the bar speed differentiated once more and smoothed at 6 Hz: a second derivative of
 * tracking noise would swamp it. Snatch and clean: over the pull, lift-off to peak speed. Rep lifts: over each rep's
 * lifting phase, where the mean is mean concentric power (≈ m·g·rise / time, as the bar starts and ends at rest).
 * This is power into the bar only, not the lifter's own (which includes moving the body): the two are not
 * interchangeable (Hori 2007, Lake 2012).
 */
function addPower(R, kg, fs) {
  const fc = Math.min(6, fs / 4), ay = filtfilt(deriv(R.vy, fs), fc, fs);
  const n = R.vy.length, E = new Float64Array(n), F = new Float64Array(n);
  for (let i = 0; i < n; i++) { F[i] = kg * (ay[i] + G); E[i] = kg * (G * R.H[i] + 0.5 * (R.vx[i] ** 2 + R.vy[i] ** 2)); }
  const P = filtfilt(deriv(E, fs), fc, fs);
  const mean = (a, i0, i1) => { let s = 0; for (let i = i0; i <= i1; i++) s += a[i]; return s / Math.max(1, i1 - i0 + 1); };
  const W = (w) => `${Math.round(w)}`;
  const put = (label, value, unit, note) => R.metrics.push({ group: tr("group.power"), label, value, unit, note });
  R.P = P; R.F = F; R.kg = kg;
  put(tr("metric.load.label"), kg, "kg", tr("metric.load.note"));
  if (!R.reps) {
    const i0 = R.ev.liftoff, i1 = R.ev.vmax, iP = argmax(P, i0, i1), iF = argmax(F, i0, i1), pull = mean(P, i0, i1);
    put(tr("metric.peakPower.label"), P[iP], "W", tr("metric.peakPower.note", { t: num((iP - i0) / fs, 2), wkg: num(P[iP] / kg, 1) }));
    put(tr("metric.pullPower.label"), pull, "W", tr("metric.pullPower.note"));
    put(tr("metric.peakForce.label"), F[iF], "N", tr("metric.peakForce.note", { x: num(F[iF] / (kg * G), 1) }));
    put(tr("metric.energy.label"), 0.5 * kg * (R.vx[i1] ** 2 + R.vy[i1] ** 2) + kg * G * (R.H[i1] - R.H[i0]), "J", tr("metric.energy.note"));
    R.tiles.push(
      { label: tr("tile.peakPower"), value: W(P[iP]), unit: "W", note: tr("tile.peakPower.note", { wkg: num(P[iP] / kg, 1) }) },
      { label: tr("tile.pullPower"), value: W(pull), unit: "W", note: tr("tile.pullPower.note") },
    );
    return;
  }
  for (const r of R.reps) { r.power = mean(P, r.u0, r.u1); r.peakPower = P[argmax(P, r.u0, r.u1)]; }
  const done = R.reps.filter((r) => r.power !== undefined);
  if (!done.length) return;
  const best = done.reduce((a, b) => (b.power > a.power ? b : a)), peak = done.reduce((a, b) => (b.peakPower > a.peakPower ? b : a));
  put(tr("metric.bestPower.label"), best.power, "W", tr("metric.bestPower.note", { n: best.n }));
  put(tr("metric.peakPower.label"), peak.peakPower, "W", tr("metric.rep", { n: peak.n }));
  put(tr("metric.meanPower.label"), done.reduce((a, r) => a + r.power, 0) / done.length, "W");
  if (done.length > 1) put(tr("metric.powerLoss.label"), (100 * (best.power - done[done.length - 1].power)) / best.power, "%");
  R.tiles.push(
    { label: tr("tile.bestPower"), value: W(best.power), unit: "W", note: tr("tile.liftingRep", { n: best.n }) },
    { label: tr("tile.peakPower"), value: W(peak.peakPower), unit: "W", note: tr("tile.rep", { n: peak.n }) },
  );
}

/* ------------------------------------------------------------------ snatch and clean */
/** bar path types (Vorobyev 1978, Hiskia 1997, as used by Cunanan 2020), with how common each was among the
 * lifters at the 2015 Worlds. The reference is a vertical line through the bar at lift-off. */
export const PATH_TYPES = names("pathType.", ["1", "2", "3", "4"]);
/** the bar's back-and-forth from i0 to i1 as legs toward the lifter (T) and away (A), ignoring wobbles under h
 * metres, and the bar path type it makes (null when it fits none) */
export function pathType(X, i0, i1, h = 0.01) {
  const legs = [];
  let dir = 0, ext = X[i0];
  for (let i = i0 + 1; i <= i1; i++) {
    const x = X[i];
    if (dir === 0) { if (Math.abs(x - X[i0]) > h) { dir = Math.sign(x - X[i0]); ext = x; legs.push({ dir, end: x }); } }
    else if (dir * (x - ext) > 0) { ext = x; legs[legs.length - 1].end = x; }
    else if (dir * (ext - x) > h) { dir = -dir; ext = x; legs.push({ dir, end: x }); }
  }
  const seq = legs.map((l) => (l.dir > 0 ? "A" : "T")).join("");
  const type = seq === "TAT" ? (legs[1].end - X[i0] > 0 ? 1 : 2) : seq === "ATAT" ? 3 : legs.length >= 5 ? 4 : null;
  return { type, seq };
}

function olympic(sig, opts, forced) {
  const { samples, slow, plate, tv0, real, fs, n, T, gap, rs, Xr, Hr } = sig;
  /* events. Heights first against the start of the clip, then against where the bar sat just before lift-off
   * (lifters roll the bar in during the set-up) */
  const k0 = Math.max(1, Math.min(n, Math.round(0.2 * fs)));
  let H = Hr.map((v) => v - median(Hr.slice(0, k0)) + plate / 2);
  let vy = deriv(H, fs);
  const H0 = plate / 2;
  const i3 = H.findIndex((h) => h > H0 + 0.03);
  if (i3 < 0) return { error: tr("error.neverLeavesFloor") };
  let iLift = i3;
  while (iLift > 0 && vy[iLift - 1] > 0.05) iLift--;
  const rest = [Math.max(0, iLift - Math.round(0.25 * fs)), iLift + 1];
  const xRest = median(Xr.slice(...rest)), hRest = median(Hr.slice(...rest));
  H = Hr.map((v) => v - hRest + plate / 2);
  const Xraw = Xr.map((v) => v - xRest);
  vy = deriv(H, fs);
  const iV = argmax(vy, iLift, Math.min(n - 1, iLift + Math.round(1.6 * fs)));
  if (vy[iV] < 0.3) return { error: tr("error.neverFast") };
  // After peak speed the bar slows while the lifter pulls under it. Usually it then drops onto the lifter: peak
  // height where it stops rising, the catch at its lowest. Sometimes it's met on the way up (a high power catch):
  // it only slows and the stand-up carries it on up. Then peak and catch are the moment it was slowest.
  const pEnd = Math.min(n - 1, iV + Math.round(0.6 * fs));
  let iPeak = null, iCatch, metRising = false;
  for (let i = iV; i <= pEnd; i++) if (vy[i] <= 0) { iPeak = i; break; }
  if (iPeak !== null) {
    // the catch: the bar stops dropping, within 1 s of its peak (a bar dropped after the lift never counts)
    const cEnd = Math.min(n - 1, iPeak + Math.round(1.0 * fs));
    iCatch = iPeak + 1;
    while (iCatch < cEnd && !(vy[iCatch] >= 0 && vy[iCatch - 1] < 0)) iCatch++;
    if (iCatch >= cEnd) iCatch = argmin(H, iPeak, cEnd);
  } else {
    const wEnd = Math.min(n - 2, iV + Math.round(0.8 * fs));
    let i = iV + 1;
    while (i < wEnd && !(vy[i] <= vy[i - 1] && vy[i] <= vy[i + 1])) i++;
    iPeak = iCatch = i;
    metRising = true;
  }
  // standing: the stand-up ends where the bar stops rising for good (not a pause at a sticking point), within 4 s.
  // A bar that never rises out of the catch: where it first stays still.
  const still = (i) => { const m = Math.round(0.25 * fs); if (i + m > n) return false; for (let j = i; j < i + m; j++) if (Math.abs(vy[j]) > 0.1) return false; return true; };
  const sEnd = Math.min(n - 1, iCatch + Math.round(4 * fs)), settle = Math.round(0.6 * fs);
  let iStand = null, rose = false;
  for (let i = iCatch + 1; i <= sEnd; i++) {
    if (H[i] > H[iCatch] + 0.02) rose = true;
    if (rose && vy[i] <= 0.03 && vy[i - 1] > 0.03) {
      let more = H[i];
      for (let j = i; j <= Math.min(n - 1, i + settle); j++) more = Math.max(more, H[j]);
      if (more < H[i] + 0.03) { iStand = i; break; }
    }
  }
  if (iStand === null) { iStand = iCatch; for (let i = iCatch; i <= sEnd; i++) if (still(i)) { iStand = i; break; } }
  const sizeChange = (() => { let lo = Infinity, hi = 0; for (let i = iLift; i <= iStand; i++) { lo = Math.min(lo, rs[i]); hi = Math.max(hi, rs[i]); } return hi / lo - 1; })();

  /* body: knee angle of the near side, smoothed on the same grid */
  const side = nearSide(samples);
  let knee = null, hipA = null, poseCover = 0;
  const P = (s, name) => s.pose[LM[side + name]];
  if (side) {
    const withPose = samples.filter((s) => s.pose && P(s, "Hip").v > 0.3 && P(s, "Knee").v > 0.3 && P(s, "Ankle").v > 0.3);
    poseCover = withPose.length / samples.length;
    if (withPose.length >= 10) {
      const pt = withPose.map((s) => real(s.t));
      knee = filtfilt(resample(pt, withPose.map((s) => angle(P(s, "Hip"), P(s, "Knee"), P(s, "Ankle"))), T), 6, fs);
      hipA = filtfilt(resample(pt, withPose.map((s) => angle(P(s, "Shoulder"), P(s, "Hip"), P(s, "Knee"))), T), 6, fs);
    }
  }
  const poseAt = (i) => { // nearest frame's pose to grid index i
    const tv = tv0 + T[i] * slow;
    let b = null, bd = 1e9;
    for (const s of samples) { if (!s.pose) continue; const d = Math.abs(s.t - tv); if (d < bd) { bd = d; b = s; } }
    return b && bd < 0.15 * slow ? b.pose : null;
  };

  /* which way the lifter faces */
  let facing = opts.facing === 1 || opts.facing === -1 ? opts.facing : 0, facingFrom = "you";
  if (!facing) { facing = facingFromBody(samples); facingFrom = "body"; }
  if (!facing) {
    // the bar comes back toward the lifter in the first pull more than it drifts away
    let lo = 0, hi = 0;
    for (let i = iLift; i <= iV; i++) { lo = Math.min(lo, Xraw[i]); hi = Math.max(hi, Xraw[i]); }
    facing = -lo >= hi ? 1 : -1; facingFrom = "bar";
  }
  const X = Xraw.map((v) => v * facing);
  const vx = deriv(X, fs);
  const speed = X.map((_, i) => Math.hypot(vx[i], vy[i]));

  /* first pull / transition split: from the knees (first most extended → most bent again: Baumann 1988, Gourgoulis
   * 2000, Harbili 2012); else from a dip in bar speed (its first peak ends the first pull, its low the transition:
   * Sandau 2020); else, as most good lifters show no dip, where the bar is furthest back before peak speed (Nagao
   * 2019), with the transition left inside the second pull */
  let iFirst = null, iTrans = null, splitBy = null;
  const a0 = iLift + Math.round(0.1 * fs), a1 = iV - Math.round(0.03 * fs);
  if (knee && a1 > a0 + 2) {
    for (let i = a0 + 1; i < a1; i++) {
      if (knee[i] >= knee[i - 1] && knee[i] > knee[i + 1]) {
        const j = argmin(knee, i, a1);
        if (knee[i] - knee[j] >= 3) { iFirst = i; iTrans = j; splitBy = "knees"; break; }
      }
    }
  }
  if (iFirst === null && a1 > a0 + 2) {
    for (let i = a0 + 1; i < a1; i++) {
      if (vy[i] >= vy[i - 1] && vy[i] > vy[i + 1]) {
        const j = argmin(vy, i, a1);
        if (vy[i] - vy[j] >= 0.03) { iFirst = i; iTrans = j; splitBy = "bar speed"; break; }
      }
    }
  }
  if (iFirst === null && a1 > a0 + 2) {
    const ib = argmin(X, iLift, iV);
    if (ib > a0 && ib < a1 && X[ib] <= -0.01) { iFirst = ib; splitBy = "bar path"; }
  }
  const stages = [];
  const add = (id, i0, i1) => { if (i1 > i0) stages.push({ id, ...STAGES[id], i0, i1, dur: (i1 - i0) / fs }); };
  if (iTrans !== null) { add("first", iLift, iFirst); add("transition", iFirst, iTrans); add("second", iTrans, iV); }
  else if (iFirst !== null) { add("first", iLift, iFirst); add("second", iFirst, iV); }
  else add("pull", iLift, iV);
  add("turnover", iV, iPeak);
  add("catch", iPeak, iCatch);
  add("recovery", iCatch, iStand);
  const stageOf = new Int8Array(n).fill(-1);
  stages.forEach((s, k) => { for (let i = s.i0; i < s.i1; i++) stageOf[i] = k; });

  /* lift type and catch */
  let type = forced, typeFrom = "you";
  if (!type) { type = finishPosition(sig, T[iStand], facing); typeFrom = "body"; }
  if (!type) { type = H[iStand] > 1.6 ? "snatch" : "clean"; typeFrom = "bar"; }
  const catchDepth = side ? squatDepthReader(sig, facingFrom === "bar" ? 0 : facing)(T[iCatch]) : null;
  const relativeCatch = H[iCatch] / Math.max(0.5, H[iStand]) - (type === "snatch" ? 0.62 : 0.72);
  let squat = null, catchFrom = "unclear";
  if (catchDepth !== null) {
    // A very low catch paired with an apparently upright thigh (or the reverse) is ambiguous.
    const conflict = Math.abs(relativeCatch) > 0.12 && (relativeCatch < 0) !== (catchDepth > 0);
    if (Math.abs(catchDepth) > PARALLEL_BAND && !conflict) { squat = catchDepth > 0; catchFrom = "body"; }
  } else {
    if (Math.abs(relativeCatch) > 0.03) { squat = relativeCatch < 0; catchFrom = "bar"; }
  }

  /* jerk after a clean: dip, drive, catch overhead */
  let jerk = null;
  if (type === "clean" && iStand < n - Math.round(0.5 * fs)) {
    let d0 = iStand;
    while (d0 < n - 1 && vy[d0] > -0.1) d0++;
    if (d0 < n - Math.round(0.3 * fs)) {
      const dB = argmin(H, d0, Math.min(n - 1, d0 + Math.round(0.6 * fs)));
      const dV = argmax(vy, dB, Math.min(n - 1, dB + Math.round(0.5 * fs)));
      let s0 = d0;
      while (s0 > iStand && vy[s0 - 1] < -0.02) s0--;
      if (vy[dV] > 0.9 && Math.max(...H.slice(dV)) > H[iStand] + 0.2) {
        let jP = dV; while (jP < n - 1 && vy[jP] > 0) jP++;
        let jC = jP; while (jC < n - 1 && !(vy[jC] >= 0 && vy[jC - 1] < 0)) jC++;
        let split = null;
        if (side) {
          let sep = 0, leg = 0, m = 0;
          for (let i = jC; i <= Math.min(n - 1, jC + Math.round(0.3 * fs)); i += Math.max(1, Math.round(fs / 30))) {
            const p = poseAt(i);
            if (!p || p[LM.lAnkle].v < 0.3 || p[LM.rAnkle].v < 0.3) continue;
            sep = Math.max(sep, Math.abs(p[LM.lAnkle].x - p[LM.rAnkle].x));
            leg += Math.hypot(p[LM[side + "Hip"]].x - p[LM[side + "Ankle"]].x, p[LM[side + "Hip"]].y - p[LM[side + "Ankle"]].y); m++;
          }
          if (m) split = sep / (leg / m) > 0.45;
        }
        const dipSpeed = -vy[argmin(vy, s0, dB)]; // fastest down in the dip
        jerk = { iStart: s0, iDip: dB, iDrive: dV, iPeak: jP, iCatch: jC, dip: H[s0] - H[dB], dipTime: (dB - s0) / fs, dipSpeed, drive: vy[dV], drop: H[jP] - H[jC], split };
      }
    }
  }

  /* measurements */
  const minBack = (() => { let m = 0, im = iLift; for (let i = iLift; i <= iV; i++) if (X[i] < m) { m = X[i]; im = i; } return { v: m, i: im }; })();
  const maxFwd = (() => { let m = -9, im = iV; for (let i = iV; i <= iCatch; i++) if (X[i] > m) { m = X[i]; im = i; } return { v: m, i: im }; })();
  const swing = maxFwd.v - minBack.v; // the loop out in front, from the bar's furthest-back point
  const ev = {
    liftoff: iLift, first: iFirst, transition: iTrans, vmax: iV, peak: iPeak, catch: iCatch, stand: iStand, back: minBack.i, fwd: maxFwd.i,
  };
  const transLoss = iTrans !== null ? Math.max(0, vy[iFirst] - vy[iTrans]) : null;
  // the bar's position as it passes the knees: end of the first pull (from the knees or a speed dip), or ~0.5 m up
  // (the furthest-back point that ends the first pull from the bar path is behind the start by definition)
  let iKnee = iLift;
  while (iKnee < iV && H[iKnee] < 0.5) iKnee++;
  const xAtKnee = splitBy === "knees" || splitBy === "bar speed" ? X[iFirst] : X[iKnee];
  const loop = maxFwd.v - X[iCatch]; // furthest forward back to the catch
  const path = pathType(X, iLift, iCatch);
  // the angle of the first pull: start to the furthest-back point, from vertical (Stone 1998's θ1)
  const theta1 = minBack.v < -0.005 ? (Math.atan2(-minBack.v, Math.max(0.05, H[minBack.i] - H[iLift])) * 180) / Math.PI : 0;
  const heightM = opts.heightCm >= 100 && opts.heightCm <= 250 ? opts.heightCm / 100 : null;
  const sn = type === "snatch"; // the published norms below are for the snatch

  const m = [];
  const put = (group, id, value, unit, note, extra) => m.push({ group: tr(`group.${group}`), label: tr(`metric.${id}.label`), value, unit, note, ...extra });
  const elite = (id, vars) => tr(`metric.${id}.note${sn ? "Snatch" : ""}`, vars); // a snatch's note adds the elite figures
  put("bar", "peakSpeed", vy[iV], "m/s", elite("peakSpeed", { t: num((iV - iLift) / fs, 2), h: num(H[iV], 2) }));
  put("bar", "peakHeight", H[iPeak], "m", tr("metric.peakHeight.note"));
  if (heightM) put("bar", "peakHeightShare", (100 * H[iPeak]) / heightM, "%", sn ? tr("metric.peakHeightShare.noteSnatch") : undefined);
  put("bar", "catchHeight", H[iCatch], "m", tr(metRising ? "metric.catchHeight.noteRising" : "metric.catchHeight.note"));
  put("bar", "drop", (H[iPeak] - H[iCatch]) * 100, "cm", metRising ? tr("metric.drop.noteRising") : elite("drop"));
  put("bar", "standHeight", H[iStand], "m", tr(type === "snatch" ? "metric.standHeight.noteOverhead" : "metric.standHeight.noteShoulders"));
  if (transLoss !== null) put("bar", "transitionLoss", transLoss, "m/s", tr(splitBy === "knees" ? "metric.transitionLoss.noteKnees" : "metric.transitionLoss.noteSpeed"));
  put("barPath", "backInPull", -minBack.v * 100, "cm", elite("backInPull"));
  put("barPath", "angleOff", theta1, "°", elite("angleOff"));
  put("barPath", "swing", swing * 100, "cm", elite("swing"));
  put("barPath", "loop", loop * 100, "cm", elite("loop"));
  put("barPath", "catchVsStart", X[iCatch] * 100, "cm", elite("catchVsStart"));
  if (path.type) put("barPath", "pathType", path.type, "", PATH_TYPES[path.type], { category: true });
  stages.forEach((s) => m.push({ group: tr("group.timing"), label: s.name, value: s.dur, unit: "s", note: undefined }));
  put("timing", "liftoffToPeak", (iV - iLift) / fs, "s");
  put("timing", "peakToCatch", (iCatch - iV) / fs, "s");
  if (knee) {
    // angles from one camera's 2D body landmarks: approximate (even a 12-camera markerless system differs from
    // markers by ~14° in the sagittal plane, Thiele 2024). The elite figures are Harbili 2012's (69 kg, Worlds).
    const ap = tr("metric.approx");
    put("body", "kneeLiftoff", knee[iLift], "°", elite("kneeLiftoff"));
    put("body", "hipLiftoff", hipA[iLift], "°", ap);
    if (splitBy === "knees") {
      put("body", "kneeFirst", knee[iFirst], "°", sn ? tr("metric.kneeFirst.noteSnatch") : ap);
      put("body", "kneeRebend", knee[iFirst] - knee[iTrans], "°", sn ? tr("metric.kneeRebend.noteSnatch") : ap);
    }
    put("body", "kneeMax", Math.max(...knee.slice(iLift, iCatch + 1)), "°", elite("kneeMax"));
    put("body", "hipMax", Math.max(...hipA.slice(iLift, iCatch + 1)), "°", sn ? tr("metric.hipMax.noteSnatch") : ap);
  }
  if (jerk) {
    put("jerk", "jerkDip", jerk.dip * 100, "cm");
    if (heightM) put("jerk", "jerkDipShare", (100 * jerk.dip) / heightM, "%", tr("metric.jerkDipShare.note"));
    put("jerk", "jerkDipTime", jerk.dipTime, "s");
    put("jerk", "jerkDipSpeed", jerk.dipSpeed, "m/s", tr("metric.jerkDipSpeed.note"));
    put("jerk", "jerkDrive", jerk.drive, "m/s", tr("metric.jerkDrive.note"));
    if (jerk.dipSpeed > 0.1) put("jerk", "jerkRatio", jerk.drive / jerk.dipSpeed, "×", tr("metric.jerkRatio.note"));
    put("jerk", "jerkDrop", jerk.drop * 100, "cm");
  }

  /* checks: starting thresholds, meant to be tuned with a coach. Elite figures: Cunanan 2020 (2015 Worlds) and
   * Nagao 2019 (snatch). */
  const checks = [];
  const chk = (id, status, text) => checks.push({ title: tr(`check.${id}.title`), status, text });
  const xk = xAtKnee * 100;
  chk("offFloor", xk <= 1 ? "good" : xk <= 4 ? "warning" : "serious",
    tr(xk <= -2 ? "check.offFloor.back" : xk <= 1 ? "check.offFloor.straight" : "check.offFloor.away", { x: fmtSigned(xk) }));
  const sw = swing * 100;
  chk("secondPull", sw <= 8 ? "good" : sw <= 14 ? "warning" : "serious", tr(sw <= 8 ? "check.secondPull.good" : "check.secondPull.loop", { cm: num(sw, 0) }));
  if (transLoss !== null) {
    chk("transition", transLoss <= 0.05 ? "good" : transLoss <= 0.15 ? "warning" : "serious",
      transLoss <= 0.05 ? tr("check.transition.good") : tr("check.transition.slows", { v: num(transLoss, 2) }));
  }
  // elite lifters catch the bar about 10 cm behind where it started; most misses are lost in front
  const xc = X[iCatch] * 100;
  chk("catch", xc <= 0.5 ? "good" : xc <= 5 ? "warning" : "serious",
    xc <= 0.5 ? (xc < -0.5 ? tr("check.catch.behind", { cm: num(-xc, 0) }) : tr("check.catch.over"))
      : tr(xc <= 5 ? "check.catch.front" : "check.catch.chasing", { cm: num(xc, 0) }));

  const notes = [];
  if (vy[iV] < 0.9) notes.push(tr("note.slowSpeed"));
  if (vy[iV] > 3.2) notes.push(tr("note.fastSpeed"));
  if (fs < 50) notes.push(tr("note.lowFps", { fps: fs }));
  const gapPull = gap.slice(iLift, iStand + 1).reduce((a, b) => a + b, 0) / fs;
  if (gapPull > 0.1) notes.push(tr("note.lostLift", { s: num(gapPull, 2) }));
  if (sizeChange > 0.12) notes.push(tr("note.sizeLift", { pct: Math.round(100 * sizeChange) }));

  const i0 = Math.max(0, iLift - Math.round(0.2 * fs));
  const i1 = Math.min(n - 1, jerk ? jerk.iCatch + Math.round(0.6 * fs) : iStand + Math.round(0.25 * fs));
  return {
    lift: type, X, H, vx, vy, speed, stageOf, stages, ev, jerk, metrics: m, checks, notes, sizeChange, metRising,
    facing, facingFrom, typeFrom, squat, catchFrom, splitBy, vmax: vy[iV],
    t0i: iLift, span: [i0, i1],
    marks: [
      { i: iLift, name: tr("mark.liftoff"), side: "right" }, { i: iV, name: tr("mark.peakSpeed"), side: "left" },
      ...(iPeak !== iCatch ? [{ i: iPeak, name: tr("mark.peakHeight"), side: "right" }] : []), { i: iCatch, name: tr("mark.catch"), side: "right" },
    ],
    tiles: [
      { label: tr("tile.peakSpeed"), value: num(vy[iV], 2), unit: "m/s", note: tr("tile.peakSpeed.note", { h: num(H[iV], 2) }) },
      { label: tr("tile.peakHeight"), value: num(H[iPeak], 2), unit: "m", note: tr("tile.peakHeight.note") },
      { label: tr("tile.drop"), value: num((H[iPeak] - H[iCatch]) * 100, 0), unit: "cm", note: tr("tile.drop.note", { h: num(H[iCatch], 2) }) },
      { label: tr("tile.catchVsStart"), value: fmtSigned(xc, 0), unit: "cm", note: tr(xc > 0.5 ? "tile.catchVsStart.front" : xc < -0.5 ? "tile.catchVsStart.behind" : "tile.catchVsStart.over") },
    ],
    axis: { x: [tr("axis.x.back"), tr("axis.x.forward")], h: tr("axis.h.floor"), t: tr("axis.t.liftoff") },
    // the parts joined by " · " (the gallery splits a title there)
    title: [LIFTS[type], tr(squat === null ? "title.catch.unclear" : squat ? "title.catch.squat" : "title.catch.power"), ...(jerk ? [tr(jerk.split === null ? "title.jerk" : jerk.split ? "title.jerk.split" : "title.jerk.power")] : [])].join(" · "),
  };
}

/* ------------------------------------------------------------------ rep lifts: squat, bench, deadlift, press */
const REP = { // turn: the first rep's turning point, marked on the path (mark.<turn>)
  squat: { dir: -1, turn: "bottom", floor: false },
  bench: { dir: -1, turn: "chest", floor: false },
  deadlift: { dir: 1, turn: "lockout", floor: true },
  press: { dir: 1, turn: "lockout", floor: false },
};
const THIGH_CM = 45; // a typical thigh, to put squat depth (measured in thigh lengths) into rough centimetres
const PARALLEL_BAND = 0.08; // a few cm either side of level is indistinguishable in a side-view estimate

// A shoulder hidden by the plate can jump below the hip, or briefly flip the torso nearly
// horizontal. Check its projected length and require agreement across actual video frames.
function squatLeanReader(sig, facing) {
  const frames = sig.samples.filter(s => s.pose).map(s => {
    const sh = sig.L(s.pose, "Shoulder"), hip = sig.L(s.pose, "Hip");
    return { t: sig.real(s.t), len: distance(sh, hip), height: hip.y - sh.y,
      angle: leanOf(sh, hip, facing), visible: Math.min(sh.v, hip.v) >= 0.5 };
  });
  const ref = median(frames.filter(v => v.visible).map(v => v.len)), half = Math.max(0.065, 1.6 / sig.fs);
  const valid = frames.filter(v => v.visible && v.height > 0.25 * ref && v.len >= 0.65 * ref && v.len <= 1.45 * ref);
  const stable = [];
  for (let i = 1; i < valid.length - 1; i++) {
    const a = valid[i - 1], b = valid[i], c = valid[i + 1];
    if (c.t - a.t <= 2 * half && Math.max(a.angle, b.angle, c.angle) - Math.min(a.angle, b.angle, c.angle) <= 8)
      stable.push({ t: b.t, angle: median([a.angle, b.angle, c.angle]) });
  }
  return (bottom, start, end) => {
    const base = stable.filter(v => Math.abs(v.t - bottom) <= half);
    if (base.length < 2 || base[0].t > bottom || base.at(-1).t < bottom) return {};
    const leanBottom = median(base.map(v => v.angle));
    const ascent = stable.filter(v => v.t >= start && v.t <= end);
    return { leanBottom, chestDrop: ascent.length >= 2 ? Math.max(...ascent.map(v => v.angle)) - leanBottom : null };
  };
}

// Judge the bottom from distinct observations bracketing the bar's turn. The leg can appear to
// collapse or point backwards when the plate hides the lifter, even with high model visibility.
function squatDepthReader(sig, facing) {
  const legs = ["l", "r"].map(side => {
    const hip = LM[side + "Hip"], knee = LM[side + "Knee"];
    const lengths = sig.samples.filter(s => s.pose && seen(s.pose[hip], s.pose[knee])).map(s => distance(s.pose[hip], s.pose[knee]));
    return { side, hip, knee, reference: median(lengths) };
  });
  return (bottom) => {
    const half = Math.max(0.065, 1.6 / sig.fs);
    const frames = sig.samples.filter(s => Math.abs(sig.real(s.t) - bottom) <= half);
    const estimates = [];
    for (const { side, hip, knee, reference } of legs) {
      const valid = [];
      for (const s of frames) {
        const leg = s.recoveredLeg?.side === side ? s.recoveredLeg : null;
        const h = s.pose?.[hip] ?? leg?.hip, k = s.pose?.[knee] ?? leg?.knee;
        if (!h || !k) continue;
        const len = distance(h, k);
        if (Math.min(h.v, k.v) < (side === sig.side ? 0.5 : 0.65) || !(len >= 0.5 * reference && len > 0 && len <= 1.6 * reference)) continue;
        if (facing && facing * (k.x - h.x) < 0) continue;
        valid.push({ t: sig.real(s.t), depth: (h.y - k.y) / len });
      }
      const depth = median(valid.map(v => v.depth));
      const agree = valid.filter(v => Math.abs(v.depth - depth) <= 0.12);
      if (agree.length >= 3 && agree.length >= frames.length / 2 && agree[0].t <= bottom && agree.at(-1).t >= bottom &&
          agree.at(-1).t - agree[0].t >= half * 0.5) estimates.push({ side, depth });
    }
    if (estimates.length === 2 && Math.abs(estimates[0].depth - estimates[1].depth) > 0.15) return null;
    return (estimates.find(e => e.side === sig.side) ?? estimates[0])?.depth ?? null;
  };
}
/** mean lifting speed at a 1-rep max (García-Ramos 2023's pooled figures; deadlift down to 0.14 in powerlifters,
 * Helms 2017: stronger lifters grind slower); said as atMax.<lift> */
const AT_MAX = { squat: { hi: 0.31 }, deadlift: { hi: 0.32 }, bench: { hi: 0.18 }, press: { hi: 0.19 } };

/** a dip in lifting speed between two speed peaks: where the lift nearly stalls */
function stickingPoint(vy, u0, u1) {
  const ext = [];
  for (let i = u0 + 1; i < u1; i++) {
    if (vy[i] > vy[i - 1] && vy[i] >= vy[i + 1]) ext.push({ i, max: true });
    else if (vy[i] < vy[i - 1] && vy[i] <= vy[i + 1]) ext.push({ i, max: false });
  }
  for (let k = 1; k < ext.length - 1; k++) {
    const a = ext[k - 1], m = ext[k], b = ext[k + 1];
    if (!m.max && a.max && b.max && vy[a.i] > 0.1 && vy[a.i] - vy[m.i] > 0.04 && vy[b.i] - vy[m.i] > 0.04) return m.i;
  }
  return null;
}

function reps(sig, opts, lift) {
  const { samples, fs, n, Xr, Hr, rs, gap, plate, side, L, poseAt } = sig;
  const { dir, turn, floor } = REP[lift];
  const h0 = median(Hr.slice(0, Math.max(1, Math.round(0.2 * fs))));
  const iMove = Hr.findIndex((h) => Math.abs(h - h0) > 0.04);
  if (iMove < 0) return { error: tr("error.repsNeverMove") };
  // rest: where the bar sat before it first moved; deadlift heights are from the floor, others from the rest
  const rest = [Math.max(0, iMove - Math.round(0.3 * fs)), Math.max(1, iMove - Math.round(0.05 * fs))];
  const hRest = median(Hr.slice(...rest)), xRest = median(Xr.slice(...rest));
  const H = Hr.map((v) => v - hRest + (floor ? plate / 2 : 0));
  const vy = deriv(H, fs);
  const s = Hr.map((v) => (v - hRest) * dir); // distance travelled the way the rep starts
  let smax = 0;
  for (let i = 0; i < n; i++) smax = Math.max(smax, s[i]);
  if (smax < 0.08) return { error: tr("error.repsTooSmall", { cm: Math.round(smax * 100), lift: tr(`lift.lc.${lift}`) }) };

  /* which way the lifter faces (toward the head, on a bench) */
  let facing = opts.facing === 1 || opts.facing === -1 ? opts.facing : 0, facingFrom = "you";
  if (!facing && side) {
    if (lift === "bench") {
      const d = samples.filter((q) => q.pose && seen(q.pose[LM.nose], L(q.pose, "Hip"))).map((q) => Math.sign(q.pose[LM.nose].x - L(q.pose, "Hip").x));
      if (d.length >= 5) facing = Math.sign(d.reduce((a, b) => a + b, 0)) || 0;
    } else facing = facingFromBody(samples);
    if (facing) facingFrom = "body";
  }
  if (!facing) { facing = 1; facingFrom = "guess"; }
  const X = Xr.map((v) => (v - xRest) * facing);
  const vx = deriv(X, fs);
  const speed = X.map((_, i) => Math.hypot(vx[i], vy[i]));

  /* the reps: each trip away from the rest position and back. Each leg runs while the bar moves faster than
   * 0.02 m/s its way, as velocity-based training bounds the concentric phase (Renner 2024): mean lifting speed is
   * then the mean concentric velocity that linear transducers report and published load-velocity figures use.
   * Legs bounded by distance from the rest position instead dropped the slow start and lockout and read 7-15% high.
   * Each scan starts mid-leg, so a still bar's noise during a pause can't move a boundary. */
  const MOVE = 0.02, thr = Math.max(0.06, 0.4 * smax);
  const found = [];
  for (let i = 0; i < n;) {
    while (i < n && s[i] <= thr) i++;
    if (i >= n) break;
    const a = i;
    while (i < n && s[i] > thr) i++;
    const b = i - 1, prevEnd = found.length ? found[found.length - 1].end : 0;
    // away from the rest position: its first and last moving samples
    let begin = a, p0 = a;
    while (begin > prevEnd + 1 && dir * vy[begin - 1] > MOVE) begin--;
    while (p0 < b && dir * vy[p0 + 1] > MOVE) p0++;
    // and back
    let p1 = b, end = b;
    while (p1 > p0 + 1 && dir * vy[p1 - 1] < -MOVE) p1--;
    while (end < n - 1 && dir * vy[end + 1] < -MOVE) end++;
    found.push({ begin, end, p0, p1, p: dir < 0 ? argmin(H, a, b) : argmax(H, a, b), done: s[end] < 0.5 * thr });
  }

  const lean = (p) => { const sh = L(p, "Shoulder"), hp = L(p, "Hip"); return seen(sh, hp) ? leanOf(sh, hp, facing) : NaN; };
  const at = (i) => (side ? poseAt(clamp(i, 0, n - 1)) : null);
  const depthAt = lift === "squat" && side ? squatDepthReader(sig, facingFrom === "guess" ? 0 : facing) : null;
  const squatLean = depthAt && facingFrom !== "guess" ? squatLeanReader(sig, facing) : null;
  // the lifting phase's ends between frames: where the speed crosses 0.02 m/s (at 60 fps a whole frame is ~2% of a rep)
  const rise = (u0, u1) => {
    const ts = u0 > 0 && vy[u0 - 1] < vy[u0] ? u0 - clamp((vy[u0] - MOVE) / (vy[u0] - vy[u0 - 1]), 0, 1) : u0;
    const te = u1 < n - 1 && vy[u1 + 1] < vy[u1] ? u1 + clamp((vy[u1] - MOVE) / (vy[u1] - vy[u1 + 1]), 0, 1) : u1;
    const h = (x) => { const i = Math.min(n - 2, Math.floor(x)); return H[i] + (H[i + 1] - H[i]) * (x - i); };
    return { t: (te - ts) / fs, mean: te > ts ? ((h(te) - h(ts)) * fs) / (te - ts) : 0 };
  };
  const R = [];
  for (const f of found) {
    const { p0, p1 } = f;
    const [u0, u1] = dir < 0 ? [p1, f.end] : [f.begin, p0]; // lifting: its first and last moving samples
    const [d0, d1] = dir < 0 ? [f.begin, p0] : [p1, f.end]; // lowering
    const { t: upT, mean } = rise(u0, u1);
    if (upT < 0.08) continue;
    // the still part at the turn; under 0.05 s it's a turn, not a pause, and the two legs meet in its middle
    let s0 = p0 + 1, s1 = p1;
    if ((s1 - s0) / fs < 0.05) s0 = s1 = Math.round((s0 + s1) / 2);
    const r = {
      n: R.length + 1, begin: f.begin, end: f.end, p: f.p, s0, s1, u0, u1, d0, d1, done: f.done,
      rom: Math.abs(H[f.p] - H[f.begin]), mean, peak: 0, iPeak: u0,
      up: upT, down: (d1 - d0 + 1) / fs, pause: (s1 - s0) / fs, sticking: stickingPoint(vy, u0, u1),
      drift: 0, away: 0, touch: X[f.p], shift: X[u1] - X[f.p],
    };
    let lo = Infinity, hi = -Infinity;
    for (let i = u0; i <= u1; i++) {
      if (vy[i] > r.peak) { r.peak = vy[i]; r.iPeak = i; }
      lo = Math.min(lo, X[i]); hi = Math.max(hi, X[i]);
    }
    r.drift = hi - lo;           // how far the bar wanders front/back while it goes up
    r.away = hi - X[u0];         // how far it moves forward of where the lifting started
    r.downPeak = 0;
    for (let i = d0; i <= d1; i++) r.downPeak = Math.max(r.downPeak, -vy[i]);
    // the first third of the way up: where hips rising first shows, as the torso tipping further forward. The
    // most it tips in that stretch counts, not where it ends up: the bar barely moves while the hips shoot up.
    let i3 = u0;
    while (i3 < u1 && Math.abs(H[i3] - H[u0]) < r.rom / 3) i3++;
    const mostLean = (a, b) => { let m = -Infinity; for (let i = a; i <= b; i += Math.max(1, Math.round(fs / 30))) { const p = at(i); const l = p ? lean(p) : NaN; if (Number.isFinite(l)) m = Math.max(m, l); } return m; };
    if (side) {
      if (lift === "squat") {
        r.depth = depthAt(sig.T[f.p]);
        if (squatLean) Object.assign(r, squatLean(sig.T[f.p], sig.T[u0], sig.T[i3]));
      }
      if (lift === "deadlift") {
        const l0 = at(f.begin) && lean(at(f.begin));
        r.hipsFirst = Number.isFinite(l0) ? mostLean(f.begin, i3) - l0 : null; // + = the torso tips forward: hips rose first
        const pt = at(f.p);
        if (pt) {
          const sh = L(pt, "Shoulder"), hp = L(pt, "Hip"), kn = L(pt, "Knee"), an = L(pt, "Ankle");
          if (seen(sh, hp, kn)) r.hipLock = angle(sh, hp, kn);
          if (seen(hp, kn, an)) r.kneeLock = angle(hp, kn, an);
          r.leanTop = lean(pt);
        }
      }
      if (lift === "press") {
        const pt = at(f.p);
        if (pt) { const sh = L(pt, "Shoulder"), el = L(pt, "Elbow"), wr = L(pt, "Wrist"); if (seen(sh, el, wr)) r.elbowTop = angle(sh, el, wr); }
        let back = 0;
        for (let i = u0; i <= u1; i += Math.max(1, Math.round(fs / 30))) { const p = at(i); const l = p ? lean(p) : NaN; if (Number.isFinite(l)) back = Math.min(back, l); }
        r.leanBack = -back;
      }
    }
    if (lift === "press") {
      // a dip just before the drive: push press or jerk
      const w0 = Math.max(0, f.begin - Math.round(0.7 * fs));
      const iDip = argmin(H, w0, f.begin);
      r.dip = H[f.begin] - H[iDip] > 0.03 ? Math.max(...H.slice(w0, iDip + 1)) - H[iDip] : 0;
    }
    R.push(r);
  }
  if (!R.length) return { error: tr("error.noReps", { lift: tr(`lift.lc.${lift}`) }) };

  /* the set */
  const done = R.filter((r) => r.done);
  const means = (done.length ? done : R).map((r) => r.mean);
  const best = Math.max(...means), bestRep = (done.length ? done : R)[means.indexOf(best)].n, last = means[means.length - 1];
  const loss = means.length >= 2 ? (best - last) / best : null;
  const avg = (k) => R.reduce((a, r) => a + (r[k] ?? 0), 0) / R.length;
  const variant = lift === "press" && R.some((r) => r.dip > 0.04 && r.peak > 1.0) ? tr("variant.pushPress") : null;
  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

  const stages = [], stageOf = new Int32Array(n).fill(-1), repOf = new Int16Array(n);
  const add = (id, a, b, rep) => { if (b > a) stages.push({ id, ...STAGES[id], i0: a, i1: b, dur: (b - a) / fs, rep }); };
  for (const r of R) {
    const e = Math.min(n, r.end + 1); // stages are [i0, i1); begin..end are the rep's moving samples
    if (dir < 0) { add("down", r.begin, r.s0, r.n); add("pause", r.s0, r.s1, r.n); add("up", r.s1, e, r.n); }
    else { add("up", r.begin, r.s0, r.n); add("pause", r.s0, r.s1, r.n); add("down", r.s1, e, r.n); }
    for (let i = r.begin; i <= r.end; i++) repOf[i] = r.n;
  }
  stages.forEach((st, k) => { for (let i = st.i0; i < st.i1; i++) stageOf[i] = k; });

  /* measurements */
  const m = [];
  const put = (group, id, value, unit, note) => m.push({ group: tr(`group.${group}`), label: tr(`metric.${id}.label`), value, unit, note });
  put("set", "reps", R.length, "", done.length < R.length ? tr("metric.reps.note", { n: R.length - done.length }) : undefined);
  put("set", "bestSpeed", best, "m/s", tr("metric.rep", { n: bestRep }));
  const mvt = variant ? null : AT_MAX[lift], atMax = mvt ? tr(`atMax.${lift}`) : null;
  put("set", "lastSpeed", last, "m/s", mvt ? tr("metric.lastSpeed.note", { atMax }) : undefined);
  if (loss !== null) put("set", "velocityLoss", loss * 100, "%", tr("metric.velocityLoss.note"));
  put("set", "rom", avg("rom") * 100, "cm", R.length > 1 ? tr("metric.rom.note", { min: Math.round(Math.min(...R.map((r) => r.rom)) * 100), max: Math.round(Math.max(...R.map((r) => r.rom)) * 100) }) : undefined);
  put("tempo", "lowering", avg("down"), "s", tr("metric.perRep"));
  put("tempo", lift === "deadlift" || lift === "press" ? "pauseTop" : "pauseBottom", avg("pause"), "s", tr("metric.perRep"));
  put("tempo", "lifting", avg("up"), "s", tr("metric.perRep"));
  put("barPath", "wander", Math.max(...R.map((r) => r.drift)) * 100, "cm", tr("metric.wander.note"));
  if (lift === "bench") {
    put("barPath", "touchToLockout", avg("shift") * 100, "cm", tr("metric.touchToLockout.note"));
    if (R.length > 1) put("barPath", "touchSpread", sd(R.map((r) => r.touch)) * 100, "cm", tr("metric.touchSpread.note"));
  }
  const sticks = R.filter((r) => r.sticking !== null);
  if (sticks.length) {
    const r = sticks.reduce((a, b) => (vy[b.sticking] < vy[a.sticking] ? b : a));
    put("bar", "sticking", Math.abs(H[r.sticking] - H[r.u0]) * 100, "cm", tr(dir < 0 ? "metric.sticking.noteBottom" : "metric.sticking.noteStart", { n: r.n, v: num(vy[r.sticking], 2) }));
  }
  if (variant) {
    const r = R.reduce((a, b) => (b.dip > a.dip ? b : a));
    put("bar", "pressDip", r.dip * 100, "cm", tr("metric.rep", { n: r.n }));
    put("bar", "pressDrive", Math.max(...R.map((q) => q.peak)), "m/s");
  }
  const withK = (k) => R.filter((r) => r[k] !== null && r[k] !== undefined && Number.isFinite(r[k]));
  const measured = withK("depth");
  const shallowest = measured.length ? measured.reduce((a, b) => b.depth < a.depth ? b : a) : null;
  const sq = measured.length === R.length ? shallowest : null;
  if (sq) {
    put("body", "shallowest", sq.depth * THIGH_CM, "cm", tr(sq.depth >= 0 ? "metric.shallowest.noteBelow" : "metric.shallowest.noteAbove", { n: sq.n }));
  }
  // angles from one camera's 2D body landmarks are approximate; the changes within a rep (chest drop, hips first)
  // hold up better than the absolute angles, as a constant error cancels
  if (lift === "squat" && withK("chestDrop").length) put("body", "chestDrop", Math.max(...withK("chestDrop").map((r) => r.chestDrop)), "°", tr("metric.chestDrop.note"));
  if (lift === "deadlift" && withK("hipsFirst").length) put("body", "hipsFirst", Math.max(...withK("hipsFirst").map((r) => r.hipsFirst)), "°", tr("metric.hipsFirst.note"));
  if (lift === "deadlift" && withK("hipLock").length) put("body", "hipLock", Math.min(...withK("hipLock").map((r) => r.hipLock)), "°", tr("metric.hipLock.note"));
  if (lift === "press" && withK("elbowTop").length) put("body", "elbowTop", Math.min(...withK("elbowTop").map((r) => r.elbowTop)), "°", tr("metric.elbowTop.note"));
  if (lift === "press" && withK("leanBack").length) put("body", "leanBack", Math.max(...withK("leanBack").map((r) => r.leanBack)), "°", tr("metric.approx"));

  /* checks: starting thresholds, meant to be tuned with a coach */
  const checks = [];
  const chk = (id, status, text) => checks.push({ title: tr(`check.${id}.title`), status, text });
  const pct = (v) => Math.round(v * 100);
  // Pareja-Blanco 2017: sets stopped at 20% velocity loss built as much strength as sets taken to 40%, with fewer
  // reps; the 40% sets built more muscle, and more fatigue
  if (loss !== null) {
    chk("velocityLoss", loss <= 0.2 ? "good" : loss <= 0.4 ? "warning" : "serious",
      tr(loss <= 0.2 ? "check.velocityLoss.low" : loss <= 0.4 ? "check.velocityLoss.mid" : "check.velocityLoss.high", { pct: pct(loss), best: num(best, 2), last: num(last, 2) }));
  }
  const worst = (k, cmp = (a, b) => b > a) => { const w = withK(k); return w.length ? w.reduce((a, b) => (cmp(a[k], b[k]) ? b : a)) : null; };
  if (lift === "squat") {
    const sh = shallowest;
    if (sh) {
      if (Math.abs(sh.depth) <= PARALLEL_BAND) chk("depth", "info", tr("check.depth.parallel", { n: sh.n }));
      else if (sh.depth < 0) chk("depth", "warning", tr("check.depth.high", { n: sh.n, cm: num(-sh.depth * THIGH_CM, 0) }));
      else chk("depth", "good", tr(sq && R.length > 1 ? "check.depth.good" : "check.depth.goodOne", { n: sh.n }));
    }
    if (side && !sq) {
      chk("depth", "info", tr("check.depth.unclear", { reps: R.filter(r => r.depth == null).map(r => r.n).join(", ") }));
    }
    const cd = worst("chestDrop");
    if (cd) chk("outOfBottom", cd.chestDrop <= 6 ? "good" : cd.chestDrop <= 12 ? "warning" : "serious",
      cd.chestDrop <= 6 ? tr("check.outOfBottom.good") : tr("check.outOfBottom.hips", { deg: num(cd.chestDrop, 0), n: cd.n }));
  }
  if (lift === "deadlift") {
    const hf = worst("hipsFirst");
    if (hf) chk("offFloor", hf.hipsFirst <= 5 ? "good" : hf.hipsFirst <= 10 ? "warning" : "serious",
      hf.hipsFirst <= 5 ? tr("check.dlOffFloor.good") : tr("check.dlOffFloor.hipsFirst", { deg: num(hf.hipsFirst, 0), n: hf.n }));
    const lk = worst("hipLock", (a, b) => b < a);
    if (lk) chk("lockout", lk.hipLock >= 168 ? "good" : lk.hipLock >= 158 ? "warning" : "serious",
      lk.hipLock >= 168 ? tr("check.dlLockout.good") : tr("check.dlLockout.short", { n: lk.n, deg: num(lk.hipLock, 0) }));
    const lb = worst("leanTop", (a, b) => b < a);
    if (lb && lb.leanTop < -10) chk("leaningBack", "warning", tr("check.leaningBack.text", { deg: num(-lb.leanTop, 0), n: lb.n }));
  }
  if (lift === "bench") {
    const sh = avg("shift") * 100;
    chk("barPath", sh >= 3 && sh <= 18 ? "good" : sh >= 0 && sh < 3 ? "warning" : sh > 18 ? "warning" : "serious",
      sh >= 3 && sh <= 18 ? tr("check.benchPath.jCurve", { cm: num(sh, 0) })
        : sh >= 0 && sh < 3 ? tr("check.benchPath.straight", { cm: num(sh, 0) })
          : sh > 18 ? tr("check.benchPath.tooFar", { cm: num(sh, 0) })
            : tr("check.benchPath.feet", { cm: num(-sh, 0) }));
    if (R.length > 1) {
      const spread = sd(R.map((r) => r.touch)) * 100;
      chk("touchPoint", spread <= 2 ? "good" : spread <= 4 ? "warning" : "serious",
        spread <= 2 ? tr("check.touchPoint.good") : tr("check.touchPoint.moves", { cm: num(spread, 0) }));
    }
    const bounce = R.find((r) => r.pause < 0.03 && r.downPeak > 0.7);
    if (bounce) chk("bounce", "warning", tr("check.bounce.text", { n: bounce.n, v: num(bounce.downPeak, 2) }));
  }
  if (lift === "press") {
    const el = worst("elbowTop", (a, b) => b < a);
    if (el) chk("lockout", el.elbowTop >= 165 ? "good" : el.elbowTop >= 155 ? "warning" : "serious",
      el.elbowTop >= 165 ? tr("check.pressLockout.good") : tr("check.pressLockout.short", { n: el.n, deg: num(el.elbowTop, 0) }));
    const lb = worst("leanBack");
    if (lb) chk("torso", lb.leanBack <= 8 ? "good" : lb.leanBack <= 15 ? "warning" : "serious",
      lb.leanBack <= 8 ? tr("check.torso.good") : tr("check.torso.leans", { deg: num(lb.leanBack, 0), n: lb.n }));
  }
  const away = Math.max(...R.map((r) => r.away)) * 100, wander = Math.max(...R.map((r) => r.drift)) * 100;
  if (lift === "squat") chk("barPath", wander <= 5 ? "good" : wander <= 9 ? "warning" : "serious",
    tr(wander <= 5 ? "check.squatPath.good" : "check.squatPath.wanders", { cm: num(wander, 0) }));
  if (lift === "deadlift") chk("barPath", away <= 3 ? "good" : away <= 6 ? "warning" : "serious",
    away <= 3 ? tr("check.dlPath.good") : tr("check.dlPath.drifts", { cm: num(away, 0) }));
  if (lift === "press") chk("barPath", away <= 6 ? "good" : away <= 10 ? "warning" : "serious",
    away <= 6 ? tr("check.pressPath.good") : tr("check.pressPath.loops", { cm: num(away, 0) }));

  const notes = [];
  const a0 = R[0].begin, a1 = R[R.length - 1].end;
  let lo = Infinity, hi = 0;
  for (let i = a0; i <= a1; i++) { lo = Math.min(lo, rs[i]); hi = Math.max(hi, rs[i]); }
  const sizeChange = hi / lo - 1;
  if (sizeChange > 0.12) notes.push(tr("note.sizeSet", { pct: Math.round(100 * sizeChange) }));
  const lost = gap.slice(a0, a1 + 1).reduce((a, b) => a + b, 0) / fs;
  if (lost > 0.1) notes.push(tr("note.lostSet", { s: num(lost, 2) }));
  if (mvt && last <= 1.25 * mvt.hi) notes.push(tr(`note.nearMax.${lift}`, { v: num(last, 2), atMax }));
  if (R.length === 1) notes.push(tr("note.oneRep"));
  if (done.length < R.length) notes.push(tr("note.unfinished"));
  if (!side) notes.push(tr(lift === "squat" ? "note.noBodyDepth" : "note.noBody"));

  const sticky = sticks.length ? sticks.reduce((a, b) => (vy[b.sticking] < vy[a.sticking] ? b : a)) : null;
  let vmaxI = R[0].iPeak;
  for (const r of R) if (vy[r.iPeak] > vy[vmaxI]) vmaxI = r.iPeak;
  const tiles = [
    { label: tr("tile.reps"), value: String(R.length), unit: "", note: done.length < R.length ? tr("tile.reps.unfinished") : tr("tile.reps.note", { cm: num(avg("rom") * 100, 0) }) },
    { label: tr("tile.bestSpeed"), value: num(best, 2), unit: "m/s", note: tr("tile.liftingRep", { n: bestRep }) },
    { label: tr("tile.velocityLoss"), value: loss === null ? "–" : String(pct(loss)), unit: loss === null ? "" : "%", note: tr(loss === null ? "tile.velocityLoss.none" : "tile.velocityLoss.note") },
    sq && Math.abs(sq.depth) > PARALLEL_BAND ? { label: tr(sq.depth >= 0 ? "tile.belowParallel" : "tile.aboveParallel"), value: num(Math.abs(sq.depth) * THIGH_CM, 0), unit: "cm", note: tr("tile.shallowest.note", { n: sq.n }) }
      : lift === "bench" ? { label: tr("tile.touchLockout"), value: fmtSigned(avg("shift") * 100, 0), unit: "cm", note: tr("tile.touchLockout.note") }
        : variant ? { label: tr("tile.dip"), value: num(Math.max(...R.map((r) => r.dip)) * 100, 0), unit: "cm", note: tr("tile.dip.note") }
          : { label: tr("tile.rom"), value: num(avg("rom") * 100, 0), unit: "cm", note: tr("tile.rom.note") },
  ];
  const allDeep = sq && sq.depth > PARALLEL_BAND;

  return {
    lift, variant, X, H, vx, vy, speed, stageOf, stages, repOf, reps: R, metrics: m, checks, notes, sizeChange,
    facing, facingFrom, vmax: vy[vmaxI], ev: { start: a0, vmax: vmaxI },
    t0i: a0, span: [Math.max(0, a0 - Math.round(0.3 * fs)), Math.min(n - 1, a1 + Math.round(0.3 * fs))],
    marks: [
      { i: a0, name: tr("mark.start"), side: "right" },
      ...R.map((r, k) => ({ i: r.p, name: k === 0 ? tr(`mark.${turn}`) : null, side: "right" })),
      ...(sticky ? [{ i: sticky.sticking, name: tr("mark.sticking"), side: "left" }] : []),
    ],
    tiles,
    axis: { x: lift === "bench" ? [tr("axis.x.feet"), tr("axis.x.head")] : [tr("axis.x.back"), tr("axis.x.forward")], h: tr(floor ? "axis.h.floor" : "axis.h.start"), t: tr("axis.t.firstRep") },
    // the parts joined by " · " (the gallery splits a title there)
    title: [variant ? tr("title.variant", { lift: LIFTS[lift], variant }) : LIFTS[lift], tr("title.reps", { n: R.length }), ...(allDeep ? [tr("title.belowParallel")] : [])].join(" · "),
  };
}

/** a measurement's value as shown (signed: a difference between two lifts) */
export function fmtMetric(m, signed = false) {
  const catchVsStart = m.label === tr("metric.catchVsStart.label"); // shown signed, whole cm
  const d = m.unit === "cm" ? (Math.abs(m.value) < 10 && !catchVsStart ? 1 : 0)
    : ["°", "%", "", "W", "N", "J"].includes(m.unit) ? 0 : m.unit === "kg" ? (Number.isInteger(m.value) ? 0 : 1) : 2;
  return signed || catchVsStart ? fmtSigned(m.value, d) : num(m.value, d);
}
/** v with d decimals and a sign (a true minus), in the language's decimal mark; zero unsigned */
export function fmtSigned(v, d = 0) { const s = num(v, d); return Number(v.toFixed(d)) === 0 ? num(0, d) : v > 0 ? `+${s}` : s.replace("-", "−"); }
/** a number as written, every decimal it has, in the language's decimal mark (the load as entered, an axis tick) */
export const fmtPlain = (v) => num(v, (String(v).split(".")[1] || "").length);
