// The same flow in Chrome on the phone, over ONE tab's DevTools socket (never attaches to the whole browser).
// Needs: adb reverse tcp:8765 tcp:8765, the app open at http://localhost:8765 on the phone, and
//   adb forward tcp:9333 localabstract:chrome_devtools_remote
//   node test/phone.mjs http://localhost:9333 http://localhost:8765 <video url on the app server> <at s> <x,y> <out dir> [pose]
import { writeFileSync } from "node:fs";

const [base, prefix, videoUrl, at, tap, outDir, pose = "full"] = process.argv.slice(2);
const targets = await (await fetch(`${base}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.startsWith(prefix));
if (!target) throw new Error(`no tab at ${prefix}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
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
await ev(`localStorage.setItem("barpath.settings", JSON.stringify({ poseModel: ${JSON.stringify(pose)} })); true`);
await send("Page.reload", { ignoreCache: true });
await sleep(1500);
await until(`!!document.getElementById("fileInput") && !!window.__barpath`);
console.log("screen:", await ev(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, secure: isSecureContext, ua: navigator.userAgent.slice(0, 60) })`));
console.log("record button:", await ev(`document.getElementById("recordHint").textContent || "in-app recording available"`));
await shot("p01-start");

// a picked file, as the file chooser would deliver it
await ev(`(async () => { const b = await (await fetch(${JSON.stringify(videoUrl)})).blob(); const f = new File([b], "Snatch.mp4", { type: "video/mp4" });
  const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById("fileInput"); i.files = dt.files; i.dispatchEvent(new Event("change")); return true; })()`);
await until(`/fps/.test(document.getElementById("videoInfo").textContent)`, 30000);
console.log("video:", await ev(`document.getElementById("videoInfo").textContent`));
await ev(`(() => { const s = document.getElementById("scrub"), v = document.getElementById("video"); s.value = String(Math.round((${+at} / v.duration) * 10000)); s.dispatchEvent(new Event("input")); return true; })()`);
await until(`Math.abs(document.getElementById("video").currentTime - ${+at}) < 0.05 && !document.getElementById("video").seeking`, 10000);
await sleep(400);

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
    run: S.runStats, stages: R.stages.map((s) => s.name + " " + s.dur.toFixed(2)), checks: R.checks.map((c) => c.title + ":" + c.status), notes: R.notes,
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
ws.close();
