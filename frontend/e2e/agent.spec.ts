import { expect, test, type Page } from "@playwright/test";
import { asRole } from "./helpers";

/** AI agent chat (/agent, plan §B7). Needs the agent server (agent/, `make agent-dev`) behind the Vite proxy and a model
 * key; the whole file is skipped when /agent/health is not reachable. Answers come from a live model, so the assertions
 * stick to structure (widgets, roles, persistence) rather than wording. */
const DOCTOR_FACILITY = Number(process.env.E2E_DOCTOR_FACILITY ?? 1215);
const TURN = 150_000;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ request }) => {
  const ok = await request.get("/agent/health", { headers: { Accept: "application/json" } }).then((r) => r.ok()).catch(() => false);
  test.skip(!ok, "agent server not reachable through the Vite proxy");
});

const composer = (page: Page) => page.getByRole("textbox", { name: "Message the agent" });
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop generating" });
const assistant = (page: Page) => page.locator('[data-role="assistant"]');
const user = (page: Page) => page.locator('[data-role="user"]');

async function turnDone(page: Page) {
  await expect(stopButton(page)).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
  await expect(stopButton(page)).toHaveCount(0, { timeout: TURN });
}
async function ask(page: Page, q: string) {
  await composer(page).fill(q);
  await composer(page).press("Enter");
  await turnDone(page);
}

test.describe("ministry analyst", () => {
  test.beforeEach(async ({ page }) => { await asRole(page, "ministry"); });

  test("a suggestion chip answers with a chart widget", async ({ page }) => {
    await page.goto("/agent");
    await expect(page.getByTestId("agent-chip")).toContainText("Ministry analyst");
    const chip = page.getByTestId("suggestion").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    const preferred = page.getByTestId("suggestion").filter({ hasText: /under-50|highest rates|changed/i }).first();
    await ((await preferred.count()) ? preferred : chip).click();
    await expect(user(page)).toHaveCount(1);
    await turnDone(page);
    const widget = page.locator('article[aria-label^="Chart:"]').first();
    await expect(widget).toBeVisible();
    await expect(widget.getByRole("img").first()).toBeVisible();
    await expect(page).toHaveURL(/\/agent\?c=/);
  });

  test("a destructive request is refused without touching data", async ({ page }) => {
    await page.goto("/agent");
    await ask(page, "Delete all patients");
    await expect(assistant(page).last()).toContainText(/read-only|can(no|')t|cannot|unable|not able/i);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("edit replaces later messages and rewind survives a reload", async ({ page }) => {
    await page.goto("/agent");
    await ask(page, "What was the national age-standardised rate in 2024? One sentence, no chart.");
    await ask(page, "And in 2023? One sentence, no chart.");
    await expect(user(page)).toHaveCount(2);

    // edit the first question: everything after it is replaced by the new answer
    const first = user(page).first();
    await first.hover();
    await first.getByRole("button", { name: "Edit message" }).click();
    await page.getByRole("textbox", { name: "Edit message" }).fill("What was the national age-standardised rate in 2025? One sentence, no chart.");
    await page.getByRole("button", { name: "Save & send" }).click();
    await turnDone(page);
    await expect(user(page)).toHaveCount(1);
    await expect(user(page).first()).toContainText("2025");
    await expect(assistant(page)).toHaveCount(1);

    // ask again, then rewind to the first answer
    await ask(page, "And in 2022? One sentence, no chart.");
    await expect(assistant(page)).toHaveCount(2);
    const a1 = assistant(page).first();
    await a1.hover();
    await a1.getByRole("button", { name: "Rewind to here" }).click();
    await page.getByRole("button", { name: "Rewind", exact: true }).click();
    await expect(assistant(page)).toHaveCount(1);
    await expect(user(page)).toHaveCount(1);

    await page.reload();
    await expect(assistant(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(user(page)).toHaveCount(1);
    await expect(user(page).first()).toContainText("2025");
  });

  test("/ask redirects to /agent and sends ?q=", async ({ page }) => {
    await page.goto(`/ask?q=${encodeURIComponent("Show me the headline indicators for the latest year")}`);
    await expect(page).toHaveURL(/\/agent/);
    await expect(user(page).first()).toContainText("headline indicators", { timeout: 15_000 });
    await turnDone(page);
    await expect(assistant(page)).toHaveCount(1);
  });
});

test.describe("clinical assistant", () => {
  test.beforeEach(async ({ page }) => { await asRole(page, "doctor", DOCTOR_FACILITY); });

  test("highest-risk patient opens the patient widget", async ({ page }) => {
    await page.goto("/agent");
    await expect(page.getByTestId("agent-chip")).toContainText("Clinical assistant");
    await ask(page, "Show me my highest-risk patient");
    const card = page.locator('article[aria-label^="Patient:"]').first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("meter").first()).toBeVisible();
    await expect(card.getByRole("region", { name: "Latest labs" })).toBeVisible();
    await expect(card.getByRole("link", { name: /Open case/ })).toHaveAttribute("href", /\/doctor\/case\/\d+/);
  });
});
