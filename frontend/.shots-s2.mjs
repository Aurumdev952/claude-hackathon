// Temporary screenshot driver for the doctor-screen polish (deleted after use).
import { chromium } from "@playwright/test";

const OUT = process.env.OUT ?? "/tmp/claude-0/-home-user-claude-hackathon/33af3e90-f496-5bda-bdaf-658d21780445/scratchpad/ui-v3-s2";
const BASE = process.env.BASE ?? "http://127.0.0.1:5182";
const FAC = Number(process.env.FAC ?? 1215);
const HIGH = process.env.HIGH ?? "36953";
const DX = process.env.DX ?? "68232";
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

async function shot(name, { w = 1600, h = 960, theme = "light", path = "/doctor", fac = FAC, wait = 2500, action, fullPage = false } = {}) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([f, t]) => {
    localStorage.setItem("es-role", JSON.stringify({ state: { role: "doctor", facilityId: f, facilityName: f ? "Nyaruguru District Hospital (Synthetic)" : null }, version: 0 }));
    localStorage.setItem("es-theme", t);
    localStorage.setItem("theme", t);
  }, [fac, theme]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", name, e.message));
  await page.goto(BASE + path);
  await page.waitForTimeout(wait);
  // theme fallback: set the attribute directly if the store key differs
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.classList.toggle("dark", t === "dark"); }, theme);
  if (action) await action(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  await ctx.close();
  console.log("saved", name);
}

const caseWait = 9000;
await shot("picker-light", { fac: null });
await shot("doctor-light");
await shot("doctor-dark", { theme: "dark" });
await shot("doctor-1280-light", { w: 1280, h: 800 });
await shot("doctor-full-light", { fullPage: true, h: 960 });
await shot("doctor-alerts-light", { action: async (p) => { await p.getByRole("tab", { name: "Alerts inbox" }).click(); await p.waitForTimeout(1500); } });
await shot("doctor-modal-light", { action: async (p) => { await p.getByRole("button", { name: "Explain" }).click(); await p.waitForTimeout(2500); } });
await shot("doctor-390-light", { w: 390, h: 844, fullPage: false });
await shot("case-high-light", { path: `/doctor/case/${HIGH}`, wait: caseWait });
await shot("case-high-dark", { path: `/doctor/case/${HIGH}`, wait: caseWait, theme: "dark" });
await shot("case-high-1280-light", { path: `/doctor/case/${HIGH}`, wait: caseWait, w: 1280, h: 800 });
await shot("case-dx-light", { path: `/doctor/case/${DX}`, wait: caseWait });
await shot("case-dx-dark", { path: `/doctor/case/${DX}`, wait: caseWait, theme: "dark" });
await shot("case-modal-light", { path: `/doctor/case/${HIGH}`, wait: caseWait, action: async (p) => { await p.getByRole("button", { name: "View as table" }).click(); await p.waitForTimeout(800); } });
await browser.close();
