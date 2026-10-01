import { expect, test } from "@playwright/test";
import { API, asRole, busyFacility } from "./helpers";

test("doctor: open top patient, reasons + timeline render, acknowledge persists after refresh", async ({ page }) => {
  const fac = await busyFacility(page);
  await asRole(page, "doctor", fac);
  await page.goto("/doctor");
  const list = page.getByRole("list", { name: "Patients" });
  await expect(list.getByRole("button").first()).toBeVisible();
  await list.getByRole("button").first().click();
  await expect(page.getByText("Why flagged").or(page.getByText("Not scored"))).toBeVisible();
  await expect(page.getByRole("img", { name: "Patient timeline" })).toBeVisible();

  // acknowledge the first NEW alert at this facility (if any) and check it survives a reload
  const alerts = await (await page.request.get(`${API}/alerts?status=NEW`, { headers: { "X-Role": "doctor", "X-Facility-Id": String(fac) } })).json();
  test.skip(!alerts.data.length, "no NEW alerts at this facility");
  await page.getByRole("tab", { name: "Alerts inbox" }).click();
  await page.getByRole("button", { name: new RegExp(alerts.data[0].name) }).first().click();
  await page.getByRole("button", { name: "Acknowledge" }).first().click();
  await page.reload();
  const after = await (await page.request.get(`${API}/alerts?status=ACKNOWLEDGED`, { headers: { "X-Role": "doctor", "X-Facility-Id": String(fac) } })).json();
  expect(after.data.map((a: any) => a.alert_id)).toContain(alerts.data[0].alert_id);
});

test("case analysis: 3D body renders, hover links panel and body, replay advances, table fallback", async ({ page }) => {
  const fac = await busyFacility(page);
  const pts = await (await page.request.get(`${API}/patients?status=diagnosed&page_size=1`, { headers: { "X-Role": "doctor", "X-Facility-Id": String(fac) } })).json();
  await asRole(page, "doctor", fac);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/doctor/case/${pts.data[0].patient_id}`);
  await expect(page.getByTestId("case-analysis")).toBeVisible();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByText("Loading anatomy model")).toHaveCount(0, { timeout: 60_000 });

  // panel -> body: hovering an organ group shows the focus banner for that organ
  const group = page.getByRole("button", { name: /^Stomach/ }).first();
  await group.hover();
  await expect(page.getByRole("status").filter({ hasText: "Stomach" })).toBeVisible();

  // replay: the playhead date appears and moves
  await page.getByRole("button", { name: "Play replay" }).click();
  const readout = page.getByLabel("Timeline replay").locator("[aria-live=polite]");
  const first = await readout.textContent();
  await page.waitForTimeout(2500);
  expect(await readout.textContent()).not.toBe(first);
  await page.getByRole("button", { name: "Pause replay" }).click();

  // accessible fallback
  await page.getByRole("button", { name: "View as table" }).click();
  await expect(page.getByRole("table")).toContainText("Stomach");
  expect(errors).toEqual([]);
});
