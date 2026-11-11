/* Rep lifts on a synthetic lifter: a side-on stick figure with real segment lengths, posed through a squat,
 * deadlift, bench press and overhead press, reps slowing down through the set. Checks recognition (from the
 * body, from the bar alone, chosen), rep counting, range, speeds, velocity loss, depth and the checks.
 *
 *   node test/lifts.test.mjs
 */
import { analyse, LM } from "../js/analysis.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) fails++; console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); };
const near = (got, want, tol, msg) => ok(Math.abs(got - want) <= tol, `${msg}: ${got.toFixed(3)} (want ${want.toFixed(3)} ± ${tol})`);

const SEG = { shin: 0.44, thigh: 0.45, trunk: 0.52, upper: 0.3, fore: 0.28, arm: 0.58 };
const rad = (d) => (d * Math.PI) / 180;
const ease = (u) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, u)))) / 2;
const lerp = (a, b, u) => a + (b - a) * u;
const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });

/** standing chain from the ankle: shin forward α, thigh back β (from vertical), trunk forward γ (degrees) */
function chain(a, b, g) {
  const A = { x: 0, y: 0.08 };
  const K = add(A, { x: SEG.shin * Math.sin(rad(a)), y: SEG.shin * Math.cos(rad(a)) });
  const Hp = add(K, { x: -SEG.thigh * Math.sin(rad(b)), y: SEG.thigh * Math.cos(rad(b)) });
  const Sh = add(Hp, { x: SEG.trunk * Math.sin(rad(g)), y: SEG.trunk * Math.cos(rad(g)) });
  const Nose = add(Sh, { x: 0.22 * Math.sin(rad(g)) + 0.08, y: 0.22 * Math.cos(rad(g)) });
  return { A, K, Hp, Sh, Nose, Heel: add(A, { x: -0.06, y: -0.07 }), Toe: add(A, { x: 0.17, y: -0.07 }) };
}
/** elbow for a hand at W, bending away from `bend` (2-link IK) */
function elbow(Sh, W, bend = 1) {
  const dx = W.x - Sh.x, dy = W.y - Sh.y, d = Math.min(Math.hypot(dx, dy), SEG.upper + SEG.fore - 1e-6);
  const a = (SEG.upper ** 2 - SEG.fore ** 2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, SEG.upper ** 2 - a * a));
  const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
  return { x: Sh.x + a * ux - bend * h * uy, y: Sh.y + a * uy + bend * h * ux };
}

/** 33 MediaPipe landmarks in image px (near side = left, smaller z), plus the plate centre */
function frame(body, bar, face) {
  const PPM = 320, X0 = 640, FLOOR = 1000;
  const px = (p, off = 0) => ({ x: X0 + face * (p.x + off) * PPM, y: FLOOR - p.y * PPM });
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, v: 0 }));
  const set = (i, p, z, off = 0) => { const q = px(p, off); lm[i] = { x: q.x, y: q.y, z, v: 0.95 }; };
  set(LM.nose, body.Nose, -0.3);
  for (let i = 1; i <= 10; i++) set(i, body.Nose, -0.25, -0.03);
  const pairs = [["Shoulder", "Sh"], ["Elbow", "E"], ["Wrist", "W"], ["Hip", "Hp"], ["Knee", "K"], ["Ankle", "A"], ["Heel", "Heel"], ["Toe", "Toe"]];
  for (const [name, k] of pairs) { set(LM["l" + name], body[k], -0.2); set(LM["r" + name], body[k], 0.2, 0.01); }
  for (let i = 17; i <= 22; i++) set(i, body.W, i % 2 ? -0.2 : 0.2);
  const plate = px(bar);
  return { x: plate.x, y: plate.y, r: 0.225 * PPM, ok: true, pose: lm };
}

/** a set: lead-in, then per rep [first leg, pause, second leg, rest]; pos(u, k) gives {body, bar} for progress u in rep k */
function set(pos, { reps, first, pause, second, rest, face = 1, fps = 60 }) {
  const plan = [{ d: 0.8, u: () => 0, k: 0 }];
  for (let k = 0; k < reps; k++) {
    plan.push({ d: first, u: (t) => ease(t / first), k }, { d: pause, u: () => 1, k }, { d: second[k], u: (t) => 1 - ease(t / second[k]), k }, { d: rest, u: () => 0, k });
  }
  const out = [];
  let t0 = 0;
  for (const seg of plan) {
    for (let t = 0; t < seg.d - 1e-9; t += 1 / fps) {
      const { body, bar } = pos(seg.u(t), seg.k);
      out.push({ t: t0 + t, ...frame(body, bar, face) });
    }
    t0 += seg.d;
  }
  return out;
}

/* the four lifts */
const squat = (u, k, drift = 0) => {
  // knees and hips bend; the torso leans just enough to keep the bar over mid-foot (6 cm in front of the ankle)
  const a = 8 + 27 * u, bb = 4 + 96 * u;
  const hx = SEG.shin * Math.sin(rad(a)) - SEG.thigh * Math.sin(rad(bb)), barX = 0.06 + drift * 4 * u * (1 - u);
  const b = chain(a, bb, (Math.asin((barX + 0.05 - hx) / SEG.trunk) * 180) / Math.PI);
  const bar = add(b.Sh, { x: -0.05, y: 0.05 });
  const W = add(b.Sh, { x: -0.02, y: 0.03 });
  return { body: { ...b, W, E: elbow(b.Sh, W, -1) }, bar };
};
const deadlift = (u, k, bad = false) => {
  // floor: knees and hips bent, torso tipped; lockout: tall. The bar stays over mid-foot; arms hang to it.
  // hips shooting up: the knees straighten first while the torso tips further forward, then it all catches up
  const g = bad ? (u < 0.4 ? 68 + 30 * u : lerp(80, -2, (u - 0.4) / 0.6)) : lerp(68, -2, u);
  const b = chain(lerp(20, 0, u), lerp(75, 0, u), g);
  const bx = 0.06, dx = b.Sh.x - bx;
  const bar = { x: bx, y: b.Sh.y - Math.sqrt(Math.max(0, SEG.arm ** 2 - dx * dx)) };
  return { body: { ...b, W: bar, E: elbow(b.Sh, bar, 1) }, bar };
};
const bench = (u) => {
  const Sh = { x: 0, y: 0.55 }, Hp = { x: -0.52, y: 0.55 }, K = { x: -0.92, y: 0.5 }, A = { x: -1.05, y: 0.08 };
  const bar = { x: lerp(0.0, -0.1, u), y: lerp(1.12, 0.72, u) }; // lockout over the shoulders, touch on the lower chest
  return { body: { Sh, Hp, K, A, Nose: { x: 0.2, y: 0.62 }, Heel: add(A, { x: -0.06, y: -0.07 }), Toe: add(A, { x: 0.17, y: -0.07 }), W: bar, E: elbow(Sh, bar, -1) }, bar };
};
const press = (u) => {
  const b = chain(4, 2, -2);
  const bar = { x: b.Sh.x + lerp(0.07, -0.01, u) + 0.04 * Math.sin(Math.PI * u), y: b.Sh.y + lerp(0.03, 0.578, u) };
  return { body: { ...b, W: bar, E: elbow(b.Sh, bar, 1) }, bar };
};

const noPose = (S) => S.map(({ pose, ...s }) => s);
const run = (name, S, want, opts = {}) => {
  const R = analyse(S, opts);
  console.log(`\n== ${name}: ${R.error || R.title}  (lift ${R.lift} from ${R.liftFrom}${R.liftWhy ? `: ${R.liftWhy}` : ""}, facing ${R.facing} from ${R.facingFrom}, peak ${R.vmax?.toFixed(2)} m/s)`);
  if (R.error) { fails++; return R; }
  ok(R.lift === want.lift, `recognised as ${want.lift}`);
  if (want.from) ok(R.liftFrom === want.from, `recognised from the ${want.from}`);
  if (want.reps) ok(R.reps?.length === want.reps, `${want.reps} reps (got ${R.reps?.length})`);
  if (want.face) ok(R.facing === want.face, `facing ${want.face}`);
  console.log("   reps:", (R.reps || []).map((r) => `${r.n}: ${(r.rom * 100).toFixed(0)} cm, ${r.mean.toFixed(2)} m/s, down ${r.down.toFixed(2)} s, pause ${r.pause.toFixed(2)} s, up ${r.up.toFixed(2)} s`).join(" | "));
  console.log("   checks:", R.checks.map((c) => `${c.title}=${c.status}`).join(", "));
  return R;
};

const sq = set(squat, { reps: 5, first: 1.0, pause: 0.15, second: [0.8, 0.85, 0.95, 1.05, 1.2], rest: 0.6, face: -1 });
let R = run("squat × 5, facing left", sq, { lift: "squat", from: "body", reps: 5, face: -1 });
const rom = squat(0).bar.y - squat(1).bar.y;
near(R.reps[0].rom, rom, 0.02, "range of motion (m)");
// mean lifting speed is taken over the part where the bar is really moving (> 0.05 m/s), so above range / 0.8 s
ok(R.reps[0].mean > rom / 0.8 && R.reps[0].mean < (1.3 * rom) / 0.8, `rep 1 mean lifting speed ${R.reps[0].mean.toFixed(2)} m/s, a bit above ${(rom / 0.8).toFixed(2)}`);
ok(R.checks.find((c) => c.title === "Bar path")?.status === "good", "bar stays over mid-foot");
ok(R.reps[4].mean < R.reps[0].mean, "reps slow down");
near(R.metrics.find((m) => m.label === "Velocity loss").value, 100 * (1 - 0.8 / 1.2), 6, "velocity loss (%)");
ok(R.checks.find((c) => c.title === "Depth")?.status === "good", "depth: below parallel");
ok(/below parallel/.test(R.title), "title says below parallel");
run("squat, bar only", noPose(sq), { lift: "squat", from: "bar", reps: 5 });
R = run("squat, bar drifts forward", set((u, k) => squat(u, k, 0.1), { reps: 3, first: 1.0, pause: 0.15, second: [0.8, 0.8, 0.8], rest: 0.6 }), { lift: "squat", reps: 3 });
ok(R.checks.find((c) => c.title === "Bar path")?.status !== "good", "forward drift is flagged");

const dl = set(deadlift, { reps: 3, first: 1.1, pause: 0.5, second: [0.9, 0.9, 0.9], rest: 0.6 });
R = run("deadlift × 3", dl, { lift: "deadlift", from: "body", reps: 3, face: 1 });
near(R.H[R.reps[0].begin], 0.225, 0.02, "starts on the floor (bar height, m)");
ok(R.checks.find((c) => c.title === "Off the floor")?.status === "good", "hips and shoulders rise together");
ok(R.checks.find((c) => c.title === "Lockout")?.status === "good", "full lockout");
ok(R.checks.find((c) => c.title === "Bar path")?.status === "good", "bar stays close");
const dlBad = set((u, k) => deadlift(u, k, true), { reps: 3, first: 1.4, pause: 0.5, second: [0.9, 0.9, 0.9], rest: 0.6 });
R = run("deadlift, hips shoot up", dlBad, { lift: "deadlift", reps: 3 });
ok(R.checks.find((c) => c.title === "Off the floor")?.status !== "good", "hips shooting up is flagged");
run("deadlift, bar only", noPose(dl), { lift: "deadlift", from: "bar", reps: 3 });

const bp = set(bench, { reps: 5, first: 1.0, pause: 0.25, second: [0.7, 0.75, 0.8, 0.9, 1.0], rest: 0.4 });
R = run("bench × 5", bp, { lift: "bench", from: "body", reps: 5, face: 1 });
near(R.reps[0].shift, 0.1, 0.02, "touch → lockout toward the head (m)");
ok(R.checks.find((c) => c.title === "Bar path")?.status === "good", "J-curve");
ok(R.checks.find((c) => c.title === "Touch point")?.status === "good", "same touch point");
R = run("bench, bar only (looks like a squat)", noPose(bp), { lift: "squat", from: "bar" });
run("bench, bar only, chosen", noPose(bp), { lift: "bench", from: "you", reps: 5 }, { lift: "bench" });

const op = set(press, { reps: 3, first: 0.9, pause: 0.4, second: [1.0, 1.0, 1.0], rest: 0.6 });
R = run("overhead press × 3", op, { lift: "press", from: "body", reps: 3 });
ok(R.checks.find((c) => c.title === "Lockout")?.status === "good", "elbows locked out");
ok(R.checks.find((c) => c.title === "Torso")?.status === "good", "torso stacked");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
