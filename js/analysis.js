/* From the tracked plate (and the body, when tracked) to the lift: events, stages, measurements, checks.
 *
 * Coordinates: X metres forward of where the bar started (the way the lifter faces), H metres of the
 * bar's centre above the floor (it starts on the floor, so at the plate's radius). Scale comes from
 * the plate: a competition bumper is 450 mm across.
 *
 * Stages of a pull from the floor (snatch or clean):
 *   first pull   lift-off -> knees straight (first knee extension)
 *   transition   knees re-bend under the bar (the "double knee bend")
 *   second pull  -> peak bar speed
 *   turnover     -> the catch (lowest bar after its peak)
 *   recovery     -> standing still
 * Without the body the first pull / transition split comes from the dip in bar speed, when there is one.
 */

export const STAGES = {
  first: { name: "First pull", slot: 1 },
  pull: { name: "Pull", slot: 1 },
  transition: { name: "Transition", slot: 2 },
  second: { name: "Second pull", slot: 3 },
  turnover: { name: "Turnover", slot: 4 },
  recovery: { name: "Recovery", slot: 5 },
};

// MediaPipe pose landmark indices
export const LM = { nose: 0, lShoulder: 11, rShoulder: 12, lWrist: 15, rWrist: 16, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };

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

/* ------------------------------------------------------------------ the analysis */
/**
 * samples: [{t: video media time s, x, y, r: plate centre and radius in video px, ok, pose?: 33 × {x, y, z, v} in video px}]
 * opts: {plateMm=450, slowmo=1, facing: 1 right | -1 left | 0 auto, type: 'auto'|'snatch'|'clean'}
 */
export function analyse(samples, opts = {}) {
  const slow = opts.slowmo > 0 ? opts.slowmo : 1;
  const plate = (opts.plateMm || 450) / 1000;
  const good = samples.filter((s) => s.ok);
  if (good.length < 10 || good.length < 0.3 * samples.length) return { error: "The plate was lost on most frames. Check the circle sits on the plate, and that the plate stays in view." };

  /* real time, uniform grid */
  const tv0 = samples[0].t;
  const real = (tv) => (tv - tv0) / slow;
  const dts = [];
  for (let i = 1; i < samples.length; i++) { const d = real(samples[i].t) - real(samples[i - 1].t); if (d > 1e-5) dts.push(d); }
  const fs = clamp(Math.round(1 / median(dts)), 20, 480);
  const tEnd = real(samples[samples.length - 1].t);
  const n = Math.floor(tEnd * fs) + 1;
  if (n < 0.5 * fs) return { error: "The clip is too short. Include the whole lift, from the set-up to standing." };
  const T = Float64Array.from({ length: n }, (_, i) => i / fs);
  const gt = good.map((s) => real(s.t));
  // 10 Hz keeps the peak of the second pull (within ~3% of a sharp one) while calming tracking noise
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
  const Xr = new Float64Array(n), Hr = new Float64Array(n); // + X = to the right in the picture
  for (let i = 1; i < n; i++) {
    const m = plate / (rs[i] + rs[i - 1]);
    Xr[i] = Xr[i - 1] + (xs[i] - xs[i - 1]) * m;
    Hr[i] = Hr[i - 1] - (ys[i] - ys[i - 1]) * m;
  }
  const rpx = median(good.map((s) => s.r)), mpp = plate / 2 / rpx;

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
  let type = opts.type === "snatch" || opts.type === "clean" ? opts.type : null, typeFrom = "you";
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

  return {
    fs, n, T, X, H, vx, vy, speed, gap, stageOf, stages, ev, jerk, metrics: m, checks, notes,
    xs, ys, rs, tv0, slow, mpp, rpx, plate, sizeChange, metRising,
    facing, facingFrom, type, typeFrom, squat, catchFrom, splitBy, side, poseCover,
    vmax: vy[iV], tVideo: (i) => tv0 + T[i] * slow, indexAt: (tv) => clamp(Math.round(((tv - tv0) / slow) * fs), 0, n - 1),
    title: `${type === "snatch" ? "Snatch" : "Clean"} · ${squat ? "squat" : "power"} catch${jerk ? ` · ${jerk.split === null ? "" : jerk.split ? "split " : "power "}jerk` : ""}`,
  };
}

export function fmtSigned(v, d = 0) { const s = v.toFixed(d); return v > 0 && Number(s) !== 0 ? `+${s}` : s.replace("-", "−"); }
