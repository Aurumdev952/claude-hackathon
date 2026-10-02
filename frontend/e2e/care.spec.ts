import { expect, type Page, test } from "@playwright/test";
import { API } from "./helpers";

/** v3 care loop (track U1): doctor approves a plan -> the patient's phone gets the message -> the sim clock moves ->
 * the plan view follows. This spec ADVANCES THE SHARED SIM CLOCK by 7 days (once per run): run it against your own
 * servers / data copy. Patients are referred to by display ID only. */

const FAC = 1207; // Musanze (Synthetic): the demo facility with care plans
const DOC = { "X-Role": "doctor", "X-Facility-Id": String(FAC) };
const pat = (id: number) => ({ "X-Role": "patient", "X-Patient-Id": String(id) });
const PLANNABLE = ["RISK_BAND_HIGH", "ALARM_NO_SCOPE_90D", "HB_DROP", "HP_POS_UNTREATED"];

async function asDoctor(page: Page) {
  await page.addInitScript((f) => {
    localStorage.setItem("es-role", JSON.stringify({ state: { role: "doctor", facilityId: f, facilityName: "Musanze District Hospital (Synthetic)", patientId: null, patientDisplayId: null }, version: 0 }));
  }, FAC);
}
async function asPatient(page: Page, id: number, displayId: string) {
  await page.addInitScript(([i, d]) => {
    localStorage.setItem("es-role", JSON.stringify({ state: { role: "patient", facilityId: null, facilityName: null, patientId: i, patientDisplayId: d }, version: 0 }));
  }, [id, displayId] as const);
}
const json = async (page: Page, url: string, headers: Record<string, string> = {}) => (await (await page.request.get(`${API}${url}`, { headers })).json());

/** A flagged patient at the facility with no open endoscopy referral: HIGH first, then any NEW plannable alert, then any
 * scored patient. Returns the alert to approve when there is one. */
async function pickPatient(page: Page) {
  const hasOpenEndo = async (id: number) => {
    const c = await json(page, `/patients/${id}/care`, DOC);
    return (c.data?.plans ?? []).some((p: any) => p.pathway === "ENDOSCOPY_REFERRAL" && ["ACTIVE", "ESCALATED"].includes(p.status));
  };
  const alerts = (await json(page, "/alerts?status=NEW", DOC)).data as any[];
  const high = (await json(page, "/patients?status=flagged&risk_band=HIGH&page_size=50", DOC)).data as any[];
  for (const p of high) if (!(await hasOpenEndo(p.patient_id))) return { p, alert: alerts.find((a) => a.patient_id === p.patient_id && PLANNABLE.includes(a.trigger)) ?? null };
  for (const a of alerts.filter((x) => PLANNABLE.includes(x.trigger))) {
    if (!(await hasOpenEndo(a.patient_id))) return { p: { patient_id: a.patient_id, display_id: a.display_id }, alert: a };
  }
  const any = (await json(page, "/patients?status=flagged&page_size=50", DOC)).data as any[];
  for (const p of any) if (!(await hasOpenEndo(p.patient_id))) return { p, alert: null };
  throw new Error("no flagged patient without an open endoscopy referral");
}

test("care loop: approve & plan -> patient notified -> 7 sim days -> plan view follows", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const { p, alert } = await pickPatient(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // 1. doctor opens the patient (search by display id) and approves an endoscopy referral with App + SMS
  await asDoctor(page);
  await page.goto("/doctor");
  await page.getByRole("textbox", { name: "Search patients" }).fill(p.display_id);
  const row = page.getByRole("list", { name: "Patients" }).getByRole("button").filter({ hasText: p.display_id }).first();
  await expect(row).toBeVisible();
  await row.click();
  if (alert) await page.getByRole("button", { name: "Approve & plan" }).first().click();
  else await page.getByRole("button", { name: "Start care plan" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /Endoscopy referral/ }).click();
  const channels = dialog.getByRole("group", { name: "Notification channels" });
  for (const [name, on] of [["Patient app", true], ["SMS", true], ["Community health worker", false]] as const) {
    const b = channels.getByRole("button", { name });
    if ((await b.getAttribute("aria-pressed")) !== String(on)) await b.click();
    await expect(b).toHaveAttribute("aria-pressed", String(on));
  }
  // the live preview shows the patient message (never a diagnosis)
  await expect(dialog.getByLabel("Patient message preview")).toContainText(/check-up/i);
  const created = page.waitForResponse((r) => r.url().endsWith("/care/plans") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Approve and notify" }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const plan = (await res.json()).data;
  expect(plan.plan.pathway).toBe("ENDOSCOPY_REFERRAL");
  expect(new Set(plan.notifications.map((n: any) => n.channel))).toEqual(new Set(["APP", "SMS"]));
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 2. patient role for that patient: the notification is in the inbox (API and phone UI)
  const notes = (await json(page, "/me/notifications", pat(p.patient_id))).data as any[];
  expect(notes.some((n) => n.plan_id === plan.plan.id && n.channel === "APP")).toBeTruthy();
  expect(notes.some((n) => n.plan_id === plan.plan.id && n.channel === "SMS")).toBeTruthy();
  await page.getByRole("button", { name: /^Doctor/ }).click();
  await page.getByRole("menuitem", { name: /Patient app/ }).click();
  await expect(page).toHaveURL(/\/patient$/);
  // no patient chosen yet: the demo picker lists patients with approved plans (newest first)
  await page.getByRole("list", { name: "Demo patients" }).getByRole("button", { name: new RegExp(p.display_id) }).click();
  const phone = page.getByTestId("patient-app");
  await phone.getByRole("button", { name: /Messages, \d+ unread/ }).click();
  const appMsg = notes.find((n) => n.plan_id === plan.plan.id && n.channel === "APP");
  await expect(phone.getByRole("list", { name: "App messages" })).toContainText(appMsg.title);
  await phone.getByRole("tab", { name: "SMS" }).click();
  await expect(phone.getByLabel("SMS thread")).toContainText(/endoscopy/i);
  await phone.getByRole("button", { name: "Back" }).click();
  await phone.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(phone.getByRole("region", { name: "Endoscopy referral" }).first()).toContainText("Upper GI endoscopy");
  const before = (await json(page, "/me/plan", pat(p.patient_id))).data.plans.find((x: any) => x.id === plan.plan.id);

  // 3. advance the shared sim clock 7 days through the API job
  const t0 = (await json(page, "/admin/sim/status")).data.sim_time as string;
  const job = await page.request.post(`${API}/admin/sim`, { data: { action: "advance", days: 7 }, headers: { "X-Role": "ministry" } });
  expect(job.ok(), await job.text()).toBeTruthy();
  const jobId = (await job.json()).data.job_id;
  await expect.poll(async () => (await json(page, `/admin/sim/jobs/${jobId}`)).data.status, { timeout: 10 * 60_000, intervals: [2000] }).toMatch(/done|failed/);
  expect((await json(page, `/admin/sim/jobs/${jobId}`)).data.status).toBe("done");
  const t1 = (await json(page, "/admin/sim/status")).data.sim_time as string;
  expect(Math.round((Date.parse(t1) - Date.parse(t0)) / 86400_000)).toBe(7);

  // 4. the plan view follows: the phone shows the new sim date and the plan's current state from the EMR loop
  const after = (await json(page, "/me/plan", pat(p.patient_id))).data.plans.find((x: any) => x.id === plan.plan.id);
  const label = new Date(t1).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  // the status bar sits on the phone frame, outside the app
  await expect(page.getByRole("region", { name: "Simulated phone" }).getByLabel(`Simulated date ${label}`)).toBeVisible({ timeout: 60_000 });
  const endo = after.tasks.find((t: any) => t.type === "ENDOSCOPY");
  const card = phone.getByRole("region", { name: "Endoscopy referral" }).first();
  await expect(card).toContainText("Upper GI endoscopy");
  if (endo.status === "COMPLETED") await expect(card.getByRole("listitem").filter({ hasText: "Upper GI endoscopy" })).toContainText("Done");
  else await expect(card.getByRole("listitem").filter({ hasText: "Upper GI endoscopy" })).toContainText(/To do|Late/);
  // the care engine reconciled the plan over those days (events never go backwards)
  expect(after.events.length).toBeGreaterThanOrEqual(before.events.length);
  await expect(page.getByRole("region", { name: "Simulated phone" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("follow-ups tab: worklist with likely-to-attend and row actions", async ({ page }) => {
  await asDoctor(page);
  await page.goto("/doctor");
  await page.getByRole("tab", { name: /Follow-ups/ }).click();
  const list = page.getByRole("list", { name: "Follow-ups" });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  await expect(page.getByText("Likely to attend").first()).toBeVisible();
  await expect(list.getByRole("button", { name: /^Actions for / }).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Plan steps" })).toBeVisible();
});

test("case screen: Journey tab for the oncology demo patient (MUS-00154716)", async ({ page }) => {
  const found = (await json(page, "/patients?status=diagnosed&q=MUS-00154716", DOC)).data as any[];
  test.skip(!found.length, "oncology demo patient not in this dataset");
  await asDoctor(page);
  await page.goto(`/doctor/case/${found[0].patient_id}`);
  await expect(page.getByTestId("case-analysis")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Journey/ })).toHaveAttribute("aria-selected", "true");
  const phases = page.getByRole("list", { name: "Journey phases" });
  await expect(phases).toContainText("Diagnosis");
  await expect(page.getByRole("region", { name: "Specialist treatment plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create video" })).toBeVisible();
});

test("patient check-in round trip writes to the EMR", async ({ page }) => {
  const demo = (await json(page, "/patient-app/demo-patients")).data as any[];
  const p = demo.find((d) => d.display_id === "MUS-00933699") ?? demo[0];
  await asPatient(page, p.patient_id, p.display_id);
  await page.goto("/patient");
  const phone = page.getByTestId("patient-app");
  await phone.getByRole("button", { name: "Check-in", exact: true }).click();
  await phone.getByLabel("Pain").fill("4");
  await phone.getByRole("radio", { name: "No" }).click();
  await phone.getByLabel(/Your weight/).fill("51.5");
  const sent = page.waitForResponse((r) => r.url().endsWith("/me/checkins") && r.request().method() === "POST");
  await phone.getByRole("button", { name: "Send to my care team" }).click();
  const res = await sent;
  expect(res.status()).toBe(201);
  const body = (await res.json()).data;
  expect(body.payload).toMatchObject({ pain: 4, dumping: false, weight_kg: 51.5 });
  expect(typeof body.emr_encounter_id).toBe("number");
  await expect(phone.getByRole("status").filter({ hasText: "Thank you" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Event log" })).toContainText("weekly check-in");
});

test("PWA manifest: installable patient app scoped to /patient/app", async ({ page }) => {
  const res = await page.request.get("/manifest.webmanifest");
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBe("Early Signals Patient (Synthetic)");
  expect(m.short_name).toBe("My care");
  expect(m.start_url).toBe("/patient/app");
  expect(m.scope).toBe("/patient/app");
  expect(m.display).toBe("standalone");
  for (const size of ["192x192", "512x512"]) expect(m.icons.some((i: any) => i.sizes === size && i.purpose === "any")).toBeTruthy();
  expect(m.icons.some((i: any) => i.purpose === "maskable")).toBeTruthy();
  for (const i of m.icons) expect((await page.request.get(i.src)).ok()).toBeTruthy();
  // the full-screen app renders outside the dashboard shell
  await asPatient(page, 0, "");
  await page.goto("/patient/app");
  await expect(page.getByRole("list", { name: "Demo patients" }).or(page.getByTestId("patient-app"))).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
});
