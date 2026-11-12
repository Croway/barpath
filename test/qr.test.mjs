// The QR encoder (js/qr.js) against an independent decoder (jsQR): every length from 1 to 300 bytes, which runs
// through versions 1-13 (version info from 7, 16-bit lengths from 10), plus the app's own links.
import jsQR from "jsqr";
import { encode } from "../js/qr.js";

function decode(m, scale = 4, quiet = 4) {
  const n = m.length, w = (n + 2 * quiet) * scale, px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!m[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const o = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
      px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return jsQR(px, w, w, { inversionAttempts: "dontInvert" });
}

let fail = 0;
const check = (text) => {
  const m = encode(text), r = decode(m), v = (m.length - 17) / 4;
  if (!r || r.data !== text) { fail++; console.log(`FAIL v${v} (${text.length} chars): ${r ? JSON.stringify(r.data.slice(0, 40)) : "not read"}`); }
  return v;
};
const seen = new Set();
for (let len = 1; len <= 300; len++) seen.add(check(Array.from({ length: len }, (_, i) => "Bar Path 0123456789/:.-_?"[(i * 7 + len) % 25]).join("")));
for (const u of ["https://croway.github.io/barpath/", "http://localhost:8765/", "https://example.com/a/very/long/path/to/an/app/?with=query&and=more#hash", "Bär Päth ✓"]) seen.add(check(u));
console.log(`versions ${[...seen].sort((a, b) => a - b).join(", ")}: ${fail ? `${fail} FAILED` : "all read back"}`);
process.exit(fail ? 1 : 0);
