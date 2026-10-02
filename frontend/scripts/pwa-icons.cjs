/* Patient-app PWA icons (v3 §6): renders the Early Signals mark (white signal line on the signal orange) to PNG with
 * Playwright's Chromium, so no image tooling is needed. Run from frontend/: node scripts/pwa-icons.cjs */
const { chromium } = require("@playwright/test");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "public", "pwa");
const ORANGE = "#F05A28";
// the logo stroke from TopNav's <Logo/> (32x32 view box)
const MARK = '<path d="M5 21 L11.5 12.5 L15.5 17.5 L20.5 9.5 L27 21" fill="none" stroke="white" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>';

/** any: rounded square with the mark at 62%; maskable: full bleed with the mark inside the 80% safe zone. */
const svg = (kind) => kind === "maskable"
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${ORANGE}"/><g transform="translate(16 16) scale(.58) translate(-16 -15)">${MARK}</g></svg>`
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7.2" fill="${ORANGE}"/><g transform="translate(16 16) scale(.8) translate(-16 -15)">${MARK}</g></svg>`;

(async () => {
  require("node:fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const jobs = [["icon-192.png", 192, "any"], ["icon-512.png", 512, "any"], ["maskable-512.png", 512, "maskable"], ["maskable-192.png", 192, "maskable"], ["apple-touch-icon.png", 180, "maskable"]];
  for (const [name, size, kind] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(kind).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
  require("node:fs").writeFileSync(path.join(OUT, "icon.svg"), svg("any"));
  await browser.close();
  console.log("wrote", jobs.map((j) => j[0]).join(", "), "to", OUT);
})();
