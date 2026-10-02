/* Patient-app PWA icons (v3 §6) and the favicon: renders the Early Signals mark (two rising signal lines, #98D59B ->
 * #4F6F51 gradient, src/components/brand/BrandMark.tsx) to PNG with Playwright's Chromium, so no image tooling is needed.
 * Run from frontend/: node scripts/pwa-icons.cjs (also rewrites public/pwa/icon.svg and public/favicon.svg) */
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "public", "pwa");
// BrandMark geometry (100 x 82 view box)
const GRAD = '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="4" y1="78" x2="96" y2="4"><stop offset="0" stop-color="#98D59B"/><stop offset="1" stop-color="#4F6F51"/></linearGradient>';
const MARK = (w) => `<g fill="none" stroke="url(#g)" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"><path d="M6 45 L37 15 L50 28 L71 6 L94 29"/><path d="M6 76 L37 46 L50 58 L71 37 L94 60"/></g>`;

/** any: white rounded square with the mark at 64%; maskable: full bleed with the mark inside the 80% safe zone;
 *  favicon: the bare mark with heavier strokes so it still reads at 16px. */
const svg = (kind) => kind === "favicon"
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -13 108 108"><defs>${GRAD}</defs>${MARK(12)}</svg>`
  : kind === "maskable"
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${GRAD}</defs><rect width="100" height="100" fill="#FFFFFF"/><g transform="translate(50 50) scale(.52) translate(-50 -41)">${MARK(9.5)}</g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${GRAD}</defs><rect width="100" height="100" rx="22.5" fill="#FFFFFF"/><g transform="translate(50 50) scale(.64) translate(-50 -41)">${MARK(9.5)}</g></svg>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const jobs = [["icon-192.png", 192, "any"], ["icon-512.png", 512, "any"], ["maskable-512.png", 512, "maskable"], ["maskable-192.png", 192, "maskable"], ["apple-touch-icon.png", 180, "maskable"]];
  for (const [name, size, kind] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(kind).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
  fs.writeFileSync(path.join(OUT, "icon.svg"), svg("any"));
  fs.writeFileSync(path.join(OUT, "..", "favicon.svg"), svg("favicon"));
  await browser.close();
  console.log("wrote", jobs.map((j) => j[0]).join(", "), "+ icon.svg, favicon.svg");
})();
