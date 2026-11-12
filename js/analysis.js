/* From the tracked plate (and the body, when tracked) to the lift: which lift it is, its stages or reps,
 * measurements and checks.
 *
 * Lifts
 *   snatch, clean     one pull from the floor: first pull, transition, second pull, turnover, recovery
 *                     (and a jerk after a clean). Without the body the first pull / transition split comes
 *                     from the dip in bar speed, when there is one.
 *   squat, bench      reps that go down first: lowering, pause, lifting
 *   deadlift, press   reps that go up first: lifting, pause (lockout), lowering
 * Recognised from the body when it's tracked (lying down; bar low, at the hips or at the shoulders; how fast
 * and which way the bar moves), from the bar alone otherwise, or chosen by the user.
 *
 * Coordinates: X metres forward (the way the lifter faces; toward the head on a bench), H metres up. For lifts
 * from the floor H is the bar centre's height above the floor (it starts there, at the plate's radius);
 * otherwise it's measured from where the bar started. Scale comes from the plate: a bumper is 450 mm across.
 */

export const STAGES = {
  first: { name: "First pull", slot: 1 },
  pull: { name: "Pull", slot: 1 },
  transition: { name: "Transition", slot: 2 },
  second: { name: "Second pull", slot: 3 },
  turnover: { name: "Turnover", slot: 4 },
  recovery: { name: "Recovery", slot: 5 },
  // rep lifts use the first three slots only (they are validated against each other in any order)
  up: { name: "Lifting", slot: 1 },
  down: { name: "Lowering", slot: 2 },
  pause: { name: "Pause", slot: 3 },
};

export const LIFTS = { snatch: "Snatch", clean: "Clean", deadlift: "Deadlift", squat: "Squat", bench: "Bench press", press: "Overhead press" };

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
  if (good.length < 10 || good.length < 0.3 * samples.length) return { error: "The plate was lost on most frames. Check the circle sits on the plate, and that the plate stays in view." };
  const tv0 = samples[0].t;
  const real = (tv) => (tv - tv0) / slow;
  const dts = [];
  for (let i = 1; i < samples.length; i++) { const d = real(samples[i].t) - real(samples[i - 1].t); if (d > 1e-5) dts.push(d); }
  const fs = clamp(Math.round(1 / median(dts)), 20, 480);
  const n = Math.floor(real(samples[samples.length - 1].t) * fs) + 1;
  if (n < 0.5 * fs) return { error: "The clip is too short. Include the whole lift, from the set-up to the finish." };
  const T = Float64Array.from({ length: n }, (_, i) => i / fs);
  const gt = good.map((s) => real(s.t));
  // 10 Hz keeps the peak of a second pull (within ~3% of a sharp one) while calming tracking noise
  const fc = Math.min(10, fs / 4);
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
  if (chosen && LIFTS[chosen]) return { lift: chosen, from: "you", why: "chosen" };
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
  const pull = (where) => {
    if (topOnBody !== null) return topOnBody < 0.85 ? { lift: "deadlift", from: "body", why: `${where}, finishes at the hips` } : { lift: "olympic", from: "body", why: `${where}, finishes at the shoulders or overhead` };
    return rise < 0.9 ? { lift: "deadlift", from: "bar", why: `${where}, rises ${Math.round(rise * 100)} cm` } : { lift: "olympic", from: "bar", why: `${where}, rises ${Math.round(rise * 100)} cm` };
  };
  const body = bodyAtRest(sig, Math.max(0, iMove - Math.round(0.5 * fs)), iMove);
  if (body) {
    if (body.lying) return { lift: "bench", from: "body", why: "lying down" };
    if (body.onBody !== null) {
      if (body.onBody < 0.45) return pull("from the floor");
      if (body.onBody > 0.72) return squatty ? { lift: "squat", from: "body", why: "bar on the shoulders, goes down" } : { lift: "press", from: "body", why: "bar at the shoulders, goes up" };
      return pull("from the hips");
    }
  }
  // the bar alone: which way it travels furthest, and how far a pull rises
  if (squatty) return { lift: "squat", from: "bar", why: "goes down a long way" };
  const r = pull("goes up first");
  return { ...r, from: "bar" };
}

/* ------------------------------------------------------------------ the analysis */
/**
 * samples: [{t: video media time s, x, y, r: plate centre and radius in video px, ok, pose?: 33 × {x, y, z, v} in video px}]
 * opts: {plateMm=450, slowmo=1, facing: 1 right | -1 left | 0 auto, lift: 'auto' | one of LIFTS, kg: the load, for power}
 */
export function analyse(samples, opts = {}) {
  const sig = prepare(samples, opts);
  if (sig.error) return sig;
  const chosen = opts.lift && opts.lift !== "auto" ? opts.lift : opts.type && opts.type !== "auto" ? opts.type : null;
  const mv = recognise(sig, chosen);
  if (!mv.lift) return { error: "The bar never moves in this clip. Start just before the lift and run past its end." };
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
 * The force on the bar, m(g + a), and the power going into it, F·v (forward and up). Acceleration is the bar
 * speed differentiated once more and smoothed at 6 Hz: a second derivative of tracking noise would swamp it.
 * Snatch and clean: over the pull, lift-off to peak speed. Rep lifts: over each rep's lifting phase, where the
 * mean is mean concentric power (≈ m·g·rise / time, as the bar starts and ends at rest).
 */
function addPower(R, kg, fs) {
  const fc = Math.min(6, fs / 4), ax = filtfilt(deriv(R.vx, fs), fc, fs), ay = filtfilt(deriv(R.vy, fs), fc, fs);
  const n = R.vy.length, P = new Float64Array(n), F = new Float64Array(n);
  for (let i = 0; i < n; i++) { F[i] = kg * (ay[i] + G); P[i] = kg * (ax[i] * R.vx[i] + (ay[i] + G) * R.vy[i]); }
  const mean = (a, i0, i1) => { let s = 0; for (let i = i0; i <= i1; i++) s += a[i]; return s / Math.max(1, i1 - i0 + 1); };
  const W = (w) => `${Math.round(w)}`;
  const put = (label, value, unit, note) => R.metrics.push({ group: "Power", label, value, unit, note });
  R.P = P; R.F = F; R.kg = kg;
  put("Load", kg, "kg", "as entered");
  if (!R.reps) {
    const i0 = R.ev.liftoff, i1 = R.ev.vmax, iP = argmax(P, i0, i1), iF = argmax(F, i0, i1), pull = mean(P, i0, i1);
    put("Peak power", P[iP], "W", `${((iP - i0) / fs).toFixed(2)} s after lift-off; ${(P[iP] / kg).toFixed(1)} W per kg of bar`);
    put("Mean power in the pull", pull, "W", "lift-off to peak speed");
    put("Peak force on the bar", F[iF], "N", `approx. (smoothing softens short spikes); ${(F[iF] / (kg * G)).toFixed(1)}× the bar's weight`);
    put("Bar energy at peak speed", 0.5 * kg * R.vy[i1] ** 2 + kg * G * (R.H[i1] - R.H[i0]), "J", "moving + lifted, from lift-off");
    R.tiles.push(
      { label: "Peak power", value: W(P[iP]), unit: "W", note: `${(P[iP] / kg).toFixed(1)} W per kg of bar` },
      { label: "Pull power", value: W(pull), unit: "W", note: "mean, lift-off to peak speed" },
    );
    return;
  }
  for (const s of R.stages) {
    if (s.id !== "up") continue;
    const r = R.reps.find((q) => q.n === s.rep);
    if (r) { r.power = mean(P, s.i0, s.i1); r.peakPower = P[argmax(P, s.i0, s.i1)]; }
  }
  const done = R.reps.filter((r) => r.power !== undefined);
  if (!done.length) return;
  const best = done.reduce((a, b) => (b.power > a.power ? b : a)), peak = done.reduce((a, b) => (b.peakPower > a.peakPower ? b : a));
  put("Best mean lifting power", best.power, "W", `rep ${best.n}; mean concentric power`);
  put("Peak power", peak.peakPower, "W", `rep ${peak.n}`);
  put("Mean lifting power, every rep", done.reduce((a, r) => a + r.power, 0) / done.length, "W");
  if (done.length > 1) put("Power lost, best rep to last", (100 * (best.power - done[done.length - 1].power)) / best.power, "%");
  R.tiles.push(
    { label: "Best mean power", value: W(best.power), unit: "W", note: `lifting, rep ${best.n}` },
    { label: "Peak power", value: W(peak.peakPower), unit: "W", note: `rep ${peak.n}` },
  );
}

/* ------------------------------------------------------------------ snatch and clean */
function olympic(sig, opts, forced) {
  const { samples, slow, plate, tv0, real, fs, n, T, gap, rs, Xr, Hr } = sig;
  /* events. Heights first against the start of the clip, then against where the bar sat just before lift-off
   * (lifters roll the bar in during the set-up) */
  const k0 = Math.max(1, Math.min(n, Math.round(0.2 * fs)));
  let H = Hr.map((v) => v - median(Hr.slice(0, k0)) + plate / 2);
  let vy = deriv(H, fs);
  const H0 = plate / 2;
  const i3 = H.findIndex((h) => h > H0 + 0.03);
  if (i3 < 0) return { error: "The bar never leaves the floor in this clip. Start where the bar is on the floor and run past the lift." };
  let iLift = i3;
  while (iLift > 0 && vy[iLift - 1] > 0.05) iLift--;
  const rest = [Math.max(0, iLift - Math.round(0.25 * fs)), iLift + 1];
  const xRest = median(Xr.slice(...rest)), hRest = median(Hr.slice(...rest));
  H = Hr.map((v) => v - hRest + plate / 2);
  const Xraw = Xr.map((v) => v - xRest);
  vy = deriv(H, fs);
  const iV = argmax(vy, iLift, Math.min(n - 1, iLift + Math.round(1.6 * fs)));
  if (vy[iV] < 0.3) return { error: "No lift found: the bar never moves fast. If the video is slow motion, set the slow-motion factor." };
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

  /* first pull / transition split */
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
  const stages = [];
  const add = (id, i0, i1) => { if (i1 > i0) stages.push({ id, ...STAGES[id], i0, i1, dur: (i1 - i0) / fs }); };
  if (iFirst !== null) { add("first", iLift, iFirst); add("transition", iFirst, iTrans); add("second", iTrans, iV); }
  else add("pull", iLift, iV);
  add("turnover", iV, iCatch);
  add("recovery", iCatch, iStand);
  const stageOf = new Int8Array(n).fill(-1);
  stages.forEach((s, k) => { for (let i = s.i0; i < s.i1; i++) stageOf[i] = k; });

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

  /* lift type and catch */
  let type = forced, typeFrom = "you";
  const ps = poseAt(iStand);
  if (!type && ps && side) {
    const wrist = ps[LM[side + "Wrist"]], nose = ps[LM.nose];
    if (wrist.v > 0.3 && nose.v > 0.3) { type = wrist.y < nose.y ? "snatch" : "clean"; typeFrom = "body"; }
  }
  if (!type) { type = H[iStand] > 1.6 ? "snatch" : "clean"; typeFrom = "bar"; }
  let squat = null, catchFrom = "bar";
  if (knee) {
    // hips below the knees at the bottom of the catch (image y grows downward)
    let below = 0, seen = 0;
    for (let i = iCatch; i <= Math.min(n - 1, iCatch + Math.round(0.35 * fs)); i += Math.max(1, Math.round(fs / 30))) {
      const p = poseAt(i);
      if (!p) continue;
      const hip = p[LM[side + "Hip"]], kn = p[LM[side + "Knee"]];
      if (hip.v > 0.3 && kn.v > 0.3) { seen++; if (hip.y >= kn.y) below++; }
    }
    if (seen >= 2) { squat = below > 0; catchFrom = "body"; }
  }
  if (squat === null) squat = H[iCatch] / Math.max(0.5, H[iStand]) < (type === "snatch" ? 0.62 : 0.72);

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
        jerk = { iStart: s0, iDip: dB, iDrive: dV, iPeak: jP, iCatch: jC, dip: H[s0] - H[dB], dipTime: (dB - s0) / fs, drive: vy[dV], drop: H[jP] - H[jC], split };
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
  const transLoss = iFirst !== null ? Math.max(0, vy[iFirst] - vy[iTrans]) : null;
  // the bar's position as it passes the knees: end of the first pull, or ~0.5 m up when that isn't known
  let iKnee = iLift;
  while (iKnee < iV && H[iKnee] < 0.5) iKnee++;
  const xAtKnee = iFirst !== null ? X[iFirst] : X[iKnee];

  const m = [];
  const put = (group, label, value, unit, note) => m.push({ group, label, value, unit, note });
  put("Bar", "Peak bar speed", vy[iV], "m/s", `at ${((iV - iLift) / fs).toFixed(2)} s after lift-off, ${H[iV].toFixed(2)} m up`);
  put("Bar", "Peak bar height", H[iPeak], "m", "bar centre above the floor");
  put("Bar", "Catch height", H[iCatch], "m", metRising ? "met on the way up: where the bar was slowest" : "lowest bar after its peak");
  put("Bar", "Drop under the bar", (H[iPeak] - H[iCatch]) * 100, "cm", metRising ? "none: the bar never came down" : "peak height to catch height");
  put("Bar", "Standing height", H[iStand], "m", type === "snatch" ? "bar overhead" : "bar on the shoulders");
  put("Bar path", "Back toward you in the pull", -minBack.v * 100, "cm", "furthest back before peak speed");
  put("Bar path", "Swing out in front", swing * 100, "cm", "furthest back to furthest forward");
  put("Bar path", "Catch vs start", X[iCatch] * 100, "cm", "+ forward, − back, from where the bar left the floor");
  stages.forEach((s) => put("Timing", s.name, s.dur, "s"));
  put("Timing", "Lift-off to peak speed", (iV - iLift) / fs, "s");
  put("Timing", "Peak speed to catch", (iCatch - iV) / fs, "s");
  if (transLoss !== null) put("Bar", "Speed lost in the transition", transLoss, "m/s", `found from the ${splitBy}`);
  if (knee) {
    put("Body", "Knee angle at lift-off", knee[iLift], "°", "180° is straight");
    put("Body", "Hip angle at lift-off", hipA[iLift], "°");
    if (iFirst !== null && splitBy === "knees") put("Body", "Knee angle, end of first pull", knee[iFirst], "°");
    put("Body", "Most knee extension", Math.max(...knee.slice(iLift, iCatch + 1)), "°", "around the second pull");
    put("Body", "Most hip extension", Math.max(...hipA.slice(iLift, iCatch + 1)), "°");
  }
  if (jerk) {
    put("Jerk", "Dip depth", jerk.dip * 100, "cm");
    put("Jerk", "Dip time", jerk.dipTime, "s");
    put("Jerk", "Drive peak speed", jerk.drive, "m/s");
    put("Jerk", "Drop under the bar", jerk.drop * 100, "cm");
  }

  /* checks: starting thresholds, meant to be tuned with a coach */
  const checks = [];
  const chk = (title, status, text) => checks.push({ title, status, text });
  const xk = xAtKnee * 100;
  chk("Off the floor", xk <= 1 ? "good" : xk <= 4 ? "warning" : "serious",
    xk <= 1 ? `The bar comes back toward you as it leaves the floor (${fmtSigned(xk)} cm by the knees).` : `The bar drifts away from you off the floor (${fmtSigned(xk)} cm by the knees). Sweep it back in.`);
  const sw = swing * 100;
  chk("Second pull", sw <= 8 ? "good" : sw <= 14 ? "warning" : "serious",
    sw <= 8 ? `The bar stays close: it swings ${sw.toFixed(0)} cm out in front.` : `The bar loops ${sw.toFixed(0)} cm out in front. The hips may be pushing it away instead of the bar staying close.`);
  if (transLoss !== null) {
    chk("Transition", transLoss <= 0.05 ? "good" : transLoss <= 0.15 ? "warning" : "serious",
      transLoss <= 0.05 ? "The bar keeps its speed while the knees come under it." : `The bar slows by ${transLoss.toFixed(2)} m/s while the knees come under it.`);
  }
  const xc = X[iCatch] * 100;
  chk("Catch position", xc <= 3 ? "good" : xc <= 8 ? "warning" : "serious",
    xc <= 3 ? `You catch the bar ${xc < 0 ? `${(-xc).toFixed(0)} cm behind` : "over"} where it started.` : `You catch the bar ${xc.toFixed(0)} cm in front of where it started: jumping forward to chase it.`);

  const notes = [];
  if (vy[iV] < 0.9) notes.push("Peak bar speed is low for a snatch or clean. If the video is slowed down, set the slow-motion factor.");
  if (vy[iV] > 3.2) notes.push("Peak bar speed is very high. Check the slow-motion factor and the plate size.");
  const gapPull = gap.slice(iLift, iStand + 1).reduce((a, b) => a + b, 0) / fs;
  if (gapPull > 0.1) notes.push(`The plate was lost for ${gapPull.toFixed(2)} s during the lift; values there are filled in.`);
  if (sizeChange > 0.12) notes.push(`The plate's size on screen changed by ${Math.round(100 * sizeChange)}% during the lift, so the camera was close or tilted. The app corrects for it frame by frame, but heights are approximate. Next time film from further back with the phone level.`);

  const i0 = Math.max(0, iLift - Math.round(0.2 * fs));
  const i1 = Math.min(n - 1, jerk ? jerk.iCatch + Math.round(0.6 * fs) : iStand + Math.round(0.25 * fs));
  return {
    lift: type, X, H, vx, vy, speed, stageOf, stages, ev, jerk, metrics: m, checks, notes, sizeChange, metRising,
    facing, facingFrom, typeFrom, squat, catchFrom, splitBy, vmax: vy[iV],
    t0i: iLift, span: [i0, i1],
    marks: [
      { i: iLift, name: "Lift-off", side: "right" }, { i: iV, name: "Peak speed", side: "left" },
      ...(iPeak !== iCatch ? [{ i: iPeak, name: "Peak height", side: "right" }] : []), { i: iCatch, name: "Catch", side: "right" },
    ],
    tiles: [
      { label: "Peak bar speed", value: vy[iV].toFixed(2), unit: "m/s", note: `${H[iV].toFixed(2)} m up` },
      { label: "Peak height", value: H[iPeak].toFixed(2), unit: "m", note: "bar centre, from the floor" },
      { label: "Drop under the bar", value: ((H[iPeak] - H[iCatch]) * 100).toFixed(0), unit: "cm", note: `caught at ${H[iCatch].toFixed(2)} m` },
      { label: "Catch vs start", value: fmtSigned(xc, 0), unit: "cm", note: xc > 0.5 ? "in front of the start" : xc < -0.5 ? "behind the start" : "over the start" },
    ],
    axis: { x: ["← back", "forward →"], h: "m from the floor", t: "s from lift-off" },
    title: `${type === "snatch" ? "Snatch" : "Clean"} · ${squat ? "squat" : "power"} catch${jerk ? ` · ${jerk.split === null ? "" : jerk.split ? "split " : "power "}jerk` : ""}`,
  };
}

/* ------------------------------------------------------------------ rep lifts: squat, bench, deadlift, press */
const REP = {
  squat: { dir: -1, turn: "Bottom", floor: false },
  bench: { dir: -1, turn: "Chest", floor: false },
  deadlift: { dir: 1, turn: "Lockout", floor: true },
  press: { dir: 1, turn: "Lockout", floor: false },
};
const THIGH_CM = 45; // a typical thigh, to put squat depth (measured in thigh lengths) into rough centimetres

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
  if (iMove < 0) return { error: "The bar never moves in this clip. Start just before the first rep and run past the last one." };
  // rest: where the bar sat before it first moved; deadlift heights are from the floor, others from the rest
  const rest = [Math.max(0, iMove - Math.round(0.3 * fs)), Math.max(1, iMove - Math.round(0.05 * fs))];
  const hRest = median(Hr.slice(...rest)), xRest = median(Xr.slice(...rest));
  const H = Hr.map((v) => v - hRest + (floor ? plate / 2 : 0));
  const vy = deriv(H, fs);
  const s = Hr.map((v) => (v - hRest) * dir); // distance travelled the way the rep starts
  let smax = 0;
  for (let i = 0; i < n; i++) smax = Math.max(smax, s[i]);
  if (smax < 0.08) return { error: `The bar only moves ${Math.round(smax * 100)} cm the way a ${LIFTS[lift].toLowerCase()} starts. If that's not the lift, pick it under Lift.` };

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

  /* the reps: each trip away from the rest position and back */
  const thr = Math.max(0.06, 0.4 * smax);
  const found = [];
  for (let i = 0; i < n;) {
    while (i < n && s[i] <= thr) i++;
    if (i >= n) break;
    const a = i;
    while (i < n && s[i] > thr) i++;
    const b = i - 1, prevEnd = found.length ? found[found.length - 1].end : 0;
    let begin = a;
    while (begin > prevEnd && s[begin - 1] > 0.01 && dir * vy[begin - 1] > 0.02) begin--;
    let end = b;
    while (end < n - 1 && s[end + 1] > 0.01 && dir * vy[end + 1] < -0.02) end++;
    found.push({ begin, end, p: dir < 0 ? argmin(H, a, b) : argmax(H, a, b), done: s[end] < 0.5 * thr });
  }

  const lean = (p) => { const sh = L(p, "Shoulder"), hp = L(p, "Hip"); return seen(sh, hp) ? leanOf(sh, hp, facing) : NaN; };
  const at = (i) => (side ? poseAt(clamp(i, 0, n - 1)) : null);
  const R = [];
  for (const f of found) {
    let p0 = f.p, p1 = f.p;
    while (p0 > f.begin && Math.abs(vy[p0 - 1]) < 0.05) p0--;
    while (p1 < f.end && Math.abs(vy[p1 + 1]) < 0.05) p1++;
    if ((p1 - p0) / fs < 0.05) p0 = p1 = f.p; // a turn, not a pause
    const [u0, u1] = dir < 0 ? [p1, f.end] : [f.begin, p0]; // lifting
    const [d0, d1] = dir < 0 ? [f.begin, p0] : [p1, f.end]; // lowering
    const upT = (u1 - u0) / fs;
    if (upT < 0.08) continue;
    const r = {
      n: R.length + 1, begin: f.begin, end: f.end, p: f.p, p0, p1, u0, u1, d0, d1, done: f.done,
      rom: Math.abs(H[f.p] - H[f.begin]), mean: (H[u1] - H[u0]) / upT, peak: 0, iPeak: u0,
      up: upT, down: (d1 - d0) / fs, pause: (p1 - p0) / fs, sticking: stickingPoint(vy, u0, u1),
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
        let deep = null;
        for (let i = p0 - 3; i <= p1 + 3; i++) {
          const p = at(i);
          if (!p) continue;
          const hp = L(p, "Hip"), kn = L(p, "Knee");
          if (!seen(hp, kn)) continue;
          const th = Math.hypot(hp.x - kn.x, hp.y - kn.y);
          if (th > 10) deep = Math.max(deep ?? -9, (hp.y - kn.y) / th); // + = hip crease below the knee
        }
        r.depth = deep;
        const lb = at(f.p) && lean(at(f.p));
        r.leanBottom = Number.isFinite(lb) ? lb : null;
        r.chestDrop = Number.isFinite(lb) ? mostLean(u0, i3) - lb : null; // + = the torso tips forward as the hips rise
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
  if (!R.length) return { error: `No ${LIFTS[lift].toLowerCase()} reps found. If that's not the lift, pick it under Lift.` };

  /* the set */
  const done = R.filter((r) => r.done);
  const means = (done.length ? done : R).map((r) => r.mean);
  const best = Math.max(...means), bestRep = (done.length ? done : R)[means.indexOf(best)].n, last = means[means.length - 1];
  const loss = means.length >= 2 ? (best - last) / best : null;
  const avg = (k) => R.reduce((a, r) => a + (r[k] ?? 0), 0) / R.length;
  const variant = lift === "press" && R.some((r) => r.dip > 0.04 && r.peak > 1.0) ? "push press / jerk" : null;
  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

  const stages = [], stageOf = new Int8Array(n).fill(-1), repOf = new Int16Array(n);
  const add = (id, a, b, rep) => { if (b > a) stages.push({ id, ...STAGES[id], i0: a, i1: b, dur: (b - a) / fs, rep }); };
  for (const r of R) {
    if (dir < 0) { add("down", r.begin, r.p0, r.n); add("pause", r.p0, r.p1, r.n); add("up", r.p1, r.end, r.n); }
    else { add("up", r.begin, r.p0, r.n); add("pause", r.p0, r.p1, r.n); add("down", r.p1, r.end, r.n); }
    for (let i = r.begin; i <= r.end; i++) repOf[i] = r.n;
  }
  stages.forEach((st, k) => { for (let i = st.i0; i < st.i1; i++) stageOf[i] = k; });

  /* measurements */
  const m = [];
  const put = (group, label, value, unit, note) => m.push({ group, label, value, unit, note });
  put("Set", "Reps", R.length, "", done.length < R.length ? `${R.length - done.length} not finished` : undefined);
  put("Set", "Best mean lifting speed", best, "m/s", `rep ${bestRep}`);
  put("Set", "Last rep mean lifting speed", last, "m/s");
  if (loss !== null) put("Set", "Velocity loss", loss * 100, "%", "best rep to last rep");
  put("Set", "Range of motion", avg("rom") * 100, "cm", R.length > 1 ? `${Math.round(Math.min(...R.map((r) => r.rom)) * 100)}–${Math.round(Math.max(...R.map((r) => r.rom)) * 100)} cm across reps` : undefined);
  put("Tempo", "Lowering", avg("down"), "s", "average per rep");
  put("Tempo", lift === "deadlift" || lift === "press" ? "Pause at the top" : "Pause at the bottom", avg("pause"), "s", "average per rep");
  put("Tempo", "Lifting", avg("up"), "s", "average per rep");
  put("Bar path", "Wander while lifting", Math.max(...R.map((r) => r.drift)) * 100, "cm", "most front-to-back movement in a rep");
  if (lift === "bench") {
    put("Bar path", "Touch to lockout", avg("shift") * 100, "cm", "+ toward your head (the J-curve)");
    if (R.length > 1) put("Bar path", "Touch point spread", sd(R.map((r) => r.touch)) * 100, "cm", "how much the touch point moves between reps");
  }
  const sticks = R.filter((r) => r.sticking !== null);
  if (sticks.length) {
    const r = sticks.reduce((a, b) => (vy[b.sticking] < vy[a.sticking] ? b : a));
    put("Bar", "Sticking point", Math.abs(H[r.sticking] - H[r.u0]) * 100, "cm", `above the ${dir < 0 ? "bottom" : "start"} on rep ${r.n}, at ${vy[r.sticking].toFixed(2)} m/s`);
  }
  if (variant) {
    const r = R.reduce((a, b) => (b.dip > a.dip ? b : a));
    put("Bar", "Dip depth", r.dip * 100, "cm", `rep ${r.n}`);
    put("Bar", "Drive peak speed", Math.max(...R.map((q) => q.peak)), "m/s");
  }
  const withK = (k) => R.filter((r) => r[k] !== null && r[k] !== undefined && Number.isFinite(r[k]));
  if (lift === "squat" && withK("depth").length) {
    const sh = withK("depth").reduce((a, b) => (b.depth < a.depth ? b : a));
    put("Body", "Shallowest rep", sh.depth * THIGH_CM, "cm", `rep ${sh.n}: hip crease ${sh.depth >= 0 ? "below" : "above"} the knee (approx.)`);
  }
  if (lift === "squat" && withK("chestDrop").length) put("Body", "Chest drop out of the bottom", Math.max(...withK("chestDrop").map((r) => r.chestDrop)), "°", "extra forward lean in the first third of the way up");
  if (lift === "deadlift" && withK("hipsFirst").length) put("Body", "Hips rising first", Math.max(...withK("hipsFirst").map((r) => r.hipsFirst)), "°", "extra forward lean in the first third of the pull");
  if (lift === "deadlift" && withK("hipLock").length) put("Body", "Hip angle at lockout", Math.min(...withK("hipLock").map((r) => r.hipLock)), "°", "180° is straight; least locked-out rep");
  if (lift === "press" && withK("elbowTop").length) put("Body", "Elbow angle overhead", Math.min(...withK("elbowTop").map((r) => r.elbowTop)), "°", "180° is straight; least locked-out rep");
  if (lift === "press" && withK("leanBack").length) put("Body", "Lean back while pressing", Math.max(...withK("leanBack").map((r) => r.leanBack)), "°");

  /* checks: starting thresholds, meant to be tuned with a coach */
  const checks = [];
  const chk = (title, status, text) => checks.push({ title, status, text });
  const pct = (v) => Math.round(v * 100);
  if (loss !== null) {
    chk("Velocity loss", loss <= 0.2 ? "good" : loss <= 0.3 ? "warning" : "serious",
      `The last rep was ${pct(loss)}% slower than the best (${best.toFixed(2)} → ${last.toFixed(2)} m/s). ` +
      (loss <= 0.2 ? "Plenty left: strength sets usually stop around 20%." : loss <= 0.3 ? "Close to the 20–30% where strength sets usually stop." : "Near failure: fine for muscle-building sets; stop earlier when training for strength."));
  }
  const worst = (k, cmp = (a, b) => b > a) => { const w = withK(k); return w.length ? w.reduce((a, b) => (cmp(a[k], b[k]) ? b : a)) : null; };
  if (lift === "squat") {
    const sh = worst("depth", (a, b) => b < a);
    if (sh) {
      const cm = Math.abs(sh.depth) * THIGH_CM;
      chk("Depth", sh.depth >= 0.02 ? "good" : sh.depth >= -0.08 ? "warning" : "serious",
        sh.depth >= 0.02 ? `Every rep goes below parallel: hip crease under the knee${R.length > 1 ? `, shallowest on rep ${sh.n}` : ""}.`
          : sh.depth >= -0.08 ? `Rep ${sh.n} stops at about parallel. Sit a few centimetres deeper to make it count.`
            : `Rep ${sh.n} stops about ${cm.toFixed(0)} cm above parallel. Sit deeper, or lighten the load to reach depth.`);
    }
    const cd = worst("chestDrop");
    if (cd) chk("Out of the bottom", cd.chestDrop <= 6 ? "good" : cd.chestDrop <= 12 ? "warning" : "serious",
      cd.chestDrop <= 6 ? "Chest and hips rise together out of the bottom." : `The hips rise faster than the chest out of the bottom (${cd.chestDrop.toFixed(0)}° more lean on rep ${cd.n}). Drive the upper back up into the bar.`);
  }
  if (lift === "deadlift") {
    const hf = worst("hipsFirst");
    if (hf) chk("Off the floor", hf.hipsFirst <= 5 ? "good" : hf.hipsFirst <= 10 ? "warning" : "serious",
      hf.hipsFirst <= 5 ? "Hips and shoulders rise together off the floor." : `The hips shoot up first (the torso tips ${hf.hipsFirst.toFixed(0)}° forward on rep ${hf.n}). Push the floor away with the legs, chest up.`);
    const lk = worst("hipLock", (a, b) => b < a);
    if (lk) chk("Lockout", lk.hipLock >= 168 ? "good" : lk.hipLock >= 158 ? "warning" : "serious",
      lk.hipLock >= 168 ? "Full lockout: hips straight at the top of every rep." : `Hips not fully locked out on rep ${lk.n} (${lk.hipLock.toFixed(0)}°). Finish by squeezing the glutes, standing tall.`);
    const lb = worst("leanTop", (a, b) => b < a);
    if (lb && lb.leanTop < -10) chk("Leaning back", "warning", `Leaning back ${(-lb.leanTop).toFixed(0)}° at the top of rep ${lb.n}. Stand tall instead; there's nothing to gain past straight.`);
  }
  if (lift === "bench") {
    const sh = avg("shift") * 100;
    chk("Bar path", sh >= 3 && sh <= 18 ? "good" : sh >= 0 && sh < 3 ? "warning" : sh > 18 ? "warning" : "serious",
      sh >= 3 && sh <= 18 ? `The bar travels from the chest back over the shoulders (${sh.toFixed(0)} cm): the usual J-curve.`
        : sh >= 0 && sh < 3 ? `The bar goes nearly straight up (${sh.toFixed(0)} cm toward the head). Letting it drift back over the shoulders is usually stronger.`
          : sh > 18 ? `The bar travels ${sh.toFixed(0)} cm toward your head. Check the touch point isn't too low on the belly.`
            : `The bar drifts ${(-sh).toFixed(0)} cm toward your feet as you press. Press back over the shoulders.`);
    if (R.length > 1) {
      const spread = sd(R.map((r) => r.touch)) * 100;
      chk("Touch point", spread <= 2 ? "good" : spread <= 4 ? "warning" : "serious",
        spread <= 2 ? "The bar touches the same spot on the chest every rep." : `The touch point moves between reps (±${spread.toFixed(0)} cm). Aim for the same spot every time.`);
    }
    const bounce = R.find((r) => r.pause < 0.03 && r.downPeak > 0.7);
    if (bounce) chk("Touch", "warning", `Rep ${bounce.n} comes down fast (${bounce.downPeak.toFixed(2)} m/s) with no pause: it may bounce off the chest.`);
  }
  if (lift === "press") {
    const el = worst("elbowTop", (a, b) => b < a);
    if (el) chk("Lockout", el.elbowTop >= 165 ? "good" : el.elbowTop >= 155 ? "warning" : "serious",
      el.elbowTop >= 165 ? "Elbows locked out overhead on every rep." : `Elbows not fully locked out on rep ${el.n} (${el.elbowTop.toFixed(0)}°). Finish with the biceps by the ears.`);
    const lb = worst("leanBack");
    if (lb) chk("Torso", lb.leanBack <= 8 ? "good" : lb.leanBack <= 15 ? "warning" : "serious",
      lb.leanBack <= 8 ? "The torso stays stacked while pressing." : `Leaning back ${lb.leanBack.toFixed(0)}° while pressing on rep ${lb.n}. Squeeze glutes and abs; move the head, not the hips.`);
  }
  const away = Math.max(...R.map((r) => r.away)) * 100, wander = Math.max(...R.map((r) => r.drift)) * 100;
  if (lift === "squat") chk("Bar path", wander <= 5 ? "good" : wander <= 9 ? "warning" : "serious",
    wander <= 5 ? `The bar goes straight up (within ${wander.toFixed(0)} cm).` : `The bar wanders ${wander.toFixed(0)} cm front-to-back on the way up. Keep it over mid-foot.`);
  if (lift === "deadlift") chk("Bar path", away <= 3 ? "good" : away <= 6 ? "warning" : "serious",
    away <= 3 ? "The bar stays close to the legs on the way up." : `The bar drifts ${away.toFixed(0)} cm away from the legs. Keep it dragging up the shins and thighs.`);
  if (lift === "press") chk("Bar path", away <= 6 ? "good" : away <= 10 ? "warning" : "serious",
    away <= 6 ? "The bar travels close to the face." : `The bar loops ${away.toFixed(0)} cm forward around the face. Move the head back and press straight up.`);

  const notes = [];
  const a0 = R[0].begin, a1 = R[R.length - 1].end;
  let lo = Infinity, hi = 0;
  for (let i = a0; i <= a1; i++) { lo = Math.min(lo, rs[i]); hi = Math.max(hi, rs[i]); }
  const sizeChange = hi / lo - 1;
  if (sizeChange > 0.12) notes.push(`The plate's size on screen changed by ${Math.round(100 * sizeChange)}% during the set, so the camera was close or tilted. Distances are approximate. Film from further back with the phone level.`);
  const lost = gap.slice(a0, a1 + 1).reduce((a, b) => a + b, 0) / fs;
  if (lost > 0.1) notes.push(`The plate was lost for ${lost.toFixed(2)} s during the set; values there are filled in.`);
  if (R.length === 1) notes.push("One rep: velocity loss needs two or more.");
  if (done.length < R.length) notes.push("The last rep doesn't come back to the start, so it isn't counted in velocity loss.");
  if (!side) notes.push(`Body tracking is off or found nobody, so ${lift === "squat" ? "depth" : "body checks"} can't be judged.`);

  const sticky = sticks.length ? sticks.reduce((a, b) => (vy[b.sticking] < vy[a.sticking] ? b : a)) : null;
  let vmaxI = R[0].iPeak;
  for (const r of R) if (vy[r.iPeak] > vy[vmaxI]) vmaxI = r.iPeak;
  const sq = lift === "squat" ? worst("depth", (a, b) => b < a) : null;
  const tiles = [
    { label: "Reps", value: String(R.length), unit: "", note: done.length < R.length ? "last one unfinished" : `${(avg("rom") * 100).toFixed(0)} cm range each` },
    { label: "Best mean speed", value: best.toFixed(2), unit: "m/s", note: `lifting, rep ${bestRep}` },
    { label: "Velocity loss", value: loss === null ? "–" : String(pct(loss)), unit: loss === null ? "" : "%", note: loss === null ? "needs 2+ reps" : "best rep to last" },
    lift === "squat" && sq ? { label: sq.depth >= 0 ? "Below parallel" : "Above parallel", value: (Math.abs(sq.depth) * THIGH_CM).toFixed(0), unit: "cm", note: `shallowest rep (${sq.n}), approx.` }
      : lift === "bench" ? { label: "Touch → lockout", value: fmtSigned(avg("shift") * 100, 0), unit: "cm", note: "toward the head: the J-curve" }
        : variant ? { label: "Dip depth", value: (Math.max(...R.map((r) => r.dip)) * 100).toFixed(0), unit: "cm", note: "before the drive" }
          : { label: "Range of motion", value: (avg("rom") * 100).toFixed(0), unit: "cm", note: "average per rep" },
  ];
  const allDeep = lift === "squat" && withK("depth").length === R.length && R.every((r) => r.depth >= 0.02);

  return {
    lift, variant, X, H, vx, vy, speed, stageOf, stages, repOf, reps: R, metrics: m, checks, notes, sizeChange,
    facing, facingFrom, vmax: vy[vmaxI], ev: { start: a0, vmax: vmaxI },
    t0i: a0, span: [Math.max(0, a0 - Math.round(0.3 * fs)), Math.min(n - 1, a1 + Math.round(0.3 * fs))],
    marks: [
      { i: a0, name: "Start", side: "right" },
      ...R.map((r, k) => ({ i: r.p, name: k === 0 ? turn : null, side: "right" })),
      ...(sticky ? [{ i: sticky.sticking, name: "Sticking point", side: "left" }] : []),
    ],
    tiles,
    axis: { x: lift === "bench" ? ["← feet", "head →"] : ["← back", "forward →"], h: floor ? "m from the floor" : "m from the start", t: "s from the first rep" },
    title: `${LIFTS[lift]}${variant ? ` (${variant})` : ""} · ${R.length} rep${R.length === 1 ? "" : "s"}${allDeep ? " · below parallel" : ""}`,
  };
}

/** a measurement's value as shown (signed: a difference between two lifts) */
export function fmtMetric(m, signed = false) {
  const d = m.unit === "cm" ? (Math.abs(m.value) < 10 && m.label !== "Catch vs start" ? 1 : 0)
    : ["°", "%", "", "W", "N", "J"].includes(m.unit) ? 0 : m.unit === "kg" ? (Number.isInteger(m.value) ? 0 : 1) : 2;
  return signed || m.label === "Catch vs start" ? fmtSigned(m.value, d) : m.value.toFixed(d);
}
export function fmtSigned(v, d = 0) { const s = v.toFixed(d); return Number(s) === 0 ? (0).toFixed(d) : v > 0 ? `+${s}` : s.replace("-", "−"); }
