/* Checks the analysis against the synthetic lift's ground truth.
 *
 *   node test/analysis.test.mjs synth.mp4      (needs synth.samples.json from track.test.mjs)
 *   node test/analysis.test.mjs --ideal        (perfect tracking at 30, 60, 240 fps, plus drop-outs)
 */
import { readFileSync } from "node:fs";
import { analyse } from "../js/analysis.js";
import { truthAt } from "./synth.mjs";

let fails = 0;
const expect = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(28)} ${got.toFixed(3)}  (truth ${want.toFixed(3)} ± ${tol})`);
};
// heights scale with the plate's measured radius; `rel` allows for a known radius error (relative)
function check(R, label, ref, face = 1, rel = 0) {
  console.log(`\n== ${label}: ${R.error || R.title}  (fs ${R.fs} Hz, facing ${R.facing} from ${R.facingFrom}, split by ${R.splitBy})`);
  if (R.error) { fails++; return; }
  const t = (i) => R.T[i];
  expect("lift-off time", t(R.ev.liftoff), ref.t_liftoff, 0.06); // detection fires at 0.05 m/s
  expect("peak speed m/s", R.vmax, ref.vmax, 0.09); // a 10 Hz filter shaves a sharp peak by ~3%
  expect("peak speed time", t(R.ev.vmax), ref.t_vmax, 0.03);
  expect("peak height m", R.H[R.ev.peak], ref.peak, 0.015 + rel * ref.peak);
  expect("catch height m", R.H[R.ev.catch], ref.catch, 0.015 + rel * ref.catch);
  expect("standing height m", R.H[R.ev.stand], 1.75, 0.02 + rel * 1.75);
  expect("most back in pull cm", -R.X[R.ev.back] * 100, 5, 0.8);
  expect("catch vs start cm", R.X[R.ev.catch] * 100, -2, 0.8);
  if (R.lift !== "snatch") { fails++; console.log("FAIL lift", R.lift); }
  if (!R.squat) { fails++; console.log("FAIL catch should be squat"); }
  if (R.facing !== face) { fails++; console.log("FAIL facing", R.facing); }
  if (ref.split && R.splitBy === null) { fails++; console.log("FAIL first pull / transition not split"); }
  console.log("stages:", R.stages.map((s) => `${s.name} ${s.dur.toFixed(2)}s`).join(" · "));
  console.log("checks:", R.checks.map((c) => `${c.title}=${c.status}`).join(", "));
  if (R.notes.length) console.log("notes:", R.notes.join(" | "));
}
const REF = { t_liftoff: 0.8, vmax: 1.899, t_vmax: 1.619, peak: 1.07, catch: 0.94, split: true };
const PPM = 266.7, X0 = 576, FLOOR = 680;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); // deterministic runs
const ideal = (fps, { drop = 0, jitter = 0, slow = 1 } = {}) => {
  const out = [];
  for (let f = 0; f < 4.5 * fps; f++) {
    const t = f / fps, p = truthAt(t);
    out.push({ t: t * slow, x: X0 + p.x * PPM + (rand() - 0.5) * jitter, y: FLOOR - p.y * PPM + (rand() - 0.5) * jitter, r: 0.225 * PPM, ok: rand() >= drop });
  }
  return out;
};

if (process.argv.includes("--ideal")) {
  check(analyse(ideal(60)), "ideal 60 fps", REF);
  check(analyse(ideal(30)), "ideal 30 fps", REF);
  check(analyse(ideal(240, { slow: 8 }), { slowmo: 8 }), "ideal 240 fps slow-mo file (x8)", REF);
  check(analyse(ideal(60, { drop: 0.25, jitter: 1.5 })), "60 fps, 25% frames lost, ±0.75 px jitter", REF);
  // the same lift filmed from the other side: the analysis has to work out the facing on its own
  const flipped = ideal(60).map((s) => ({ ...s, x: 2 * X0 - s.x }));
  check(analyse(flipped), "60 fps, lifter facing left", REF, -1);

  // the published bar path measures, stages split at peak height, the height share
  {
    const R = analyse(ideal(60), { heightCm: 170 }), M = Object.fromEntries(R.metrics.map((m) => [m.label, m.value]));
    console.log("\n== bar path measures, ideal 60 fps");
    // the synthetic bar: back 5 cm, forward to +3 cm (across the start line), back to −2 cm at the catch: type 1
    expect("bar path type", M["Bar path type"], 1, 0);
    expect("loop back to the catch cm", M["Loop back to the catch"], 5, 0.5);
    expect("angle back off the floor °", M["Angle back off the floor"], (Math.atan2(0.05, 0.655 - 0.225) * 180) / Math.PI, 1);
    expect("peak height % of 1.70 m", M["Peak bar height, share of your height"], (100 * 1.07) / 1.7, 1);
    const turn = R.stages.find((s) => s.id === "turnover"), cat = R.stages.find((s) => s.id === "catch");
    expect("turnover ends at peak height", turn.i1, R.ev.peak, 0);
    expect("catch stage: peak height → catch", cat.i1 - cat.i0, R.ev.catch - R.ev.peak, 0);
    if (R.stages.map((s) => s.slot).join() !== "1,2,3,4,5,6") { fails++; console.log("FAIL stage slots", R.stages.map((s) => s.slot).join()); }
  }

  // a bar that never slows between the pulls, the body not tracked: the first pull ends where the bar is furthest
  // back (Nagao 2019), the transition staying in the second pull
  const herm = (K, t) => {
    t = Math.max(K[0][0], Math.min(K[K.length - 1][0], t));
    let i = 0;
    while (i < K.length - 2 && t > K[i + 1][0]) i++;
    const [t0, p0, m0] = K[i], [t1, p1, m1] = K[i + 1], h = t1 - t0, s = (t - t0) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * m1;
  };
  const film = (YK, XK, T) => Array.from({ length: Math.round(T * 60) }, (_, f) => ({ t: f / 60, x: X0 + herm(XK, f / 60) * PPM, y: FLOOR - herm(YK, f / 60) * PPM, r: 0.225 * PPM, ok: true }));
  {
    const YK = [[0, 0.225, 0], [0.8, 0.225, 0], [1.35, 0.52, 1.1], [1.47, 0.66, 1.3], [1.62, 0.89, 1.9], [1.81, 1.07, 0],
      [2.0, 0.95, -0.2], [2.1, 0.94, 0], [2.4, 0.94, 0], [3.4, 1.75, 0], [4.5, 1.75, 0]];
    const XK = [[0, 0, 0], [0.8, 0, 0], [1.35, -0.04, -0.03], [1.47, -0.05, 0], [1.62, -0.01, 0.35], [1.81, 0.03, 0.05],
      [2.0, 0.0, -0.25], [2.1, -0.02, 0], [2.4, -0.02, 0], [4.5, -0.02, 0]];
    const R = analyse(film(YK, XK, 4.5));
    console.log(`\n== no speed dip, bar only: ${R.title}, split by ${R.splitBy}`);
    if (R.splitBy !== "bar path") { fails++; console.log("FAIL split by", R.splitBy); }
    expect("first pull ends (s)", R.T[R.ev.first], 1.47, 0.05);
    console.log("stages:", R.stages.map((s) => `${s.name} ${s.dur.toFixed(2)}s`).join(" · "));
  }

  // clean and jerk: a 16 cm dip at up to 0.96 m/s (1.5 × its mean speed), a drive peaking at 1.79 m/s (the spline
  // overshoots its 1.7 m/s keyframe just before it), a split catch
  {
    const YK = [[0, 0.225, 0], [0.8, 0.225, 0], [1.35, 0.5, 1.1], [1.47, 0.62, 0.95], [1.62, 0.82, 1.6], [1.78, 0.95, 0],
      [1.95, 0.86, -0.3], [2.05, 0.85, 0], [2.3, 0.85, 0], [3.4, 1.45, 0], [4.5, 1.45, 0], [4.75, 1.29, 0], [4.95, 1.55, 1.7],
      [5.15, 1.68, 0], [5.3, 1.6, 0], [6.3, 2.0, 0], [7.0, 2.0, 0]];
    const XK = [[0, 0, 0], [0.8, 0, 0], [1.35, -0.04, 0], [1.62, -0.01, 0.3], [1.78, 0.02, 0], [2.05, -0.03, 0], [7.0, -0.03, 0]];
    const R = analyse(film(YK, XK, 7.0), { heightCm: 170 }), M = Object.fromEntries(R.metrics.map((m) => [m.label, m.value]));
    console.log(`\n== clean and jerk, bar only: ${R.title}`);
    if (!R.jerk) { fails++; console.log("FAIL no jerk found"); } else {
      expect("dip depth cm", M["Dip depth"], 16, 1);
      expect("dip % of 1.70 m", M["Dip depth, share of your height"], 16 / 1.7, 0.6);
      expect("dip peak speed m/s", M["Dip peak speed"], 0.96, 0.08);
      expect("drive peak speed m/s", M["Drive peak speed"], 1.79, 0.08);
      expect("drive vs dip speed", M["Drive vs dip speed"], 1.79 / 0.96, 0.15);
    }
  }
  // power with the load, against the truth: force m(g + a) and power F·v from the exact path, over the pull
  const KG = 60, G = 9.81, d = 1e-3, at = (t) => truthAt(t);
  const vel = (t) => ({ x: (at(t + d).x - at(t - d).x) / (2 * d), y: (at(t + d).y - at(t - d).y) / (2 * d) });
  const acc = (t) => ({ x: (vel(t + d).x - vel(t - d).x) / (2 * d), y: (vel(t + d).y - vel(t - d).y) / (2 * d) });
  let pPeak = 0, fPeak = 0, pSum = 0, k = 0;
  for (let t = REF.t_liftoff; t <= REF.t_vmax; t += d) {
    const v = vel(t), a = acc(t), p = KG * (a.x * v.x + (a.y + G) * v.y);
    pPeak = Math.max(pPeak, p); fPeak = Math.max(fPeak, KG * (a.y + G)); pSum += p; k++;
  }
  for (const [fps, opt] of [[60, {}], [30, {}], [60, { drop: 0.25, jitter: 1.5 }]]) {
    const R = analyse(ideal(fps, opt), { kg: KG }), M = Object.fromEntries(R.metrics.filter((m) => m.group === "Power").map((m) => [m.label, m.value]));
    console.log(`\n== power, ${KG} kg, ${fps} fps${opt.drop ? ", 25% lost, jitter" : ""}`);
    expect("peak power W", M["Peak power"], pPeak, 0.12 * pPeak);
    expect("mean pull power W", M["Mean power in the pull"], pSum / k, 0.06 * (pSum / k));
    // the synthetic path is a C1 spline: its acceleration jumps at the keyframes, a spike the 10 Hz smoothing of
    // positions can't keep (a real bar's acceleration is smoother). Hence the wider margin, and "approx." in the app.
    expect("peak force N", M["Peak force on the bar"], fPeak, 0.2 * fPeak);
  }
} else {
  const file = process.argv[2];
  const S = JSON.parse(readFileSync(file.replace(/\.\w+$/, ".samples.json"), "utf8"));
  const T = JSON.parse(readFileSync(file.replace(/\.\w+$/, ".truth.json"), "utf8"));
  // tracked: the synthetic scene can cost a few % of radius (see track.test.mjs), so heights get 5% more room
  check(analyse(S, { slowmo: T.slowmo }), `tracked ${file.split("/").pop()}`, { ...REF, ...T.ref }, 1, 0.05);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
