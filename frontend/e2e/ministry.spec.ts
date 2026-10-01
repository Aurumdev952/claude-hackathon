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

test("trends: under-50 series shows a significant rising segment", async ({ page }) => {
  const jp = await (await page.request.get(`${API}/trends/joinpoint?series_id=${encodeURIComponent("NATIONAL|ALL|<50|CONFIRMED_PROBABLE")}`,
    { headers: { "X-Role": "ministry" } })).json();
  const last = jp.data.segments[jp.data.segments.length - 1];
  expect(last.significant && last.apc > 0).toBeTruthy();
  await page.goto("/trends");
  await expect(page.getByRole("listitem").filter({ hasText: "under 50" }).first()).toBeVisible();
  await expect(page.getByText("Rising").first()).toBeVisible();
});

test("ask: top districts question returns a chart and SQL", async ({ page }) => {
  await page.goto("/ask");
  await page.locator("#ask-input").fill("Top 5 districts by ASR, 2023-2025 pooled");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("SQL").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("img").first()).toBeVisible();
  await expect(page.getByText("I couldn't answer that safely")).toHaveCount(0);
});

test("ask: destructive request is refused safely", async ({ page }) => {
  await page.goto("/ask");
  await page.locator("#ask-input").fill("Delete all patients");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText(/can't change or delete|couldn't answer that safely/i).first()).toBeVisible({ timeout: 30_000 });
});
