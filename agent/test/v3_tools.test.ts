/** v3 tools (care coordination, journey, forecasts, scenarios, learning loop, videos) against the fixture serve DB, with
 * a mock FastAPI / video server for the tools that call them. No model calls. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/config.js";
import { guardedQuery } from "../src/db/query.js";
import { api, UpstreamError } from "../src/lib/upstream.js";
import { ALL_TOOLS, modelSafe, toolDefsFor, type AnyToolDef } from "../src/tools/index.js";
import { newToolCtx, type ToolCtx } from "../src/tools/types.js";
import { ChartWidget, DOCTOR_TOOLS, FORBIDDEN_ACTION_TOOLS, MINISTRY_TOOLS, VideoWidget } from "../src/widgets/specs.js";

const by = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t])) as Record<string, AnyToolDef>;
const ministry = () => newToolCtx({ role: "ministry", facilityId: null });
const doctor = (f = 101) => newToolCtx({ role: "doctor", facilityId: f });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(name: string, input: Record<string, unknown>, t: ToolCtx): Promise<any> {
  return by[name].execute(by[name].inputSchema.parse(input), t);
}
const NAMES = /Alice|Uwase|Jean|Habimana|Grace|Mukamana|Eric|Niyonzima|given_name|family_name|Hi Alice/;

// ------------------------------------------------------------------ mock upstream (FastAPI + video server in one)
type Hit = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: unknown };
const hits: Hit[] = [];
let server: Server;
let base = "";
let videoDown = false;

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = req.url ?? "";
  hits.push({ method: req.method ?? "GET", url, headers: req.headers, body });
  const env = (data: unknown, extra: object = {}) => ({ meta: { run_id: 7 }, data, ...extra });
  if (url === "/api/v1/patients/1/care") {
    return reply(res, 200, env({ plans: [{ id: "CP-LIVE0001", pathway: "ENDOSCOPY_REFERRAL", status: "ACTIVE", channels: ["APP", "SMS"], approved_at: "2026-06-30T10:00:00",
      note: "Daughter Alice Uwase answers the phone",
      tasks: [{ id: "T1", seq: 1, type: "ENDOSCOPY", title: "Upper GI endoscopy", status: "NOTIFIED", due_at: "2026-07-14T23:59:59", reminders: 1, escalation_level: 0 }],
      events: [{ kind: "PLAN_CREATED", sim_time: "2026-06-30T10:00:00", actor: "doctor", detail: "{\"pathway\": \"ENDOSCOPY_REFERRAL\"}" }] }] }));
  }
  if (url === "/api/v1/care/worklist") {
    return reply(res, 200, env([
      { task: { id: "T9", plan_id: "P9", patient_id: 2, type: "HP_TEST", title: "H. pylori test", status: "DUE", due_at: "2026-07-05T00:00:00", overdue_days: 0, reminders: 0, escalation_level: 0 },
        plan: { id: "P9", pathway: "HP_TEST_AND_TREAT" }, patient: { patient_id: 2, display_id: "ES-0002-B", given_name: "Jean", family_name: "Habimana", age: 63, sex: "M" }, p_adhere: 0.41, priority: 0.9 },
      { task: { id: "T1", plan_id: "P1", patient_id: 1, type: "ENDOSCOPY", title: "Upper GI endoscopy", status: "OVERDUE", due_at: "2026-06-03T23:59:59", overdue_days: 27, reminders: 2, escalation_level: 1 },
        plan: { id: "P1", pathway: "ENDOSCOPY_REFERRAL" }, patient: { patient_id: 1, display_id: "ES-0001-A", given_name: "Alice", family_name: "Uwase", age: 58, sex: "F" }, p_adhere: 0.62, priority: 0.5 },
    ]));
  }
  if (url === "/api/v1/care/notifications/preview" && req.method === "POST") {
    return reply(res, 200, env({ pathway: body.pathway, target_facility: { id: 201, name: "Ruhengeri District Hospital (Synthetic)" },
      tasks: [{ seq: 1, type: "ENDOSCOPY", title: "Upper GI endoscopy", status: "DUE", opens_at: "2026-06-30T23:59:59", due_at: "2026-07-14T23:59:59" }],
      messages: [{ channel: "APP", title: "Check-up advised", body: "Please visit Ruhengeri District Hospital (Synthetic) for a check-up by 14 July 2026.", greeting: "Hi Alice," },
                 { channel: "SMS", title: null, body: "Early Signals: please visit Ruhengeri District Hospital (Synthetic) for a check-up by 14 Jul." }] }));
  }
  if (url === "/api/v1/forecast/scenario" && req.method === "POST") {
    return reply(res, 200, env({ baseline: [{ year: 2030, mean: 3906.2, lo95: 3244.8, hi95: 4373.1 }, { year: 2031, mean: 4186.4, lo95: 3371.9, hi95: 4875.9 }],
      scenario: [{ year: 2030, mean: 3800.0, lo95: 3150.0, hi95: 4270.0 }, { year: 2031, mean: 4020.4, lo95: 3240.0, hi95: 4700.0 }],
      cases_averted: 272.2, cases_averted_range: [180.4, 351.9], stage_shift: { early_pct_baseline: 22.04, early_pct_scenario: 24.51, districts_gaining_access: ["SOU-NYG"] },
      assumptions: ["H. pylori treatment efficacy 85%", "Effects ramp up over 5 years"], elapsed_ms: 12.3 }, { note: "Synthetic data." }));
  }
  if (url === "/video/jobs" && req.method === "POST") {
    if (videoDown) return reply(res, 503, { error: "render queue offline" });
    return reply(res, 202, { job_id: "0123456789abcdef0123456789abcdef", cached: false });
  }
  if (url === "/video/jobs/0123456789abcdef0123456789abcdef") {
    return reply(res, 200, { job_id: "0123456789abcdef0123456789abcdef", status: "rendering", progress: 0.25, url: null, poster_url: null, download_url: null, error: null });
  }
  return reply(res, 404, { error: { code: "NOT_FOUND", message: `mock: ${req.method} ${url}` } });
}

function useApi(on: boolean) {
  process.env.API_URL = on ? base : "http://127.0.0.1:9"; // port 9 (discard) refuses connections
  process.env.VIDEO_URL = on ? base : "http://127.0.0.1:9";
  process.env.AGENT_UPSTREAM_TIMEOUT_MS = "3000";
  resetConfig();
}

beforeAll(async () => {
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  useApi(false);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hits.length = 0;
  videoDown = false;
  useApi(false);
});

describe("v3 tool registry", () => {
  it("doctor gets the care tools, the ministry the outlook tools, both create_video", () => {
    const d = toolDefsFor("doctor").map((x) => x.name);
    const m = toolDefsFor("ministry").map((x) => x.name);
    expect(d).toEqual([...DOCTOR_TOOLS]);
    expect(m).toEqual([...MINISTRY_TOOLS]);
    for (const n of ["get_care_plan", "list_followups", "get_patient_journey", "draft_care_plan", "create_video"]) expect(d).toContain(n);
    for (const n of ["get_care_funnel", "get_forecast", "run_forecast_scenario", "get_model_monitoring", "create_video"]) expect(m).toContain(n);
    for (const n of ["get_care_plan", "list_followups", "draft_care_plan"]) expect(m).not.toContain(n);
    for (const n of ["get_care_funnel", "get_forecast", "run_forecast_scenario"]) expect(d).not.toContain(n);
  });

  it("no tool can create plans, change tasks or send notifications", () => {
    const names = ALL_TOOLS.map((t) => t.name as string);
    for (const f of FORBIDDEN_ACTION_TOOLS) expect(names).not.toContain(f);
    expect(names.filter((n) => /^(send|notify|approve|create_(care_)?plan|patch|update|delete)/.test(n))).toEqual([]);
  });

  it("the upstream helper refuses write endpoints", async () => {
    useApi(true);
    const ctx = { role: "doctor" as const, facilityId: 101 };
    for (const path of ["/care/plans", "/care/tasks/T1", "/me/notifications/N-1/read", "/models/x/promote"]) {
      await expect(api(ctx, path, { method: "POST", body: {} })).rejects.toMatchObject({ code: "AGENT_WRITE_BLOCKED" });
    }
    expect(hits).toHaveLength(0);
    await expect(api(ctx, "/nope")).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("doctor care tools", () => {
  it("get_care_plan falls back to the published snapshot and keeps notes off the model view", async () => {
    const t = doctor();
    const o = await run("get_care_plan", { display_id: "ES-0001-A" }, t);
    expect(o.ok).toBe(true);
    expect(o.source).toBe("snapshot");
    expect(o.plans).toHaveLength(1);
    expect(o.plans[0]).toMatchObject({ id: "CP-0000A001", pathway: "ENDOSCOPY_REFERRAL", channels: ["APP", "SMS"] });
    expect(o.summary).toMatchObject({ n_plans: 1, open_tasks: 2, overdue_tasks: 1 });
    expect(o.plans[0].events.map((e: { kind: string }) => e.kind)).toEqual(["PLAN_CREATED", "NOTIFIED", "ESCALATED"]);
    expect(o.plans[0].note).toContain("Tuesday");
    const safe = JSON.stringify(modelSafe(by.get_care_plan, o, t));
    expect(safe).not.toContain("Tuesday");
    expect(safe).not.toMatch(NAMES);
  });

  it("get_care_plan reads the live API when it is up (role headers forwarded)", async () => {
    useApi(true);
    const t = doctor();
    const o = await run("get_care_plan", { patient_id: 1 }, t);
    expect(o.source).toBe("live");
    expect(o.plans[0].id).toBe("CP-LIVE0001");
    expect(o.summary.next_due).toMatchObject({ type: "ENDOSCOPY", due_at: "2026-07-14T23:59:59" });
    expect(hits[0].headers["x-role"]).toBe("doctor");
    expect(hits[0].headers["x-facility-id"]).toBe("101");
    expect(JSON.stringify(modelSafe(by.get_care_plan, o, t))).not.toMatch(NAMES);
  });

  it("get_care_plan refuses patients of another facility", async () => {
    const o = await run("get_care_plan", { display_id: "ES-0004-D" }, doctor(101));
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/not found at this facility/);
  });

  it("list_followups: snapshot fallback is facility-scoped, overdue / escalated first", async () => {
    const o = await run("list_followups", {}, doctor(101));
    expect(o.ok).toBe(true);
    expect(o.source).toBe("snapshot");
    expect(o.rows.map((r: { task_id: string }) => r.task_id)).toEqual(["CT-A001-1", "CT-A002-2"]);
    expect(o.rows[0].status).toBe("ESCALATED");
    expect(o.overdue).toBe(1);
    const late = await run("list_followups", { status: "overdue" }, doctor(102));
    expect(late.rows.map((r: { task_id: string }) => r.task_id)).toEqual(["CT-B001-1"]);
  });

  it("list_followups (live): overdue first even with a lower priority; names only on the UI side", async () => {
    useApi(true);
    const t = doctor();
    const o = await run("list_followups", {}, t);
    expect(o.source).toBe("live");
    expect(o.rows.map((r: { display_id: string }) => r.display_id)).toEqual(["ES-0001-A", "ES-0002-B"]);
    expect(o.rows[1]).toMatchObject({ p_adhere: 0.41, given_name: "Jean" });
    const safe = JSON.stringify(modelSafe(by.list_followups, o, t));
    expect(safe).not.toMatch(NAMES);
    expect(safe).toContain("ES-0002-B");
  });

  it("get_patient_journey: phases, recovery summary and series rows from the snapshot", async () => {
    const t = doctor();
    const o = await run("get_patient_journey", { display_id: "ES-0003-C" }, t);
    expect(o.ok).toBe(true);
    expect(o.current_phase).toBe("Survivorship");
    expect(o.phases.map((p: { phase: string }) => p.phase)).toEqual(["Endoscopy", "Diagnosis", "Treatment", "Survivorship"]);
    expect(o.recovery).toMatchObject({ intent: "Curative", gastrectomy: true, chemo_done: 6, chemo_planned: 8, weight_change_pct: -9.2, next_visit_due: "2026-07-10" });
    expect(o.rows.filter((r: { metric: string }) => r.metric === "weight")).toHaveLength(3);
    expect(t.datasets.get(o.dataset_id)?.rows.length).toBe(o.rows.length);
  });

  it("draft_care_plan only previews: suggests the pathway, strips the greeting, never creates or sends", async () => {
    useApi(true);
    const t = doctor();
    const o = await run("draft_care_plan", { display_id: "ES-0001-A" }, t);
    expect(o.ok).toBe(true);
    expect(o).toMatchObject({ draft: true, approved: false, created: false, notifications_sent: 0, pathway: "ENDOSCOPY_REFERRAL", source_alert_id: "a-001" });
    expect(o.approval).toMatch(/Approve & plan/);
    expect(o.messages).toHaveLength(2);
    expect(JSON.stringify(o)).not.toMatch(NAMES);
    const posts = hits.filter((h) => h.method !== "GET");
    expect(posts.map((h) => h.url)).toEqual(["/api/v1/care/notifications/preview"]);
    expect(posts[0].body).toMatchObject({ patient_id: 1, pathway: "ENDOSCOPY_REFERRAL", alert_id: "a-001" });
    expect(hits.some((h) => /\/care\/plans|\/care\/tasks|\/me\//.test(h.url) && h.method !== "GET")).toBe(false);
  });

  it("draft_care_plan suggests survivorship for a treated case and reports the preview service being down", async () => {
    const o = await run("draft_care_plan", { display_id: "ES-0003-C" }, doctor());
    expect(o.ok).toBe(false);
    expect(o).toMatchObject({ draft: true, approved: false, suggested_pathway: "SURVIVORSHIP" });
  });
});

describe("ministry outlook tools", () => {
  it("get_care_funnel sums the funnel and suppresses small cells", async () => {
    const t = ministry();
    const o = await run("get_care_funnel", {}, t);
    expect(o.ok).toBe(true);
    const steps = Object.fromEntries(o.rows.map((r: { step: string }) => [r.step, r]));
    expect(steps.flagged.n).toBe(90);
    expect(steps.approved).toMatchObject({ n: 48, pct_of_prev: 53.3 });
    expect(steps.early_stage).toMatchObject({ n: null, n_label: "<5", pct_of_prev: null });
    const nyg = o.by_district.rows.find((r: { district_code: string }) => r.district_code === "SOU-NYG");
    expect(nyg).toMatchObject({ flagged: null, flagged_label: "<5", district_name: "Nyaruguru" });
    const sms = o.adherence.rows.find((r: { level: string }) => r.level === "SMS");
    expect(sms).toMatchObject({ n: null, n_label: "<5", rate: null, median_days: null });
    expect(o.days_to_endoscopy).toMatchObject({ n: 33, median_days: 18 });
    expect(o.impact.rows.find((r: { route: string }) => r.route === "care_pathway")).toMatchObject({ n: null, early_stage_pct: null });
    const safe = JSON.stringify(modelSafe(by.get_care_funnel, o, t));
    expect(safe).not.toMatch(/patient_id|display_id/);
  });

  it("get_forecast: history + forecast with nested bands, bridge, summary, drivers, backtest", async () => {
    const t = ministry();
    const o = await run("get_forecast", { year_from: 2020 }, t);
    expect(o.ok).toBe(true);
    expect(o.series_id).toBe("NATIONAL|ALL|ALL|REGISTRY");
    const y = Object.fromEntries(o.rows.map((r: { year: number }) => [r.year, r]));
    expect(y[2025]).toMatchObject({ kind: "history", observed: 2800, forecast: 2800, lo95: null });
    expect(y[2031]).toMatchObject({ kind: "forecast", observed: null, forecast: 3280 });
    for (const r of o.rows.filter((x: { kind: string }) => x.kind === "forecast")) expect(r.lo95 <= r.lo80 && r.lo80 <= r.forecast && r.forecast <= r.hi80 && r.hi80 <= r.hi95).toBe(true);
    expect(o.summary).toMatchObject({ horizon_year: 2031, mean: 3280, lo95: 2980, hi95: 3580, last_observed_year: 2025, change_pct: 17.1 });
    expect(o.drivers.map((d: { component: string }) => d.component).sort()).toEqual(["ageing", "population", "risk"]);
    expect(o.backtest).toMatchObject({ mape_pct: 5, n_points: 2 });
  });

  it("get_forecast suppresses small district history and charts as a fan", async () => {
    const t = ministry();
    const o = await run("get_forecast", { geo: "DISTRICT", code: "SOU-NYG" }, t);
    const small = o.rows.filter((r: { observed_label?: string }) => r.observed_label === "<5");
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((r: { observed: unknown }) => r.observed === null)).toBe(true);
    const nat = await run("get_forecast", {}, t);
    const ch = await run("make_chart", {
      type: "line", title: "Gastric cancer cases to 2031", dataset_id: nat.dataset_id, x: "year",
      series: [{ key: "observed" }, { key: "forecast", dashed: true }], fan: { lo80: "lo80", hi80: "hi80", lo95: "lo95", hi95: "hi95" },
    }, t);
    const w = ChartWidget.parse(ch);
    expect(w.spec.type).toBe("line");
    if (w.spec.type === "line") expect(w.spec.fan).toMatchObject({ lo95: "lo95", start: 2026 });
    const bad = await run("make_chart", { type: "line", title: "x", dataset_id: nat.dataset_id, x: "year", y: "forecast", fan: { lo95: "nope", hi95: "hi95" } }, t);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/nope/);
  });

  it("run_forecast_scenario posts to the API and merges baseline and scenario by year", async () => {
    useApi(true);
    const o = await run("run_forecast_scenario", { hp_coverage_delta: 0.5, endoscopy_access: ["SOU-NYG"] }, ministry());
    expect(o.ok).toBe(true);
    expect(o.cases_averted).toBe(272);
    expect(o.cases_averted_range).toEqual([180, 352]);
    expect(o.stage_shift).toMatchObject({ early_pct_baseline: 22, early_pct_scenario: 24.5, districts_gaining_access: ["SOU-NYG"] });
    expect(o.rows.at(-1)).toMatchObject({ year: 2031, baseline: 4186, scenario: 4020, averted: 166 });
    expect(hits[0]).toMatchObject({ method: "POST", url: "/api/v1/forecast/scenario" });
    expect(hits[0].headers["x-role"]).toBe("ministry");
    expect(hits[0].body).toMatchObject({ hp_coverage_delta: 0.5, smoking_delta: 0, until: 2031 });
  });

  it("run_forecast_scenario reports an unreachable API as data", async () => {
    const o = await run("run_forecast_scenario", { smoking_delta: -0.2 }, ministry());
    expect(o.ok).toBe(false);
    expect(o.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("get_model_monitoring: champion, challenger, gates, drift and suppressed feedback counts", async () => {
    const t = ministry();
    const o = await run("get_model_monitoring", {}, t);
    expect(o.ok).toBe(true);
    expect(o.champion).toMatchObject({ model_id: "t2_xgb", status: "champion" });
    expect(o.challenger).toMatchObject({ model_id: "t2_xgb_ch1", n_feedback_labels: 42 });
    expect(o.latest_run.decision).toBe("pending");
    expect(o.latest_run.gates.map((g: { name: string }) => g.name)).toEqual(["auroc", "high_volume_change"]);
    expect(o.rows[0]).toMatchObject({ feature: "days_in_cohort", level: "major" });
    expect(o.monitoring.ppv_verified).toMatchObject({ value: null, n: null, n_label: "<5" });
    expect(o.feedback).toMatchObject({ n: null, n_label: "<5" });
    expect(o.governance).toMatch(/Promote/);
    expect(JSON.stringify(modelSafe(by.get_model_monitoring, o, t))).not.toMatch(/patient_id/);
  });
});

describe("create_video", () => {
  it("doctor: patient case video -> VideoWidget, role headers forwarded, display id only", async () => {
    useApi(true);
    const t = doctor();
    const o = await run("create_video", { kind: "patient", display_id: "ES-0001-A" }, t);
    const w = VideoWidget.parse(o);
    expect(w).toMatchObject({ kind: "video", video_kind: "patient", status: "rendering", progress: 0.25, status_url: "/video/jobs/0123456789abcdef0123456789abcdef" });
    expect(w.title).toContain("ES-0001-A");
    expect(JSON.stringify(w)).not.toMatch(NAMES);
    expect(hits[0]).toMatchObject({ method: "POST", url: "/video/jobs", body: { kind: "patient", params: { patient_id: 1 } } });
    expect(hits[0].headers["x-facility-id"]).toBe("101");
    const safe = modelSafe(by.create_video, o, t) as Record<string, unknown>;
    expect(safe).toMatchObject({ ok: true, status: "rendering" });
  });

  it("role rules: doctors only patient videos (own facility), ministry only reels", async () => {
    useApi(true);
    expect((await run("create_video", { kind: "ministry" }, doctor())).ok).toBe(false);
    expect((await run("create_video", { kind: "patient", patient_id: 1 }, ministry())).ok).toBe(false);
    expect((await run("create_video", { kind: "patient", display_id: "ES-0004-D" }, doctor(101))).ok).toBe(false);
    const m = await run("create_video", { kind: "ministry_vertical", from: 2018 }, ministry());
    expect(VideoWidget.parse(m)).toMatchObject({ video_kind: "ministry_vertical" });
    expect(hits.filter((h) => h.method === "POST").map((h) => h.body)).toEqual([{ kind: "ministry_vertical", params: { from: 2018, to: 2026 } }]);
  });

  it("video server errors come back as data with a hint", async () => {
    useApi(true);
    videoDown = true;
    const o = await run("create_video", { kind: "ministry" }, ministry());
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/make video-serve/);
  });
});

describe("v3 guardrails", () => {
  it("ministry: care marts are queryable with suppression, care_* patient rows are not", async () => {
    const ctx = { role: "ministry" as const, facilityId: null };
    const f = await guardedQuery(ctx, "SELECT district_code, flagged, approved, endoscopy FROM mart_care_funnel WHERE district_code = 'SOU-NYG'");
    expect(f.ok).toBe(true);
    expect(f.rows[0]).toMatchObject({ flagged: null, flagged_label: "<5" });
    for (const tbl of ["care_plans", "care_tasks", "pt_care_plan", "pt_journey", "ml_feedback_labels"]) {
      const r = await guardedQuery(ctx, `SELECT count(*) AS n FROM ${tbl}`);
      expect(r.ok, tbl).toBe(false);
      expect(r.error_kind).toBe("unsafe");
    }
    const ext = await guardedQuery(ctx, "SELECT district_code, sum(cases) AS cases FROM ext_registry GROUP BY 1 ORDER BY 1");
    expect(ext.ok).toBe(true);
    expect(ext.rows.find((r) => r.district_code === "SOU-NYG")).toMatchObject({ cases: null, cases_label: "<5" });
    const fc = await guardedQuery(ctx, "SELECT year(period) AS y, mean, cases_obs FROM mart_forecast WHERE series_id LIKE 'SOU-NYG%' AND kind = 'history' AND cases_obs < 5 LIMIT 1");
    expect(fc.rows[0]).toMatchObject({ mean: null, cases_obs: null, cases_obs_label: "<5" });
  });

  it("doctor: care tables are facility-scoped", async () => {
    const r = await guardedQuery({ role: "doctor", facilityId: 101 }, "SELECT DISTINCT patient_id FROM care_tasks ORDER BY 1");
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.patient_id)).toEqual([1, 3]);
    const j = await guardedQuery({ role: "doctor", facilityId: 102 }, "SELECT count(*) AS n FROM pt_journey");
    expect(j.rows[0].n).toBe(1);
  });
});
