/* Service worker: makes the installed app work offline, and receives videos shared to it.
 *
 *  - App files: network first (so a reachable server always delivers the latest), cache when offline.
 *  - vendor/ (MediaPipe runtime and pose models, ~19 MB precached): cache first; they never change for a version.
 *  - POST ./share (the manifest's share target): keeps the shared video, then opens the app with ?shared=1.
 */
const SHELL = "barpath-shell-v3";
const VENDOR = "barpath-vendor-0.10.21";
const SHARE = "barpath-share";
const SHELL_FILES = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/analysis.js", "js/charts.js", "js/overlay.js", "js/plate.js", "js/pose.js", "js/recorder.js", "js/video.js",
  "js/trim.js", "js/share.js", "js/qr.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
];
const VENDOR_FILES = [
  "vendor/mediapipe/vision_bundle.mjs", "vendor/mediapipe/wasm/vision_wasm_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_internal.wasm", "vendor/mediapipe/pose_landmarker_full.task",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    try {
      const c = await caches.open(VENDOR);
      for (const f of VENDOR_FILES) if (!(await c.match(f))) await c.add(f);
    } catch { /* no vendor/ on this server: those files are cached on first use instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, VENDOR, SHARE].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === "POST" && url.pathname.endsWith("/share")) return e.respondWith(receiveShare(req));
  if (req.method !== "GET") return;
  if (url.pathname.includes("/vendor/")) return e.respondWith(cacheFirst(req, VENDOR));
  e.respondWith(networkFirst(req, url));
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await c.put(req, res.clone());
  return res;
}

async function networkFirst(req, url) {
  const c = await caches.open(SHELL);
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok && !url.search) await c.put(req, res.clone());
    return res;
  } catch {
    const hit = (await c.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await c.match("index.html") : undefined);
    return hit || Response.error();
  }
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const file = form.get("video");
    if (file && file.size) {
      await (await caches.open(SHARE)).put("shared-video", new Response(file, {
        headers: { "Content-Type": file.type || "video/mp4", "X-File-Name": encodeURIComponent(file.name || "shared-video") },
      }));
    }
  } catch { /* nothing usable was shared: the app just opens */ }
  return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
}
