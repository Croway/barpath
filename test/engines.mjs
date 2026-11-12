// The main flow in each browser engine: Chromium (Chrome, Samsung Internet, Edge…), WebKit (Safari, and every
// browser on an iPhone), Gecko (Firefox). Feature check, open a video, drag the handles, tap the plate, analyse,
// with body tracking (MediaPipe); the gallery keeps it; a second part; compare the two; the share dialog.
//   npx playwright-core install webkit firefox      (once)
//   node test/engines.mjs . <video.mp4> <truth.json> [chrome|webkit|firefox …]
import { chromium, webkit, firefox } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const [appDir, videoPath, truthPath, ...which] = process.argv.slice(2);
const T = JSON.parse(readFileSync(truthPath, "utf8"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".png": "image/png" };
const root = resolve(appDir);
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]), p = join(root, u === "/" ? "index.html" : u);
  if (!p.startsWith(root + sep) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/`;
// persistent profiles: a throwaway context is a private window, and WebKit's private windows can't store videos
const MOZ = Object.fromEntries(["CONTENT", "GMP", "RDD", "SOCKET_PROCESS", "GPU", "UTILITY"].map((k) => [`MOZ_DISABLE_${k}_SANDBOX`, "1"]));
const OPTS = { viewport: { width: 390, height: 844 } };
const ENGINES = {
  chrome: (dir) => chromium.launchPersistentContext(dir, { ...OPTS, channel: "chrome", headless: true }),
  // WebKit's persistent mode doesn't start on every macOS: then a throwaway context (a private window)
  webkit: (dir) => webkit.launchPersistentContext(dir, OPTS).catch(async () => { const b = await webkit.launch(); const c = await b.newContext(OPTS); c.once("close", () => b.close()); console.log("     (private window: WebKit's persistent profile didn't start here)"); return c; }),
  firefox: (dir) => firefox.launchPersistentContext(dir, { ...OPTS, env: { ...process.env, ...MOZ }, firefoxUserPrefs: { "media.autoplay.default": 0 } }),
};

let fails = 0;
for (const name of which.length ? which : ["chrome", "webkit", "firefox"]) {
  console.log(`\n== ${name}`);
  const dir = mkdtempSync(join(process.env.PROFILE_DIR || tmpdir(), `barpath-${name}-`));
  const ctx = await ENGINES[name](dir);
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => d.accept());
  const step = async (label, fn) => {
    try { const out = await fn(); console.log(`ok   ${label}${out ? `: ${out}` : ""}`); return true; } catch (e) { fails++; console.log(`FAIL ${label}: ${String(e.message || e).split("\n")[0]}`); return false; }
  };
  try {
    await page.goto(url);
    await step("features", () => page.evaluate(() => {
      const c = document.createElement("canvas");
      return JSON.stringify({
        frameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype, serviceWorker: "serviceWorker" in navigator, indexedDB: !!window.indexedDB,
        webgl2: !!c.getContext("webgl2"), wasm: typeof WebAssembly === "object", mediaRecorder: !!window.MediaRecorder, share: !!navigator.share, dialog: typeof HTMLDialogElement === "function",
        h264: document.createElement("video").canPlayType('video/mp4; codecs="avc1.640028"'),
      });
    }));
    const analyseOnce = async (pose, at, end) => {
      await page.evaluate((p) => localStorage.setItem("barpath.settings", JSON.stringify({ poseModel: p })), pose);
      await page.reload();
      await page.setInputFiles("#fileInput", videoPath);
      await page.waitForFunction(() => /fps/.test(document.getElementById("videoInfo").textContent), null, { timeout: 30000 });
      // the handles, dragged with the mouse (pointer events, the same path a finger takes)
      for (const [which, t] of [["out", end], ["in", at]]) {
        const g = await page.evaluate((w) => {
          const tl = document.getElementById("timeline").getBoundingClientRect(), h = document.querySelector(`.timeline .handle.${w}`).getBoundingClientRect();
          return { left: tl.left, width: tl.width, hx: h.left + h.width / 2, hy: h.top + h.height / 2, hw: h.width, d: document.getElementById("video").duration };
        }, which);
        const x = g.left + g.hw + (t / g.d) * (g.width - 2 * g.hw) + (which === "in" ? -g.hw / 2 : g.hw / 2);
        await page.mouse.move(g.hx, g.hy); await page.mouse.down();
        for (let i = 1; i <= 10; i++) { await page.mouse.move(g.hx + ((x - g.hx) * i) / 10, g.hy); await page.waitForTimeout(20); }
        await page.mouse.up();
        await page.waitForTimeout(300);
      }
      await page.waitForFunction((t) => Math.abs(document.getElementById("video").currentTime - t) < 0.03 && !document.getElementById("video").seeking, at, { timeout: 10000 });
      await page.waitForTimeout(200);
      const box = await page.locator("#overlay").boundingBox(), [W, H] = await page.evaluate(() => [window.__barpath.W, window.__barpath.H]);
      const tx = (T.start.x + 0.2 * T.R) * (W / T.W), ty = (T.start.y - 0.1 * T.R) * (H / T.H);
      await page.mouse.click(box.x + (tx / W) * box.width, box.y + (ty / H) * box.height);
      await page.waitForFunction(() => !document.getElementById("btnAnalyse").disabled, null, { timeout: 5000 });
      const t0 = Date.now();
      await page.click("#btnAnalyse");
      await page.waitForFunction(() => !document.getElementById("results").hidden || /stopped|lost|never|No lift|short|couldn't/i.test(document.getElementById("markInstr").textContent), null, { timeout: 240000 });
      const r = await page.evaluate(() => { const S = window.__barpath; return S.R && !document.getElementById("results").hidden
        ? { title: S.R.title, frames: S.samples.length, posed: S.samples.filter((s) => s.pose).length, start: +S.start.toFixed(2), end: +(S.end ?? S.duration).toFixed(2), pose: S.runStats.pose, note: S.poseNote }
        : { error: document.getElementById("markInstr").textContent }; });
      if (r.error) throw new Error(r.error);
      if (Math.abs(r.start - at) > 0.05 || Math.abs(r.end - end) > 0.05) throw new Error(`part ${r.start}–${r.end}, wanted ${at}–${end}`);
      await page.waitForFunction(() => /Saved in the gallery|Couldn't keep/.test(document.getElementById("resSaved").textContent), null, { timeout: 20000 });
      const saved = await page.textContent("#resSaved");
      if (!/Saved in the gallery/.test(saved)) throw new Error(`${r.title} analysed, but: ${saved}`);
      return `${r.title}, ${r.frames} frames${pose !== "off" ? `, body in ${r.posed} (${r.pose})${r.note ? ` ${r.note}` : ""}` : ""}, ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    };
    await step("body tracking (MediaPipe, lite), trim, mark, analyse, save (part 0.4–4.0 s)", () => analyseOnce("lite", 0.4, 4.0));
    await step("a second part (0.3–4.2 s), body tracking off", () => analyseOnce("off", 0.3, 4.2));
    await step("gallery reopens a lift without tracking", async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.click("#btnGallery2");
      await page.waitForFunction(() => document.querySelectorAll("#galList .lift").length === 2, null, { timeout: 10000 });
      await page.click("#galList .lift:last-child .open");
      await page.waitForFunction(() => !document.getElementById("results").hidden && /From the gallery/.test(document.getElementById("resSaved").textContent), null, { timeout: 30000 });
      await page.goBack();
      await page.waitForSelector("#gallery:not([hidden])");
      return page.evaluate(() => window.__barpath.R.title);
    });
    await step("compare two, scrub, play", async () => {
      for (const b of await page.$$("#galList .pick input")) await b.check();
      await page.click("#btnGalCompare");
      await page.waitForFunction(() => { const C = window.__barpathCompare; return C.L.length === 2 && C.L.every((l) => l.video.readyState >= 2 && !l.busy); }, null, { timeout: 30000 });
      await page.evaluate(() => window.__barpathCompare.go(1.0));
      await page.waitForFunction(() => window.__barpathCompare.L.every((l) => !l.busy && !l.video.seeking), null, { timeout: 10000 });
      const off = await page.evaluate(() => { const C = window.__barpathCompare; return C.L.map((l) => Math.abs(l.video.currentTime - C.vt(l, C.tau))); });
      if (off.some((d) => d > 0.05)) throw new Error(`videos out of step: ${off}`);
      await page.click("#cmpPlay");
      await page.waitForTimeout(1500);
      const p = await page.evaluate(() => { const C = window.__barpathCompare; return { tau: +C.tau.toFixed(2), drift: C.L.map((l) => +Math.abs(l.video.currentTime - C.vt(l, C.tau)).toFixed(3)) }; });
      await page.click("#cmpPlay");
      return `in step when scrubbed; playing, drift ${p.drift.join(" / ")} s`;
    });
    await step("share dialog", async () => {
      await page.click("#btnShareApp");
      await page.waitForSelector("#shareDlg[open]");
      const r = await page.evaluate(() => ({ qr: !!document.querySelector("#shareQr svg path"), send: !document.getElementById("btnShareSend").hidden }));
      await page.click("#btnShareClose");
      return `QR ${r.qr ? "drawn" : "missing"}, Send link ${r.send ? "offered" : "hidden (no system share here)"}`;
    });
  } catch (e) { fails++; console.log("FAIL", e.message); }
  if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].slice(0, 8).join("\n  "));
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
}
server.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
