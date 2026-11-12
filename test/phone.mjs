// The same flow in Chrome on the phone, over ONE tab's DevTools socket (never attaches to the whole browser).
// Needs: adb reverse tcp:8765 tcp:8765, the app open at http://localhost:8765 on the phone, and
//   adb forward tcp:9333 localabstract:chrome_devtools_remote
//   node test/phone.mjs http://localhost:9333 http://localhost:8765 <video url on the app server | shared> <at s[-end s]> <x,y> <out dir> [pose]
// <at>: where to drag the timeline's start handle (and, with -end, its end handle), with real touches.
// --gallery [--kg 60]: then enter the load, open the gallery, and compare the two newest lifts (with real taps).
// "file:<local path>": hand the video over DevTools (no server needed): to the installed app's window when it's
// open (an offline test), otherwise to the tab at <prefix> (e.g. the published app in Chrome).
// "shared": the video was shared to the installed app (Android share sheet / am start SEND); attach to the
// installed app's window (display-mode: standalone) and use the video it opened.
import { writeFileSync } from "node:fs";

const [base, prefix, videoUrl, at, tap, outDir, pose = "full"] = process.argv.slice(2);
const shared = videoUrl === "shared" || videoUrl.startsWith("file:");
const inject = videoUrl.startsWith("file:") ? (await import("node:fs")).readFileSync(videoUrl.slice(5)).toString("base64") : null;
const targets = (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === "page" && t.url.startsWith(prefix));
if (!targets.length) throw new Error(`no tab at ${prefix}`);
// an installed app's window and Chrome tabs can share the URL: probe each for display-mode when it matters
async function open(t) {
  const sock = new WebSocket(t.webSocketDebuggerUrl);
  await Promise.race([new Promise((r) => (sock.onopen = r)), new Promise((_, j) => setTimeout(() => j(new Error("ws timeout")), 8000))]);
  return sock;
}
let ws = null;
for (const t of targets) {
  const sock = await open(t).catch(() => null);
  if (!sock) continue;
  if (!shared) { ws = sock; break; }
  const v = await new Promise((r) => { sock.onmessage = (m) => r(JSON.parse(m.data)); sock.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: 'matchMedia("(display-mode: standalone)").matches', returnByValue: true } })); setTimeout(() => r(null), 5000); });
  if (v?.result?.result?.value) { ws = sock; break; }
  sock.close();
}
if (!ws && inject) ws = await open(targets[0]).catch(() => null);
if (!ws) throw new Error(shared ? "the installed app's window isn't open" : "no reachable tab");
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const until = async (expr, ms = 60000, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return; await new Promise((r) => setTimeout(r, step)); } throw new Error(`timeout: ${expr}`); };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.data, "base64")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
if (!shared) {
  await ev(`localStorage.setItem("barpath.settings", JSON.stringify({ poseModel: ${JSON.stringify(pose)} })); true`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(1500);
}
await until(`!!document.getElementById("fileInput") && !!window.__barpath`);
console.log("app:", await ev(`(async () => JSON.stringify({ standalone: matchMedia("(display-mode: standalone)").matches, controlledBySW: !!navigator.serviceWorker.controller, server: await fetch("index.html", { method: "HEAD", cache: "no-store" }).then(() => "reachable", () => "unreachable (running from the app cache)") }))()`));
console.log("screen:", await ev(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, secure: isSecureContext, ua: navigator.userAgent.slice(0, 60) })`));
console.log("record button:", await ev(`document.getElementById("recordHint").textContent || "in-app recording available"`));
await shot("p01-start");

// a picked file, as the file chooser would deliver it (or, when shared, the one the app already opened)
// file:<path>: the bytes are handed over through DevTools, so no server is needed (offline test of the installed app)
if (inject) await ev(`(() => { const s = atob(${JSON.stringify(inject)}), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([a], "Snatch.mp4", { type: "video/mp4" })); const i = document.getElementById("fileInput"); i.files = dt.files; i.dispatchEvent(new Event("change")); return true; })()`);
if (!shared) await ev(`(async () => { const b = await (await fetch(${JSON.stringify(videoUrl)})).blob(); const f = new File([b], "Snatch.mp4", { type: "video/mp4" });
  const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById("fileInput"); i.files = dt.files; i.dispatchEvent(new Event("change")); return true; })()`);
await until(`/fps/.test(document.getElementById("videoInfo").textContent)`, 30000);
console.log("video:", await ev(`document.getElementById("videoInfo").textContent`));
// choose the part with a finger on the timeline's handles: end first (letting go shows the start again), then start
const [atS, endS] = at.split("-").map(Number);
async function dragHandle(which, t) {
  const g = await ev(`(() => { const tl = document.getElementById("timeline").getBoundingClientRect(), h = document.querySelector(".timeline .handle.${which}").getBoundingClientRect();
    return { left: tl.left, width: tl.width, hx: h.left + h.width / 2, hy: h.top + h.height / 2, hw: h.width, d: document.getElementById("video").duration }; })()`);
  const x = g.left + g.hw + (t / g.d) * (g.width - 2 * g.hw) + (which === "in" ? -g.hw / 2 : g.hw / 2);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: g.hx, y: g.hy }] });
  for (let i = 1; i <= 16; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: g.hx + ((x - g.hx) * i) / 16, y: g.hy }] }); await sleep(30); }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
await ev(`document.getElementById("timeline").scrollIntoView({ block: "center" }), true`);
await sleep(300);
if (endS) await dragHandle("out", endS);
await dragHandle("in", atS);
await until(`Math.abs(document.getElementById("video").currentTime - window.__barpath.start) < 0.02 && !document.getElementById("video").seeking`, 10000);
console.log("part:", await ev(`document.getElementById("timeRead").textContent`), "| start", await ev(`window.__barpath.start.toFixed(3)`), "end", await ev(`String(window.__barpath.end?.toFixed(3) ?? "video end")`));
await ev(`window.scrollTo(0, 0), true`);
await sleep(400);
await shot("p01b-part");

// tap the plate with a real touch
const [tx, ty] = tap.split(",").map(Number);
const pt = await ev(`(() => { const r = document.getElementById("overlay").getBoundingClientRect(), S = window.__barpath; return { x: r.left + (${tx} / S.W) * r.width, y: r.top + (${ty} / S.H) * r.height }; })()`);
await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y }] });
await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await until(`!document.getElementById("btnAnalyse").disabled`, 10000);
console.log("plate:", await ev(`JSON.stringify(window.__barpath.plate)`), "|", await ev(`document.getElementById("markInstr").textContent`));
await shot("p02-marked");

const t0 = Date.now();
await ev(`document.getElementById("btnAnalyse").click(), true`);
await sleep(2500);
await shot("p03-running");
await until(`!document.getElementById("results").hidden || /stopped|lost|never|No lift|short/.test(document.getElementById("markInstr").textContent)`, 300000, 500);
const out = await ev(`(() => { const S = window.__barpath, R = S.R; if (!R) return { error: document.getElementById("markInstr").textContent };
  return { title: R.title, sub: document.getElementById("resSub").textContent, vmax: +R.vmax.toFixed(3), frames: S.samples.length, lost: S.samples.filter((s) => !s.ok).length,
    part: [S.samples[0].t, S.samples[S.samples.length - 1].t].map((t) => +t.toFixed(3)), run: S.runStats, stages: R.stages.map((s) => s.name + " " + s.dur.toFixed(2)), checks: R.checks.map((c) => c.title + ":" + c.status), notes: R.notes,
    tiles: [...document.querySelectorAll(".tile")].map((t) => t.innerText.replace(/\\n/g, " ")) }; })()`);
console.log(`results after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(out, null, 1));
await ev(`window.scrollTo(0, 0), true`);
await shot("p04-results");
await ev(`document.getElementById("pathChart").scrollIntoView({ block: "start" }), true`);
await sleep(400);
await shot("p05-path");
await ev(`document.getElementById("checks").scrollIntoView({ block: "center" }), true`);
await sleep(400);
await shot("p06-checks");
await ev(`window.scrollTo(0, 0), true`);

if (process.argv.includes("--gallery")) {
  const kgArg = process.argv.indexOf("--kg"), kg = kgArg > 0 ? +process.argv[kgArg + 1] : 60;
  const tapEl = async (sel, k = 0) => {
    const p = await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${k}]; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await sleep(250);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await ev(`(() => { const i = document.getElementById("kg"); i.value = "${kg}"; i.dispatchEvent(new Event("input")); return true; })()`);
  await until(`window.__barpath.R.kg === ${kg} && /Saved in the gallery/.test(document.getElementById("resSaved").textContent)`, 15000);
  await sleep(900);
  console.log("with the load:", await ev(`[...document.querySelectorAll(".tile")].map((t) => t.innerText.replace(/\\n/g, " ")).filter((t) => /power/i.test(t)).join(" | ")`));
  await tapEl("#btnGallery2");
  await until(`!document.getElementById("gallery").hidden && document.querySelectorAll("#galList .lift").length >= 1`, 10000);
  await sleep(800);
  await ev(`window.scrollTo(0, 0), true`);
  await shot("p07-gallery");
  const n = await ev(`document.querySelectorAll("#galList .lift").length`);
  console.log("gallery:", await ev(`document.getElementById("galSummary").textContent`), "|", await ev(`[...document.querySelectorAll("#galList .txt")].map((e) => e.innerText.replace(/\\n/g, " / ")).join(" || ")`));
  if (n >= 2) {
    await tapEl("#galList .pick input", 0);
    await tapEl("#galList .pick input", 1);
    await until(`!document.getElementById("btnGalCompare").disabled`, 5000);
    await tapEl("#btnGalCompare");
    await until(`(() => { const C = window.__barpathCompare; return C.L.length >= 2 && C.L.every((l) => l.video.readyState >= 2 && !l.busy); })()`, 30000);
    await ev(`window.scrollTo(0, 0), true`);
    await sleep(600);
    await shot("p08-compare");
    await tapEl("#cmpPlay");
    await sleep(2500);
    console.log("compare playing:", await ev(`(() => { const C = window.__barpathCompare; return JSON.stringify({ tau: +C.tau.toFixed(2), playing: C.playing, drift_s: C.L.map((l) => +Math.abs(l.video.currentTime - C.vt(l, C.tau)).toFixed(3)) }); })()`));
    await ev(`window.scrollTo(0, 0), true`);
    await shot("p09-compare-playing");
    await tapEl("#cmpPlay");
    await ev(`document.getElementById("cmpTable").scrollIntoView({ block: "start" }), true`);
    await sleep(400);
    await shot("p10-compare-table");
  }
}
ws.close();
