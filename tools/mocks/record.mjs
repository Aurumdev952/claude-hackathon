// Records the API traffic of a full UI walk-through into frontend/src/mocks/fixtures.json (SPEC §16.6).
// Run from frontend/: node ../tools/mocks/record.mjs  (API on :8000, Vite on :5173). Patient names are synthetic.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const API = "http://127.0.0.1:8000/api/v1";
const out = {};
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function walk(role, facility, routes, actions = async () => {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 } });
  await ctx.addInitScript(([r, f]) => localStorage.setItem("es-role", JSON.stringify({ state: { role: r, facilityId: f, facilityName: f ? "Demo facility (Synthetic)" : null }, version: 0 })), [role, facility]);
  const page = await ctx.newPage();
  page.on("response", async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith("/api/v1/") || res.request().method() !== "GET" || u.pathname.endsWith("/ws")) return;
    try {
      const key = `${role}${u.pathname}${u.search}`;
      out[key] = { status: res.status(), body: await res.json() };
    } catch { /* non-JSON */ }
  });
  for (const r of routes) {
    await page.goto(BASE + r, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    await actions(page, r);
  }
  await ctx.close();
}

const hdr = (role, fac) => ({ "X-Role": role, ...(fac ? { "X-Facility-Id": String(fac) } : {}) });
// busiest facility with diagnosed and flagged patients
const meta = await (await fetch(`${API}/meta/filters`, { headers: hdr("ministry") })).json();
let fac = null;
for (const f of meta.data.facilities) {
  const r = await (await fetch(`${API}/patients?status=diagnosed&page_size=1`, { headers: hdr("doctor", f.location_id) })).json();
  if (r.data?.length) { fac = f.location_id; break; }
}
await walk("ministry", null, ["/", "/geo", "/trends", "/warning", "/quality", "/models", "/ask"], async (page, r) => {
  if (r === "/geo") for (const m of ["Crude", "SIR", "LISA", "HP testing", "% stage IV", "ASR"]) {
    await page.getByRole("group", { name: "Map metric" }).getByRole("button", { name: m }).click().catch(() => {});
    await page.waitForTimeout(600);
  }
});
const pts = await (await fetch(`${API}/patients?status=flagged&page_size=3`, { headers: hdr("doctor", fac) })).json();
const dx = await (await fetch(`${API}/patients?status=diagnosed&page_size=2`, { headers: hdr("doctor", fac) })).json();
const ids = [...(pts.data ?? []), ...(dx.data ?? [])].map((p) => p.patient_id);
await walk("doctor", fac, ["/doctor", ...ids.map((i) => `/doctor/case/${i}`)]);
// POST /ask answers for the suggested questions (replayed by question text)
const sugg = await (await fetch(`${API}/ask/suggestions`, { headers: hdr("ministry") })).json();
const asks = {};
for (const q of [...(sugg.data ?? []), "Delete all patients"]) {
  asks[q] = await (await fetch(`${API}/ask`, { method: "POST", headers: { ...hdr("ministry"), "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) })).json();
}
fs.writeFileSync("src/mocks/fixtures.json", JSON.stringify({ recorded_at: new Date().toISOString(), facility: fac, get: out, ask: asks }));
console.log(`recorded ${Object.keys(out).length} GET responses, ${Object.keys(asks).length} ask answers, facility ${fac}`);
await browser.close();
