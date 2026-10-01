/**
 * Builds a tiny serve DuckDB with the same table/column names as a published serve_<colour>.duckdb
 * (pipeline/publish.py) so unit tests run without the real dataset. Synthetic, deterministic values.
 *
 *   pnpm test:fixture            -> agent/data/fixtures/serve_fixture.duckdb (+ .meta.json)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, "../../data/fixtures");
export const FIXTURE_DB = path.join(FIXTURE_DIR, "serve_fixture.duckdb");
export const FIXTURE_META = { active: "fixture", run_id: 7, sim_time: "2026-06-30T23:59:59", published_at: "2026-07-01T00:00:00Z" };

const q = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
};

function values(rows: unknown[][]): string {
  return rows.map((r) => `(${r.map(q).join(", ")})`).join(",\n");
}

export async function buildFixture(file = FIXTURE_DB): Promise<string> {
  mkdirSync(path.dirname(file), { recursive: true });
  for (const f of [file, `${file}.wal`]) if (existsSync(f)) rmSync(f);
  const inst = await DuckDBInstance.create(file);
  const con = await inst.connect();
  const run = (sql: string) => con.run(sql);

  // ------------------------------------------------------------------ reference
  await run(`CREATE TABLE ref_province (province_code VARCHAR, name VARCHAR)`);
  await run(`INSERT INTO ref_province VALUES ('KGL','Kigali City'),('NOR','Northern Province'),('SOU','Southern Province'),('EAS','Eastern Province'),('WES','Western Province')`);
  await run(`CREATE TABLE ref_district (district_code VARCHAR, name VARCHAR, province_code VARCHAR, province VARCHAR)`);
  await run(`INSERT INTO ref_district VALUES ('NOR-MUS','Musanze','NOR','Northern Province'),('SOU-NYG','Nyaruguru','SOU','Southern Province'),('WES-RUS','Rusizi','WES','Western Province')`);
  await run(`CREATE TABLE core_dim_location (location_id INTEGER, name VARCHAR, facility_type VARCHAR, district_code VARCHAR, parent_location INTEGER, hp_testing_tier VARCHAR)`);
  await run(`INSERT INTO core_dim_location VALUES (101,'Musanze Health Centre','HC','NOR-MUS',201,'B'),(102,'Rusizi Health Centre','HC','WES-RUS',202,'A'),(201,'Ruhengeri District Hospital','DH','NOR-MUS',NULL,'A'),(202,'Gihundwe District Hospital','DH','WES-RUS',NULL,'A')`);

  // ------------------------------------------------------------------ rates
  await run(`CREATE TABLE mart_rates (level VARCHAR, geo_code VARCHAR, period VARCHAR, period_type VARCHAR, sex VARCHAR, age_band VARCHAR,
             case_def VARCHAR, cases INTEGER, population DOUBLE, crude_rate DOUBLE, asr DOUBLE, asr_lci DOUBLE, asr_uci DOUBLE,
             suppressed BOOLEAN, coverage_flag VARCHAR, partial_year BOOLEAN)`);
  const rates: unknown[][] = [];
  for (let y = 2014; y <= 2026; y++) {
    const partial = y === 2026;
    const all = 6.1 + 0.12 * (y - 2014);
    const u50 = 1.2 + 0.09 * (y - 2014);
    const casesAll = Math.round(380 + 14 * (y - 2014));
    const casesU50 = Math.round(70 + 6 * (y - 2014));
    const cov = y < 2016 ? "LOW_EMR_COVERAGE" : null;
    rates.push(["NATIONAL", "RW", String(y), "YEAR", "ALL", "ALL", "CONFIRMED_PROBABLE", casesAll, 1.3e7, all - 0.4, +all.toFixed(2), +(all - 0.5).toFixed(2), +(all + 0.5).toFixed(2), false, cov, partial]);
    rates.push(["NATIONAL", "RW", String(y), "YEAR", "ALL", "<50", "CONFIRMED_PROBABLE", casesU50, 1.0e7, u50 - 0.2, +u50.toFixed(2), +(u50 - 0.3).toFixed(2), +(u50 + 0.3).toFixed(2), false, cov, partial]);
    rates.push(["NATIONAL", "RW", String(y), "YEAR", "M", "ALL", "CONFIRMED_PROBABLE", Math.round(casesAll * 0.55), 6.4e6, all, +(all * 1.15).toFixed(2), null, null, false, cov, partial]);
    rates.push(["NATIONAL", "RW", String(y), "YEAR", "F", "ALL", "CONFIRMED_PROBABLE", Math.round(casesAll * 0.45), 6.6e6, all, +(all * 0.86).toFixed(2), null, null, false, cov, partial]);
    rates.push(["PROVINCE", "WES", String(y), "YEAR", "ALL", "ALL", "CONFIRMED", 60 + y - 2014, 2.9e6, 2.1, 2.4, 1.8, 3.0, false, null, partial]);
    rates.push(["DISTRICT", "WES-RUS", String(y), "YEAR", "ALL", "ALL", "CONFIRMED_PROBABLE", 20 + (y - 2014), 4.0e5, 5.0, 7.0 + 0.1 * (y - 2014), 5.5, 8.5, false, null, partial]);
    rates.push(["DISTRICT", "SOU-NYG", String(y), "YEAR", "ALL", "ALL", "CONFIRMED_PROBABLE", 3, 3.0e5, 1.0, 1.4, 0.3, 4.1, true, null, partial]);
  }
  for (const [code, cases, asr, sup] of [["NOR-MUS", 120, 9.4, false], ["WES-RUS", 95, 8.8, false], ["SOU-NYG", 4, 1.1, true]] as const) {
    rates.push(["DISTRICT", code, "2023-2025", "POOLED3", "ALL", "ALL", "CONFIRMED_PROBABLE", cases, 1.2e6, asr - 1, asr, asr - 1.2, asr + 1.2, sup, null, false]);
    rates.push(["DISTRICT", code, "2019-2025", "POOLED_ALL", "ALL", "ALL", "CONFIRMED_PROBABLE", cases * 2, 2.8e6, asr - 1, asr, asr - 0.9, asr + 0.9, false, null, false]);
  }
  await run(`INSERT INTO mart_rates VALUES ${values(rates)}`);

  const observed = [] as Record<string, unknown>[];
  for (let y = 2014; y <= 2025; y++) observed.push({ year: y, asr: +(1.2 + 0.09 * (y - 2014)).toFixed(2), lci: null, uci: null, cases: y === 2014 ? 3 : 70 + 6 * (y - 2014) });
  await run(`CREATE TABLE mart_joinpoint (series_id VARCHAR, level VARCHAR, geo_code VARCHAR, sex VARCHAR, age_band VARCHAR, case_def VARCHAR,
             segment_no INTEGER, start_year INTEGER, end_year INTEGER, apc DOUBLE, apc_lci DOUBLE, apc_uci DOUBLE, significant BOOLEAN,
             aapc_last10 DOUBLE, aapc_lci DOUBLE, aapc_uci DOUBLE, n_joinpoints INTEGER, fitted_json VARCHAR, observed_json VARCHAR, events_json VARCHAR)`);
  const fitted = JSON.stringify(observed.map((o) => ({ year: o.year, asr: o.asr })));
  await run(`INSERT INTO mart_joinpoint VALUES ${values([
    ["NATIONAL|ALL|<50|CONFIRMED_PROBABLE", "NATIONAL", "RW", "ALL", "<50", "CONFIRMED_PROBABLE", 1, 2014, 2019, 2.1, -0.5, 4.8, false, 5.9, 4.1, 7.8, 1, fitted, JSON.stringify(observed), JSON.stringify([{ date: "2021-03-01", label: "Screening pilot", geo_code: "RW" }])],
    ["NATIONAL|ALL|<50|CONFIRMED_PROBABLE", "NATIONAL", "RW", "ALL", "<50", "CONFIRMED_PROBABLE", 2, 2019, 2025, 7.4, 5.2, 9.7, true, 5.9, 4.1, 7.8, 1, fitted, JSON.stringify(observed), "[]"],
    ["NATIONAL|ALL|ALL|CONFIRMED_PROBABLE", "NATIONAL", "RW", "ALL", "ALL", "CONFIRMED_PROBABLE", 1, 2014, 2025, 1.8, 1.1, 2.6, true, 1.8, 1.1, 2.6, 0, "[]", "[]", "[]"],
  ])}`);

  await run(`CREATE TABLE mart_spatial (district_code VARCHAR, period VARCHAR, asr DOUBLE, crude_rate DOUBLE, cases INTEGER, eb_smoothed_rate DOUBLE,
             eb_sir DOUBLE, expected DOUBLE, sir DOUBLE, sir_lci DOUBLE, sir_uci DOUBLE, lisa_quadrant VARCHAR, lisa_quadrant_fdr VARCHAR,
             lisa_p DOUBLE, lisa_q_fdr DOUBLE, gi_star_z DOUBLE, global_morans_i DOUBLE, global_p DOUBLE)`);
  await run(`INSERT INTO mart_spatial VALUES ${values([
    ["NOR-MUS", "2019-2025", 9.4, 8.1, 240, 9.1, 1.4, 171, 1.4, 1.2, 1.6, "HH", "HH", 0.01, 0.04, 2.8, 0.31, 0.002],
    ["WES-RUS", "2019-2025", 8.8, 7.9, 190, 8.6, 1.3, 146, 1.3, 1.1, 1.5, "HH", "NS", 0.03, 0.09, 2.1, 0.31, 0.002],
    ["SOU-NYG", "2019-2025", 1.1, 1.0, 8, 2.0, 0.4, 20, 0.4, 0.2, 0.8, "LL", "NS", 0.2, 0.4, -1.2, 0.31, 0.002],
    ["RW", "2019-2025", null, null, 438, null, 1.0, null, 1.0, null, null, null, null, null, null, null, 0.31, 0.002],
  ])}`);

  // ------------------------------------------------------------------ clinical marts
  await run(`CREATE TABLE mart_stage_mix (level VARCHAR, geo_code VARCHAR, year VARCHAR, facility_tier VARCHAR, stage_group VARCHAR, n INTEGER, pct DOUBLE, pct_known DOUBLE)`);
  const sm: unknown[][] = [];
  for (const [yr, base] of [["ALL", 400], ["2024", 60], ["2025", 64]] as const) {
    for (const [st, share] of [["I", 0.08], ["II", 0.14], ["III", 0.3], ["IV", 0.38], ["Unknown", 0.1]] as const) {
      sm.push(["NATIONAL", "RW", yr, "ALL", st, Math.round(base * share), 100 * share, st === "Unknown" ? null : (100 * share) / 0.9]);
    }
  }
  for (const [tier, iv] of [["HC", 0.45], ["DH", 0.38], ["RH", 0.3]] as const) {
    for (const st of ["I", "II", "III", "IV"]) sm.push(["NATIONAL", "RW", "ALL", tier, st, st === "IV" ? Math.round(100 * iv) : 20, st === "IV" ? 100 * iv : 15, st === "IV" ? 100 * iv : 18]);
  }
  sm.push(["PROVINCE", "WES", "ALL", "ALL", "IV", 40, 41.0, 45.0], ["PROVINCE", "NOR", "ALL", "ALL", "IV", 35, 33.0, 36.0]);
  sm.push(["DISTRICT", "NOR-MUS", "ALL", "ALL", "IV", 30, 40, 44], ["DISTRICT", "NOR-MUS", "ALL", "ALL", "III", 20, 25, 28]);
  await run(`INSERT INTO mart_stage_mix VALUES ${values(sm)}`);
  await run(`CREATE TABLE mart_stage_tier_test (chi2 DOUBLE, dof INTEGER, p DOUBLE)`);
  await run(`INSERT INTO mart_stage_tier_test VALUES (14.2, 6, 0.027)`);

  await run(`CREATE TABLE mart_facility_quality (location_id INTEGER, name VARCHAR, district_code VARCHAR, province_code VARCHAR, facility_type VARCHAR,
             tier VARCHAR, derived_tier VARCHAR, lat DOUBLE, lon DOUBLE, n_dyspepsia INTEGER, n_hp_tested INTEGER, hp_test_rate DOUBLE,
             funnel_lower95 DOUBLE, funnel_upper95 DOUBLE, funnel_lower998 DOUBLE, funnel_upper998 DOUBLE, outlier_flag VARCHAR,
             target_rate DOUBLE, n_cases INTEGER, pct_stage4 DOUBLE, median_diag_interval DOUBLE)`);
  await run(`INSERT INTO mart_facility_quality VALUES ${values([
    [101, "Musanze Health Centre", "NOR-MUS", "NOR", "HC", "B", "B", -1.5, 29.6, 420, 21, 0.05, 0.08, 0.2, 0.06, 0.22, "LOW", 0.3, 12, 41.7, 160],
    [102, "Rusizi Health Centre", "WES-RUS", "WES", "HC", "A", "A", -2.4, 28.9, 300, 150, 0.5, 0.25, 0.4, 0.2, 0.45, "HIGH", 0.3, 9, 33.3, 120],
    [201, "Ruhengeri District Hospital", "NOR-MUS", "NOR", "DH", "A", "A", -1.49, 29.63, 4, 1, 0.25, 0.0, 0.9, 0.0, 1.0, null, 0.3, 3, 66.7, 90],
  ])}`);

  await run(`CREATE TABLE mart_survival_summary (group_var VARCHAR, group_value VARCHAR, n INTEGER, surv_1y DOUBLE, surv_2y DOUBLE, median_surv_days DOUBLE)`);
  await run(`INSERT INTO mart_survival_summary VALUES ${values([
    ["stage", "I", 30, 0.86, 0.74, null], ["stage", "II", 55, 0.71, 0.55, 900], ["stage", "III", 120, 0.44, 0.27, 320], ["stage", "IV", 160, 0.18, 0.06, 140],
    ["sex", "M", 210, 0.39, 0.25, 290], ["sex", "F", 170, 0.42, 0.28, 310],
  ])}`);
  await run(`CREATE TABLE mart_survival_km (group_var VARCHAR, group_value VARCHAR, t_days INTEGER, surv DOUBLE, lci DOUBLE, uci DOUBLE, n_risk INTEGER)`);
  await run(`INSERT INTO mart_survival_km VALUES ('stage','I',0,1,1,1,30),('stage','I',365,0.86,0.7,0.94,24),('stage','IV',0,1,1,1,160),('stage','IV',365,0.18,0.12,0.25,25)`);
  await run(`CREATE TABLE mart_cox (model_id VARCHAR, term VARCHAR, hr DOUBLE, lci DOUBLE, uci DOUBLE, p DOUBLE)`);
  await run(`INSERT INTO mart_cox VALUES ('m1','stage_IV',6.2,4.1,9.4,0.0001),('m1','age_65plus',1.4,1.1,1.8,0.01),('m1','sex_F',0.92,0.75,1.12,0.4)`);
  await run(`CREATE TABLE mart_diag_interval (group_var VARCHAR, "group" VARCHAR, median_days DOUBLE, q1 DOUBLE, q3 DOUBLE, n INTEGER)`);
  await run(`INSERT INTO mart_diag_interval VALUES ('province','NOR',150,80,260,90),('province','WES',190,100,300,80),('tier','HC',210,120,330,140)`);
  await run(`CREATE TABLE mart_warning_summary (metric VARCHAR, "case" DOUBLE, control DOUBLE)`);
  await run(`INSERT INTO mart_warning_summary VALUES ('pct_ge3_gi_visits_24m', 61.2, 18.4), ('pct_anaemia_12m', 44.0, 12.1)`);
  await run(`CREATE TABLE mart_characteristics (variable VARCHAR, level VARCHAR, "group" VARCHAR, n INTEGER, pct DOUBLE, median DOUBLE)`);
  await run(`INSERT INTO mart_characteristics VALUES ('lauren','Diffuse','<50',40,52.6,NULL),('lauren','Diffuse','>=50',90,29.0,NULL),('lauren','Diffuse','all',130,33.9,NULL)`);
  await run(`CREATE TABLE mart_kpis (year INTEGER, cases INTEGER, cases_annualised DOUBLE, cases_delta_pct DOUBLE, national_asr DOUBLE, national_asr_lci DOUBLE,
             national_asr_uci DOUBLE, asr_delta DOUBLE, pct_stage_iv DOUBLE, median_diag_interval_days DOUBLE, young_onset_share DOUBLE,
             hp_testing_rate_dyspepsia DOUBLE, partial_year BOOLEAN, high_risk_awaiting_endoscopy INTEGER)`);
  const kpis: unknown[][] = [];
  for (let y = 2016; y <= 2026; y++) {
    const asr = +(6.1 + 0.12 * (y - 2014)).toFixed(2);
    const cases = 380 + 14 * (y - 2014);
    kpis.push([y, y === 2026 ? Math.round(cases / 2) : cases, cases, 3.1, asr, +(asr - 0.5).toFixed(2), +(asr + 0.5).toFixed(2), 0.12, 38.5 - 0.3 * (y - 2016), 160 - 2 * (y - 2016), 0.18 + 0.004 * (y - 2016), 0.12 + 0.01 * (y - 2016), y === 2026, 17]);
  }
  await run(`INSERT INTO mart_kpis VALUES ${values(kpis)}`);
  await run(`CREATE TABLE mart_cohort_funnel (pathway VARCHAR, stage VARCHAR, year VARCHAR, province VARCHAR, n INTEGER, pct_of_prev DOUBLE)`);
  await run(`INSERT INTO mart_cohort_funnel VALUES ${values([
    ["endoscopy", "gi_flagged", "ALL", "ALL", 12000, null], ["endoscopy", "referred", "ALL", "ALL", 2400, 20], ["endoscopy", "scoped", "ALL", "ALL", 1500, 62.5],
    ["endoscopy", "biopsied", "ALL", "ALL", 600, 40], ["endoscopy", "diagnosed", "ALL", "ALL", 410, 68.3],
    ["hp", "gi_flagged", "ALL", "ALL", 12000, null], ["hp", "hp_tested", "ALL", "ALL", 3000, 25], ["hp", "hp_positive", "ALL", "ALL", 1300, 43.3], ["hp", "eradicated", "ALL", "ALL", 700, 53.8],
    ["endoscopy", "gi_flagged", "ALL", "WES", 2000, null], ["endoscopy", "diagnosed", "ALL", "WES", 3, 0.15],
  ])}`);
  await run(`CREATE TABLE mart_case_points (lat DOUBLE, lon DOUBLE, year INTEGER, age_band VARCHAR, sex VARCHAR, stage_group VARCHAR)`);
  await run(`INSERT INTO mart_case_points VALUES (-1.5, 29.6, 2024, '<50', 'F', 'IV')`);

  // ------------------------------------------------------------------ models
  await run(`CREATE TABLE ml_eval_metrics (model_id VARCHAR, tier INTEGER, split VARCHAR, auroc DOUBLE, auprc DOUBLE, brier DOUBLE, median_lead_time_days DOUBLE)`);
  await run(`INSERT INTO ml_eval_metrics VALUES ('t1_points',1,'test',0.71,0.05,0.02,120),('t2_xgb',2,'test',0.83,0.11,0.018,150),('t3_seq',3,'test',0.81,0.1,0.019,160),('ensemble',0,'test',0.85,0.13,0.017,155),('t2_xgb',2,'val',0.84,0.12,0.018,150)`);
  await run(`CREATE TABLE ml_subgroup_metrics (model_id VARCHAR, subgroup_var VARCHAR, subgroup_value VARCHAR, n INTEGER, auroc DOUBLE)`);
  await run(`INSERT INTO ml_subgroup_metrics VALUES ('ensemble','sex','F',5000,0.84),('ensemble','sex','M',5200,0.86),('ensemble','age_band','<50',3000,0.79)`);
  await run(`CREATE TABLE ml_model_registry (model_id VARCHAR, tier INTEGER, is_active BOOLEAN, path VARCHAR, params_json VARCHAR)`);
  await run(`INSERT INTO ml_model_registry VALUES ('t2_xgb',2,TRUE,'x','{}')`);
  await run(`CREATE TABLE ml_thresholds (high_cut DOUBLE, medium_cut DOUBLE)`);
  await run(`INSERT INTO ml_thresholds VALUES (0.08, 0.03)`);

  // ------------------------------------------------------------------ patients (synthetic names)
  await run(`CREATE TABLE pt_patient (patient_id INTEGER, display_id VARCHAR, given_name VARCHAR, family_name VARCHAR, sex VARCHAR, age INTEGER,
             birthdate DATE, district_code VARCHAR, province_code VARCHAR, home_facility_id INTEGER, entry_date DATE, entry_reason VARCHAR,
             entry_facility_id INTEGER, is_case BOOLEAN, case_status VARCHAR, dx_date DATE, dead BOOLEAN, death_date DATE, last_encounter_date DATE)`);
  await run(`INSERT INTO pt_patient VALUES ${values([
    [1, "ES-0001-A", "Alice", "Uwase", "F", 58, "1968-02-11", "NOR-MUS", "NOR", 101, "2023-01-10", "DYSPEPSIA", 101, false, null, null, false, null, "2026-06-01"],
    [2, "ES-0002-B", "Jean", "Habimana", "M", 63, "1963-05-02", "NOR-MUS", "NOR", 101, "2022-03-15", "EPIGASTRIC_PAIN", 101, false, null, null, false, null, "2026-05-20"],
    [3, "ES-0003-C", "Grace", "Mukamana", "F", 47, "1979-09-30", "NOR-MUS", "NOR", 101, "2021-07-01", "DYSPEPSIA", 101, true, "CONFIRMED", "2025-11-03", false, null, "2026-06-10"],
    [4, "ES-0004-D", "Eric", "Niyonzima", "M", 52, "1974-01-20", "WES-RUS", "WES", 102, "2022-09-09", "DYSPEPSIA", 102, false, null, null, false, null, "2026-04-02"],
    [5, "ES-0005-E", "Claudine", "Ingabire", "F", 69, "1957-12-12", "WES-RUS", "WES", 102, "2020-02-02", "ANAEMIA", 102, false, null, null, false, null, "2026-03-03"],
    [6, "ES-0006-F", "Patrick", "Mugisha", "M", 71, "1955-04-04", "WES-RUS", "WES", 102, "2019-05-05", "DYSPEPSIA", 102, true, "CONFIRMED", "2024-08-08", true, "2025-09-01", "2025-08-20"],
  ])}`);
  await run(`CREATE TABLE pt_patient_facility (patient_id INTEGER, facility_id INTEGER)`);
  await run(`INSERT INTO pt_patient_facility VALUES (1,101),(2,101),(3,101),(1,201),(2,201),(3,201),(4,102),(5,102),(6,102),(4,202),(5,202),(6,202)`);
  const reasons = (hb: boolean) => JSON.stringify([
    { feature: hb ? "hb_drop_12m" : "sx_dysphagia", label: hb ? "Haemoglobin fell 2.4 g/dL in 12 months" : "Dysphagia recorded", contribution: 0.41, value: hb ? 2.4 : 1 },
    { feature: "age", label: "Age 58", contribution: 0.22, value: 58 },
    { feature: "n_gi_visits_24m", label: "4 GI visits in 24 months", contribution: 0.15, value: 4 },
  ]);
  await run(`CREATE TABLE pt_risk (patient_id INTEGER, as_of TIMESTAMP, t1_score INTEGER, t1_band VARCHAR, t2_prob DOUBLE, t3_prob DOUBLE, ensemble_prob DOUBLE,
             risk_band VARCHAR, top_reasons VARCHAR, t3_attention VARCHAR, facility_id INTEGER, rank_in_facility BIGINT, scoped_since_flag BOOLEAN, first_high_at TIMESTAMP)`);
  await run(`INSERT INTO pt_risk VALUES ${values([
    [1, "2026-06-30 23:59:59", 9, "HIGH", 0.14, 0.12, 0.131, "HIGH", reasons(true), JSON.stringify([{ token: "L:3100", days_before: 40, attribution: 0.2 }]), 101, 1, false, "2026-03-31 23:59:59"],
    [2, "2026-06-30 23:59:59", 5, "MEDIUM", 0.05, 0.04, 0.046, "MEDIUM", reasons(false), "[]", 101, 2, false, null],
    [4, "2026-06-30 23:59:59", 8, "HIGH", 0.1, 0.09, 0.095, "HIGH", reasons(false), "[]", 102, 1, true, "2026-01-31 23:59:59"],
    [5, "2026-06-30 23:59:59", 2, "LOW", 0.01, 0.01, 0.01, "LOW", "[]", "[]", 102, 2, false, null],
  ])}`);
  await run(`CREATE TABLE ml_risk_history (patient_id INTEGER, as_of TIMESTAMP, t1_score INTEGER, t2_prob DOUBLE, t3_prob DOUBLE, ensemble_prob DOUBLE, risk_band VARCHAR)`);
  await run(`INSERT INTO ml_risk_history VALUES (1,'2026-03-31 23:59:59',8,0.1,0.09,0.095,'HIGH'),(1,'2026-06-30 23:59:59',9,0.14,0.12,0.131,'HIGH'),(4,'2026-06-30 23:59:59',8,0.1,0.09,0.095,'HIGH')`);
  await run(`CREATE TABLE pt_alerts (alert_id VARCHAR, patient_id INTEGER, facility_id INTEGER, created_at TIMESTAMP, "trigger" VARCHAR, severity VARCHAR,
             status VARCHAR, summary VARCHAR, reasons VARCHAR, suggested_action VARCHAR)`);
  await run(`INSERT INTO pt_alerts VALUES ${values([
    ["a-001", 1, 101, "2026-06-30 23:59:59", "RISK_BAND_HIGH", "HIGH", "NEW", "Gastric cancer risk in the top 2% of the GI cohort (12-month probability 13.1%).", reasons(true), "Consider upper GI endoscopy referral"],
    ["a-002", 1, 101, "2026-06-15 23:59:59", "HB_DROP", "MEDIUM", "NEW", "Haemoglobin fell 2.4 g/dL in 12 months with no GI work-up.", reasons(true), "Investigate falling haemoglobin: FBC, iron studies, consider GI work-up"],
    ["a-003", 2, 101, "2026-05-01 23:59:59", "HP_POS_UNTREATED", "MEDIUM", "NEW", "H. pylori positive more than 30 days ago, no eradication therapy recorded.", "[]", "Start H. pylori eradication therapy per national guideline"],
    ["a-004", 4, 102, "2026-06-30 23:59:59", "RISK_BAND_HIGH", "HIGH", "NEW", "Gastric cancer risk in the top 2% of the GI cohort (12-month probability 9.5%).", reasons(false), "Consider upper GI endoscopy referral"],
  ])}`);
  await run(`CREATE TABLE pt_timeline (patient_id INTEGER, ts TIMESTAMP, event_type VARCHAR, concept_id INTEGER, label VARCHAR, value_num DOUBLE, value_text VARCHAR,
             unit VARCHAR, facility_id INTEGER, is_abnormal BOOLEAN, encounter_id INTEGER, organ_ids VARCHAR[], organ_weight DOUBLE, region VARCHAR)`);
  const tl: unknown[][] = [];
  const hb = [13.1, 12.4, 11.6, 10.7];
  ["2025-07-01", "2025-10-01", "2026-01-15", "2026-05-20"].forEach((d, i) => {
    tl.push([1, `${d} 09:00:00`, "VISIT", 2, "OPD consultation", null, null, null, 101, false, 10 + i, null, null, null]);
    tl.push([1, `${d} 10:00:00`, "LAB", 3100, "Haemoglobin", hb[i], null, "g/dL", 101, hb[i] < 12, 10 + i, null, null, null]);
    tl.push([1, `${d} 09:30:00`, "VITAL", 3000, "Weight", 64 - i * 1.5, null, "kg", 101, false, 10 + i, null, null, null]);
  });
  tl.push([1, "2026-01-15 09:20:00", "SYMPTOM", 2203, "Dysphagia", 6, null, "weeks", 101, true, 12, null, null, null]);
  tl.push([1, "2026-05-20 10:30:00", "LAB", 3120, "H. pylori stool antigen", null, "Positive", null, 101, true, 13, null, null, null]);
  tl.push([1, "2024-01-10 09:00:00", "VISIT", 2, "OPD consultation", null, null, null, 101, false, 5, null, null, null]);
  tl.push([2, "2026-04-01 09:00:00", "VISIT", 2, "OPD consultation", null, null, null, 101, false, 20, null, null, null]);
  tl.push([4, "2026-04-02 09:00:00", "LAB", 3100, "Haemoglobin", 11.0, null, "g/dL", 102, true, 30, null, null, null]);
  await run(`INSERT INTO pt_timeline VALUES ${values(tl).replace(/'(\{[^']*\})'/g, "$1")}`);
  await run(`CREATE TABLE pt_tumour (patient_id INTEGER, case_status VARCHAR, dx_date DATE, stage_group VARCHAR, lauren VARCHAR, lesion_location VARCHAR,
             lesion_size_mm DOUBLE, t_stage VARCHAR, n_stage VARCHAR, m_stage VARCHAR, grade VARCHAR, treatment_intent VARCHAR)`);
  await run(`INSERT INTO pt_tumour VALUES (3,'CONFIRMED','2025-11-03','III','Diffuse','antrum',32,'T3','N1','M0','Poor','Curative'),(6,'CONFIRMED','2024-08-08','IV','Intestinal','body',45,'T4a','N2','M1','Moderate','Palliative')`);
  await run(`CREATE TABLE serve_meta AS SELECT 7 AS run_id, TIMESTAMP '2026-06-30 23:59:59' AS sim_time, now() AS published_at, '[]' AS changed`);
  con.closeSync();
  inst.closeSync();
  writeFileSync(`${file}.meta.json`, JSON.stringify(FIXTURE_META));
  return file;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildFixture().then((f) => console.log(`fixture written: ${f}`));
}
