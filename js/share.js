/* Sharing the app itself: a QR code for a phone standing next to this one, the system share sheet (WhatsApp,
 * Messages, Quick Share…) and a copy of the link. The link is this app's public address: where it's running,
 * or, when it's served from this computer (localhost / the local network), the canonical address in index.html. */
import { encode } from "./qr.js";

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|[^.]+$)/;
const TEXT = "Bar Path: bar path, bar speed and lift stages from one side-on phone video. Everything runs on the phone. Open the link in Chrome and tap Install.";

/** the link to give out, and whether it's only reachable from this phone */
export function appLink() {
  const here = new URL("./", location.href);
  if (!PRIVATE.test(location.hostname)) return { url: here.href, localOnly: false };
  const pub = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  return pub ? { url: new URL(pub).href, localOnly: false, elsewhere: true } : { url: here.href, localOnly: true };
}

/** the QR code as an SVG element: dark modules merged into runs, with the 4-module quiet zone */
export function qrSvg(text, label) {
  const m = encode(text), n = m.length, q = 4, NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + 2 * q} ${n + 2 * q}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("class", "paper");
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; ) {
      if (!m[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < n && m[y][x + run]) run++;
      d += `M${x + q} ${y + q}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", "ink");
  svg.append(bg, path);
  return svg;
}

export function initShare({ dialog, open, qr, link, note, send, copy, close }) {
  const show = () => {
    const L = appLink();
    qr.replaceChildren(qrSvg(L.url, `QR code for ${L.url}`));
    link.textContent = L.url.replace(/^https?:\/\//, "");
    note.textContent = L.localOnly
      ? "This copy is served from your computer, so the link only works on this phone. Put the app online to share it (README → Share)."
      : "Scan it with another phone's camera, or send the link. Open it in Chrome and tap Install; on an iPhone, Safari → Share → Add to Home Screen. Videos never leave the phone.";
    send.hidden = !navigator.share;
    copy.textContent = "Copy link";
    dialog.showModal();
  };
  open.addEventListener("click", show);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // a tap on the backdrop
  send.addEventListener("click", async () => {
    try { await navigator.share({ title: "Bar Path", text: TEXT, url: appLink().url }); } catch { /* dismissed */ }
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(appLink().url);
      copy.textContent = "Copied ✓";
    } catch {
      getSelection()?.selectAllChildren(link); // select it, so it can be copied by hand
    }
  });
}
