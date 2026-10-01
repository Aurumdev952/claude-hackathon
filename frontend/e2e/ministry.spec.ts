import { expect, test } from "@playwright/test";
import { API, asRole } from "./helpers";

/** SPEC §19.6 ministry journeys. */
test.beforeEach(async ({ page }) => { await asRole(page, "ministry"); });

test("overview: KPIs visible within 3 s", async ({ page }) => {
  const t0 = Date.now();
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Headline indicators" }).getByRole("listitem").first()).toBeVisible({ timeout: 3000 });
  expect(Date.now() - t0).toBeLessThan(3000 + 2000); // navigation + render budget (dev server, headless)
  await expect(page.getByRole("list", { name: "Headline indicators" }).getByRole("listitem")).toHaveCount(6);
});

test("geo: switch crude <-> ASR, open Musanze panel with its trend", async ({ page }) => {
  await page.goto("/geo");
  const metric = page.getByRole("group", { name: "Map metric" });
  await metric.getByRole("button", { name: "Crude" }).click();
  await expect(metric.getByRole("button", { name: "Crude" })).toHaveAttribute("aria-pressed", "true");
  await metric.getByRole("button", { name: "ASR" }).click();
  await page.getByLabel("Jump to district").selectOption({ label: "Musanze" });
  await expect(page.getByRole("button", { name: "Close district panel" })).toBeVisible();
  await expect(page.getByText("Musanze").first()).toBeVisible();
});

test("trends: the under-50 trend chip matches the published joinpoint", async ({ page }) => {
  // The planted under-50 rise (INS-2) is significant at scale 1.0 and checked by tests/insights; at small dev
  // scales it may not reach significance, so this UI test checks the chip agrees with the API either way.
  const jp = await (await page.request.get(`${API}/trends/joinpoint?series_id=${encodeURIComponent("NATIONAL|ALL|<50|CONFIRMED_PROBABLE")}`,
    { headers: { "X-Role": "ministry" } })).json();
  const last = jp.data.segments[jp.data.segments.length - 1];
  const expected = last.significant ? (last.apc > 0 ? "Rising" : "Falling") : "Flat";
  await page.goto("/trends");
  const card = page.getByRole("list", { name: "Trend headlines" }).getByRole("listitem").filter({ hasText: /under-50/i }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText(expected).first()).toBeVisible();
});

// The old /ask journeys moved to e2e/agent.spec.ts (the AI agent replaced "Ask the data"; /ask redirects to /agent).

test("insights: the floating AI insights card is hidden until a real LLM provider is configured", async ({ page }) => {
  const res = await (await page.request.get(`${API}/insights?view=overview`, { headers: { "X-Role": "ministry" } })).json();
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Headline indicators" }).getByRole("listitem").first()).toBeVisible();
  // v2 shell: the right-hand rail became a floating glass card (bottom-left) that opens the insights modal
  const card = page.getByRole("complementary", { name: "AI insights" });
  if (res.provider === "template") await expect(card).toHaveCount(0);
  else {
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Review insights" }).click();
    await expect(page.getByRole("dialog", { name: /AI insights/ })).toBeVisible();
  }
});
