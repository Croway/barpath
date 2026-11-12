// End-to-end in headless Google Chrome at Galaxy S23 size (360x780 CSS px, DPR 3, touch): load a video, drag the
// timeline's handles to the part to analyse, tap the plate, analyse, scrub the charts, replay, share the app.
// Screenshots and the tracked samples go to <out dir>.
//   node test/e2e.mjs . <video.mp4> <truth.json | -> <out dir> [--at s] [--end s] [--tap x,y] [--pose off|lite|full] [--dark]
//   synthetic: node test/synth.mjs /tmp/s.mp4 && node test/e2e.mjs . /tmp/s.mp4 /tmp/s.truth.json /tmp/out
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import jsQR from "jsqr";

const [appDir, videoPath, truthPath, outDir] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
const camera = arg("camera", null), pose = arg("pose", "full"), dark = process.argv.includes("--dark");
const T = truthPath && truthPath !== "-" ? JSON.parse(readFileSync(truthPath, "utf8")) : null;
const tapArg = arg("tap", null);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const root = resolve(appDir), p = join(root, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root + sep) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;

const args = ["--autoplay-policy=no-user-gesture-required"];
if (camera) args.push("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${camera}`);
const browser = await chromium.launch({ channel: "chrome", headless: true, args });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light", permissions: camera ? ["camera"] : [] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
/** a finger dragged across the screen (CSS px), as the phone delivers it: touch → pointer events */
async function touchDrag(x0, y, x1, steps = 14) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }] });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
/** drag a timeline handle ("in" or "out") from its middle until its edge sits at video time t */
async function dragHandle(which, t) {
  const g = await page.evaluate((w) => {
    const tl = document.getElementById("timeline").getBoundingClientRect(), h = document.querySelector(`.timeline .handle.${w}`).getBoundingClientRect();
    return { left: tl.left, width: tl.width, hx: h.left + h.width / 2, hy: h.top + h.height / 2, hw: h.width, d: document.getElementById("video").duration };
  }, which);
  const x = g.left + g.hw + (t / g.d) * (g.width - 2 * g.hw) + (which === "in" ? -g.hw / 2 : g.hw / 2);
  await touchDrag(g.hx, g.hy, x);
}
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`); });
await page.goto(url);
await page.evaluate((p) => { localStorage.setItem("barpath.settings", JSON.stringify({ poseModel: p })); }, pose);
await page.reload();
await page.screenshot({ path: `${outDir}/01-start.png` });

const t0 = Date.now();
if (camera) {
  await page.tap("#btnRecord");
  await page.waitForSelector("#camera:not([hidden])");
  await page.waitForFunction(() => document.getElementById("camVideo").videoWidth > 0, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  console.log("camera:", await page.textContent("#camInfo"));
  await page.screenshot({ path: `${outDir}/02-camera.png` });
  await page.tap("#btnRecToggle");
  await page.waitForTimeout(5200);
  await page.tap("#btnRecToggle");
} else {
  await page.setInputFiles("#fileInput", videoPath);
}
await page.waitForFunction(() => /fps/.test(document.getElementById("videoInfo").textContent), null, { timeout: 30000 });
console.log("video:", await page.textContent("#videoInfo"));

// choose the part: the end handle to --end, the start handle to the set-up (--at seconds); then tap the plate
const at = arg("at", null), endAt = arg("end", null);
const settled = (t) => page.waitForFunction((t) => Math.abs(document.getElementById("video").currentTime - t) < 0.02 && !document.getElementById("video").seeking, t, { timeout: 10000 });
if (endAt) {
  await dragHandle("out", +endAt);
  const S = await page.evaluate(() => ({ start: window.__barpath.start, end: window.__barpath.end }));
  if (Math.abs(S.end - +endAt) > 0.05) throw new Error(`end handle at ${S.end}, wanted ${endAt}`);
  await settled(S.start); // letting go of the end handle shows the start frame again
}
if (at) {
  await dragHandle("in", +at);
  const st = await page.evaluate(() => window.__barpath.start);
  if (Math.abs(st - +at) > 0.05) throw new Error(`start handle at ${st}, wanted ${at}`);
  await settled(st);
  await page.waitForTimeout(300);
}
console.log("part:", await page.textContent("#timeRead"));
await page.screenshot({ path: `${outDir}/02-part.png` });
const box = await page.locator("#overlay").boundingBox();
const vw = await page.evaluate(() => [window.__barpath.W, window.__barpath.H]);
let tx, ty;
if (tapArg) [tx, ty] = tapArg.split(",").map(Number);
else { tx = T.start.x * (vw[0] / T.W) + 0.2 * T.R * (vw[0] / T.W); ty = T.start.y * (vw[1] / T.H) - 0.1 * T.R * (vw[1] / T.H); }
await page.touchscreen.tap(box.x + (tx / vw[0]) * box.width, box.y + (ty / vw[1]) * box.height);
await page.waitForFunction(() => !document.getElementById("btnAnalyse").disabled);
const plate = await page.evaluate(() => window.__barpath.plate);
if (at && Math.abs((await page.evaluate(() => window.__barpath.start)) - +at) > 0.05) throw new Error("tapping the plate moved the start");
console.log("plate:", JSON.stringify(plate), T && !camera ? `truth (${T.start.x}, ${T.start.y}) r ${T.R.toFixed(1)}` : "");
console.log("mark:", await page.textContent("#markInstr"));
await page.screenshot({ path: `${outDir}/03-marked.png` });

await page.tap("#btnAnalyse");
await page.waitForSelector("#running:not([hidden])");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/04-running.png` });
await page.waitForFunction(() => !document.getElementById("results").hidden || /stopped|lost|never|No lift|short/.test(document.getElementById("markInstr").textContent), null, { timeout: 240000 });
if (await page.isHidden("#results")) {
  console.log("FAILED:", await page.textContent("#markInstr"));
  console.log(errors.join("\n"));
  await browser.close(); server.close(); process.exit(1);
}
// only the chosen part was tracked
const part = await page.evaluate(() => { const S = window.__barpath; return { start: S.start, end: S.end ?? S.duration, first: S.samples[0].t, last: S.samples[S.samples.length - 1].t, fps: S.fps }; });
if (Math.abs(part.first - part.start) > 1e-3 || part.last > part.end + 1 / part.fps || part.last < part.end - 3 / part.fps) throw new Error(`tracked ${part.first}..${part.last}, chose ${part.start}..${part.end}`);
console.log(`tracked ${part.first.toFixed(3)}–${part.last.toFixed(3)} s of the chosen ${part.start.toFixed(3)}–${part.end.toFixed(3)} s`);
const R = await page.evaluate(() => {
  const S = window.__barpath, R = S.R;
  return { title: R.title, sub: document.getElementById("resSub").textContent, vmax: R.vmax, peak: R.H[R.ev.peak], catch: R.H[R.ev.catch], stand: R.H[R.ev.stand],
    catchX: R.X[R.ev.catch] * 100, back: -R.X[R.ev.back] * 100, fs: R.fs, frames: S.samples.length, lost: S.samples.filter((s) => !s.ok).length,
    stages: R.stages.map((s) => `${s.name} ${s.dur.toFixed(2)}`), checks: R.checks.map((c) => `${c.title}:${c.status}`), notes: R.notes, run: S.runStats,
    tiles: [...document.querySelectorAll(".tile")].map((t) => t.innerText.replace(/\n/g, " ")) };
});
const { writeFileSync } = await import("node:fs");
writeFileSync(`${outDir}/samples.json`, JSON.stringify(await page.evaluate(() => window.__barpath.samples)));
console.log(`results after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(R, null, 1));
await page.screenshot({ path: `${outDir}/05-results.png` });
await page.screenshot({ path: `${outDir}/06-results-full.png`, fullPage: true });

// scrub by dragging on the speed chart, and check the replay follows
const sc = await page.locator("#speedChart").boundingBox();
await page.locator("#speedChart").scrollIntoViewIfNeeded();
await page.mouse.move(sc.x + sc.width * 0.45, sc.y + sc.height * 0.5);
await page.waitForTimeout(500);
const cur = await page.evaluate(() => ({ cursor: window.__barpath.cursor, t: document.getElementById("video").currentTime, hud: document.getElementById("hud").textContent, tip: document.querySelector("#speedChart + .tip").innerText }));
console.log("scrub:", JSON.stringify(cur));
await page.screenshot({ path: `${outDir}/07-scrub.png` });
await page.evaluate(() => window.scrollTo(0, 0));
await page.tap("#btnPlay");
await page.waitForTimeout(2500);
const played = await page.evaluate(() => ({ cursor: window.__barpath.cursor, t: document.getElementById("video").currentTime, playing: window.__barpath.playing }));
console.log("replay:", JSON.stringify(played));
await page.screenshot({ path: `${outDir}/08-replay.png` });

// share the app: the dialog's QR code, drawn from its SVG, read back by an independent decoder
await page.tap("#btnShareApp");
await page.waitForSelector("#shareDlg[open]");
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/09-share.png` });
const img = await page.evaluate(async () => {
  const svg = document.querySelector("#shareQr svg"), n = 400, c = Object.assign(document.createElement("canvas"), { width: n, height: n });
  const xml = new XMLSerializer().serializeToString(svg).replace(/class="paper"/, 'fill="#fff"').replace(/class="ink"/, 'fill="#000"');
  const im = new Image();
  im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  await im.decode();
  c.getContext("2d").drawImage(im, 0, 0, n, n);
  return { px: Array.from(c.getContext("2d").getImageData(0, 0, n, n).data), n, link: document.getElementById("shareLink").textContent, canonical: document.querySelector('link[rel="canonical"]').href };
});
const qr = jsQR(Uint8ClampedArray.from(img.px), img.n, img.n);
console.log("share:", img.link, "| QR reads", qr ? qr.data : "nothing");
if (!qr || qr.data !== img.canonical) throw new Error(`the QR code should carry ${img.canonical}`);
await page.tap("#btnShareClose");
console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
server.close();
