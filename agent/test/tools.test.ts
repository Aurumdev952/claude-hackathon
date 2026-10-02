/** Tools against the fixture serve DB (no model calls). */
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, buildTools, modelSafe, toolDefsFor, type AnyToolDef } from "../src/tools/index.js";
import { newToolCtx, type ToolCtx } from "../src/tools/types.js";
import { lateStage } from "../src/tools/clinical.js";
import { ChartWidget, DOCTOR_TOOLS, MINISTRY_TOOLS, PatientWidget } from "../src/widgets/specs.js";

const by = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t])) as Record<string, AnyToolDef>;
const ministry = () => newToolCtx({ role: "ministry", facilityId: null });
const doctor = (f = 101) => newToolCtx({ role: "doctor", facilityId: f });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(name: string, input: Record<string, unknown>, t: ToolCtx): Promise<any> {
  return by[name].execute(by[name].inputSchema.parse(input), t);
}
const NAMES = /Alice|Uwase|Jean|Habimana|Grace|Mukamana|Eric|Niyonzima|given_name|family_name/;

describe("tool registry", () => {
  it("each role gets its own tool set", () => {
    expect(toolDefsFor("ministry").map((d) => d.name)).toEqual([...MINISTRY_TOOLS]);
    expect(toolDefsFor("doctor").map((d) => d.name)).toEqual([...DOCTOR_TOOLS]);
    expect(Object.keys(buildTools(ministry()))).not.toContain("get_patient");
    expect(Object.keys(buildTools(doctor()))).not.toContain("get_kpis");
  });
});

describe("ministry tools", () => {
  it("get_kpis returns the latest year and a by-year dataset", async () => {
    const t = ministry();
    const o = await run("get_kpis", {}, t);
    expect(o.ok).toBe(true);
    expect(o.year).toBe(2026);
    expect(o.partial_year).toBe(true);
    expect(o.last_full_year).toBe(2025);
    expect(o.kpis.national_asr_ci).toHaveLength(2);
    expect(t.datasets.get(o.dataset_id)?.rows.length).toBe(11);
  });

  it("get_rates_trend: under-50 since 2015 with joinpoint APC, partial year excluded", async () => {
    const o = await run("get_rates_trend", { age_band: "<50", year_from: 2015 }, ministry());
    expect(o.ok).toBe(true);
    expect(o.rows[0].year).toBe(2015);
    expect(o.rows.at(-1).year).toBe(2025);
    expect(o.joinpoint.segments).toHaveLength(2);
    expect(o.joinpoint.segments[1]).toMatchObject({ apc: 7.4, significant: true });
    expect(o.joinpoint.observed_suppressed_years).toEqual([2014]);
  });

  it("get_rates_trend suppresses small districts", async () => {
    const o = await run("get_rates_trend", { level: "DISTRICT", geo_code: "SOU-NYG" }, ministry());
    expect(o.rows.every((r: Record<string, unknown>) => r.cases === null && r.asr === null && r.cases_label === "<5")).toBe(true);
  });

  it("get_district_ranking ranks the latest pooled period with hotspots", async () => {
    const o = await run("get_district_ranking", {}, ministry());
    expect(o.period).toBe("2023-2025");
    expect(o.rows.map((r: Record<string, unknown>) => r.geo_code)).toEqual(["NOR-MUS", "WES-RUS", "SOU-NYG"]);
    expect(o.rows[0]).toMatchObject({ rank: 1, lisa_quadrant: "HH", name: "Musanze" });
    expect(o.rows[2]).toMatchObject({ cases: null, asr: null, cases_label: "<5" });
    const hh = await run("get_district_ranking", { hotspots_only: true }, ministry());
    expect(hh.rows).toHaveLength(2);
  });

  it("care cascade, stage mix, survival, facility quality, model metrics", async () => {
    const t = ministry();
    const cc = await run("get_care_cascade", { pathway: "endoscopy" }, t);
    expect(cc.rows.map((r: Record<string, unknown>) => r.stage)).toEqual(["gi_flagged", "referred", "scoped", "biopsied", "diagnosed"]);
    const wes = await run("get_care_cascade", { province: "WES" }, t);
    expect(wes.rows.find((r: Record<string, unknown>) => r.stage === "diagnosed")).toMatchObject({ n: null, n_label: "<5" });
    const sm = await run("get_stage_mix", { by: "tier" }, t);
    expect(sm.chi_square).toMatchObject({ p: 0.027 });
    expect(sm.late_stage).toEqual(expect.arrayContaining([
      { facility_tier: "HC", late_n: 65, late_pct_known: 61.9 },
      { facility_tier: "RH", late_n: 50, late_pct_known: 55.6 },
    ]));
    // a suppressed stage III / IV cell keeps the late-stage share hidden (secondary disclosure)
    expect(lateStage([
      { year: "2024", stage_group: "II", n: 9 }, { year: "2024", stage_group: "III", n: 3 }, { year: "2024", stage_group: "IV", n: 12 },
    ], "year")).toEqual([{ year: 2024, late_n: null, late_pct_known: null, late_label: "suppressed (a stage III or IV cell is <5)" }]);
    const sv = await run("get_survival", { include_curve: true, include_cox: true }, t);
    expect(sv.rows.find((r: Record<string, unknown>) => r.group_value === "IV").surv_1y).toBe(0.18);
    expect(sv.curve.dataset_id).toMatch(/^ds\d+$/);
    expect(sv.cox.rows).toHaveLength(3);
    const fq = await run("get_facility_quality", { order: "asc" }, t);
    expect(fq.rows[0]).toMatchObject({ name: "Musanze Health Centre", hp_test_rate_pct: 5 });
    const below = await run("get_facility_quality", { max_hp_test_rate: 0.1, limit: 1 }, t);
    expect(below).toMatchObject({ count: 1, total_matching: 1, n_with_no_hp_tests: 0 });
    expect(below.rows[0].name).toBe("Musanze Health Centre");
    const mm = await run("get_model_metrics", { include_subgroups: true }, t);
    expect(mm.rows.find((r: Record<string, unknown>) => r.model_id === "ensemble").auroc).toBe(0.85);
  });

  it("describe_tables hides patient tables from the ministry", async () => {
    const o = await run("describe_tables", {}, ministry());
    const names = o.tables.map((x: { name: string }) => x.name);
    expect(names).toContain("mart_rates");
    expect(names.some((n: string) => n.startsWith("pt_") || n === "mart_case_points")).toBe(false);
    const d = await run("describe_tables", { tables: ["pt_patient"] }, doctor());
    expect(d.tables[0].columns).not.toContain("given_name");
  });

  it("query_marts returns rows + dataset_id, errors as data", async () => {
    const t = ministry();
    const o = await run("query_marts", { sql: "SELECT year, national_asr FROM mart_kpis ORDER BY year" }, t);
    expect(o.ok).toBe(true);
    expect(o.row_count).toBe(11);
    expect(o.sql_executed).toContain("LIMIT 1000");
    expect(t.datasets.get(o.dataset_id)?.sql).toContain("mart_kpis");
    const bad = await run("query_marts", { sql: "DROP TABLE mart_kpis" }, t);
    expect(bad).toMatchObject({ ok: false, error_kind: "unsafe" });
  });
});

describe("doctor tools", () => {
  it("list_high_risk_patients is facility-scoped and ordered by risk", async () => {
    const o = await run("list_high_risk_patients", {}, doctor(101));
    expect(o.rows.map((r: Record<string, unknown>) => r.display_id)).toEqual(["ES-0001-A", "ES-0002-B"]);
    expect(o.rows[0]).toMatchObject({ risk_band: "HIGH", risk_pct: 13.1, open_alerts: 2 });
    const other = await run("list_high_risk_patients", {}, doctor(102));
    expect(other.rows.map((r: Record<string, unknown>) => r.patient_id)).toEqual([4, 5]);
  });

  it("access check: another facility's patient is not found", async () => {
    const o = await run("get_patient", { patient_id: 4 }, doctor(101));
    expect(o).toEqual({ ok: false, error: "Patient not found at this facility" });
    const byDisplay = await run("get_patient", { display_id: "ES-0001-A" }, doctor(101));
    expect(byDisplay.ok).toBe(true);
    expect(byDisplay.patient.name).toBe("Alice Uwase"); // UI payload keeps the name...
    expect(JSON.stringify(modelSafe(by.get_patient, byDisplay, doctor(101)))).not.toMatch(NAMES); // ...the model never sees it
  });

  it("timeline with highlights and series; risk history; alerts", async () => {
    const t = doctor(101);
    const tl = await run("get_patient_timeline", { patient_id: 1, months: 24 }, t);
    expect(tl.ok).toBe(true);
    expect(tl.series.hb.map((p: { value: number }) => p.value)).toEqual([13.1, 12.4, 11.6, 10.7]);
    const hl = tl.events.filter((e: { highlight: boolean }) => e.highlight).map((e: { label: string; value_num: number }) => `${e.label}:${e.value_num}`);
    expect(hl).toEqual(expect.arrayContaining(["Haemoglobin:11.6", "Haemoglobin:10.7"]));
    const rk = await run("get_patient_risk", { patient_id: 1 }, t);
    expect(rk.rows).toHaveLength(2);
    expect(rk.current.top_reasons[0].feature).toBe("hb_drop_12m");
    const al = await run("list_alerts", {}, t);
    expect(al.total).toBe(4); // a-001..a-003 plus a-005 (a stale pre-diagnosis alert on the treated case)
    expect(al.by_severity).toEqual({ HIGH: 2, MEDIUM: 2 });
  });

  it("make_patient_widget builds a valid PatientWidget; model view has no names", async () => {
    const t = doctor(101);
    const w = await run("make_patient_widget", { display_id: "ES-0001-A" }, t);
    expect(PatientWidget.safeParse(w).success).toBe(true);
    expect(w).toMatchObject({ kind: "patient", patient_id: 1, name: "Alice Uwase", display_id: "ES-0001-A" });
    expect(w.risk.band).toBe("HIGH");
    expect(w.labs.find((l: { name: string }) => l.name === "Haemoglobin")).toMatchObject({ latest: 10.7, abnormal: true });
    expect(w.labs.find((l: { name: string }) => l.name === "H. pylori stool antigen")).toMatchObject({ latest: "Positive", coded: true });
    expect(w.suggested_actions[0]).toMatch(/^Consider upper GI endoscopy/);
    expect(w.suggested_actions.every((a: string) => a.startsWith("Consider"))).toBe(true);
    expect(w.timeline.events.length).toBeGreaterThan(5);
    const view = modelSafe(by.make_patient_widget, w, t);
    expect(JSON.stringify(view)).not.toMatch(NAMES);
    expect(JSON.stringify(view)).toContain("ES-0001-A");
  });

  it("doctor query_marts output never contains names", async () => {
    const o = await run("query_marts", { sql: "SELECT * FROM pt_patient p JOIN pt_risk r USING (patient_id)" }, doctor(101));
    expect(o.ok).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(NAMES);
  });
});

describe("make_chart", () => {
  it("builds a line spec from a dataset reference with filters", async () => {
    const t = ministry();
    const tr = await run("get_rates_trend", { age_band: "<50" }, t);
    const c = await run("make_chart", {
      type: "line", title: "Under-50 ASR", dataset_id: tr.dataset_id, x: "year",
      series: [{ key: "asr", lci: "asr_lci", uci: "asr_uci" }], filter: [{ key: "year", op: "gte", value: 2015 }],
    }, t);
    expect(ChartWidget.safeParse(c).success).toBe(true);
    expect(c.spec.type).toBe("line");
    expect(c.spec.data[0].year).toBe(2015);
    expect(c.spec.source.tool).toBe("get_rates_trend");
    expect(modelSafe(by.make_chart, c, t)).toMatchObject({ ok: true, type: "line", points: 11 });
  });

  it("kpi tiles read the last row; choropleth infers the level; forest validates keys", async () => {
    const t = ministry();
    const k = await run("get_kpis", {}, t);
    const kpi = await run("make_chart", { type: "kpi", title: "KPIs", dataset_id: k.dataset_id, filter: [{ key: "partial_year", op: "eq", value: false }], tiles: [{ label: "ASR", key: "national_asr", trend: true }] }, t);
    expect(kpi.spec.tiles[0].value).toBeCloseTo(7.42, 2);
    expect(kpi.spec.tiles[0].trend).toHaveLength(10);
    const r = await run("get_district_ranking", {}, t);
    const map = await run("make_chart", { type: "choropleth", title: "Map", dataset_id: r.dataset_id, value_key: "asr" }, t);
    expect(map.spec).toMatchObject({ level: "district", geoKey: "geo_code", labelKey: "name" });
    const bad = await run("make_chart", { type: "forest", title: "x", dataset_id: r.dataset_id, label_key: "name", estimate_key: "sir" }, t);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("lci_key");
    expect(bad.available_columns).toContain("sir");
  });

  it("inline data works (MCP clients) and is suppressed for the ministry", async () => {
    const c = await run("make_chart", { type: "bar", title: "x", data: [{ name: "A", cases: 3, asr: 1 }, { name: "B", cases: 30, asr: 2 }], x: "name", y: "asr" }, ministry());
    expect(c.spec.data[0]).toMatchObject({ cases: null, asr: null, cases_label: "<5" });
  });

  it("unknown dataset ids come back as an error the model can fix", async () => {
    const c = await run("make_chart", { type: "line", title: "x", dataset_id: "ds99", x: "year", y: "asr" }, ministry());
    expect(c.ok).toBe(false);
  });

  it("datasets are rebuilt from persisted tool parts", async () => {
    const t1 = ministry();
    const tr = await run("get_rates_trend", {}, t1);
    const t2 = ministry();
    t2.datasets.loadFromParts([{ type: "tool-get_rates_trend", state: "output-available", output: tr }]);
    const c = await run("make_chart", { type: "line", title: "x", dataset_id: tr.dataset_id, x: "year", y: "asr" }, t2);
    expect(c.kind).toBe("chart");
    expect(t2.datasets.register("x", [])).toBe("ds2");
  });
});
