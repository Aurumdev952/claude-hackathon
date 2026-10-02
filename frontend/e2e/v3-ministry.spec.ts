import { expect, test } from "@playwright/test";
import { API, asRole } from "./helpers";

/** v3 ministry journeys (track U2): Outlook, scenario simulator, Follow-up programme, learning-loop gates, the sim
 * control popover and the reel video modal. Nothing here advances the shared sim clock, promotes a model or exports a
 * video. */
test.beforeEach(async ({ page }) => { await asRole(page, "ministry"); });

test("outlook: the forecast fan and the stats strip render", async ({ page }) => {
  await page.goto("/outlook");
  await expect(page.getByRole("heading", { name: "Outlook to 2031" })).toBeVisible();
  await expect(page.getByTestId("outlook-fan").locator("canvas").first()).toBeVisible();
  const strip = page.getByRole("list", { name: "Forecast summary" });
  await expect(strip.getByRole("listitem")).toHaveCount(4);
  await expect(strip.getByRole("listitem").first()).toHaveAccessibleName(/forecast mean: [\d,]+ cases/);
  // the rate toggle swaps the series without breaking the strip
  await page.getByRole("group", { name: "Forecast measure" }).getByRole("button", { name: "Rate" }).click();
  await expect(strip.getByRole("listitem").first()).toHaveAccessibleName(/per 100k/);
  // the backtest tile opens the backtest modal
  await page.getByRole("button", { name: /Backtest error: open/ }).click();
  await expect(page.getByRole("dialog", { name: /Forecast backtest/ })).toBeVisible();
});

test("outlook: moving a scenario lever updates the cases averted", async ({ page }) => {
  await page.goto("/outlook");
  const averted = page.getByTestId("cases-averted");
  await expect(averted).toContainText("Move a lever to start");
  const slider = page.getByRole("slider", { name: /H\. pylori test and treat/ });
  await slider.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");   // 30% coverage
  await expect(slider).toHaveValue("30");
  await expect(averted).toContainText(/Range [\d,]+–[\d,]+/, { timeout: 15_000 });
  await expect.poll(async () => Number((await averted.locator(".text-display").textContent())?.replace(/,/g, "") ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
});

test("programme: the care funnel renders with suppression", async ({ page }) => {
  await page.goto("/programme");
  const funnel = page.getByRole("list", { name: "Care funnel" }).first();
  await expect(funnel.getByRole("listitem")).toHaveCount(7);
  await expect(funnel.getByRole("listitem").first()).toHaveAccessibleName(/^Flagged: /);
  // ministry aggregates only: never a patient display id on this page
  await expect(page.locator("body")).not.toContainText(/[A-Z]{3}-\d{5}[0-9A-Z]{3}/);
});

test("models: the learning-loop card shows the promotion gates", async ({ page }) => {
  const loop = await (await page.request.get(`${API}/models/learning-loop`, { headers: { "X-Role": "ministry" } })).json();
  await page.goto("/models");
  const section = page.getByRole("region", { name: "Learning loop" });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "Champion and challenger" })).toBeVisible();
  if (!loop.data.challenger) {
    await expect(section.getByText(/No challenger has been trained yet/)).toBeVisible();
    return;
  }
  const gates = section.getByRole("list", { name: "Promotion gates" });
  await expect(gates.getByRole("listitem")).toHaveCount(loop.data.gates.length);
  for (const g of loop.data.gates) await expect(gates.getByRole("listitem", { name: new RegExp(`: ${g.pass ? "pass" : "fail"}$`) }).first()).toBeVisible();
  // promote asks for a reason first (cancel: e2e never promotes)
  await section.getByRole("button", { name: "Promote challenger" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("button", { name: "Promote" })).toBeDisabled();
  if (loop.data.decision === "gates_failed") {
    // the API answers 409 GATES_FAILED (nothing changes); the modal lists the failing gates and asks for a second
    // explicit confirmation before "Promote anyway" is enabled
    await dlg.getByLabel(/Reason/).fill("e2e check of the override path");
    await dlg.getByRole("button", { name: "Promote" }).click();
    await expect(dlg.getByText("Promote despite failed gates?")).toBeVisible();
    const anyway = dlg.getByRole("button", { name: "Promote anyway" });
    await expect(anyway).toBeDisabled();
    await dlg.getByRole("checkbox").check();
    await expect(anyway).toBeEnabled();
  }
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeHidden();
});

test("sim control: the popover opens and shows the simulated date", async ({ page }) => {
  const st = await (await page.request.get(`${API}/admin/sim/status`)).json();
  const d = new Date(`${st.data.sim_time.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  await page.goto("/");
  await page.getByRole("button", { name: /^Simulation/ }).click();
  await expect(page.getByTestId("sim-date")).toHaveText(d);
  await expect(page.getByRole("group", { name: "Simulation control" }).getByRole("button", { name: "+1 week" })).toBeVisible();
});

test("video: the reel button opens the modal with a preview", async ({ page }) => {
  await page.goto("/outlook");
  await page.getByRole("button", { name: "Create video" }).click();
  const dlg = page.getByRole("dialog", { name: /Surveillance reel/ });
  await expect(dlg).toBeVisible();
  // the Player preview loads the reel props from the video server; Export MP4 appears once the preview is ready
  await expect(dlg.getByRole("button", { name: "Export MP4" })).toBeVisible({ timeout: 60_000 });
});
