// Renders the PNG app icons from icons/*.svg with headless Chrome (npm i, then npm run icons).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const jobs = [
  ["icons/icon.svg", "icons/icon-192.png", 192],
  ["icons/icon.svg", "icons/icon-512.png", 512],
  ["icons/icon-maskable.svg", "icons/icon-maskable-512.png", 512],
  ["icons/icon-maskable.svg", "icons/apple-touch-icon.png", 180],
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [src, out, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  const svg = readFileSync(src, "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log("wrote", out);
}
await browser.close();
