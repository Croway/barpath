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
} else {
  const file = process.argv[2];
  const S = JSON.parse(readFileSync(file.replace(/\.\w+$/, ".samples.json"), "utf8"));
  const T = JSON.parse(readFileSync(file.replace(/\.\w+$/, ".truth.json"), "utf8"));
  // tracked: the synthetic scene can cost a few % of radius (see track.test.mjs), so heights get 5% more room
  check(analyse(S, { slowmo: T.slowmo }), `tracked ${file.split("/").pop()}`, { ...REF, ...T.ref }, 1, 0.05);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
