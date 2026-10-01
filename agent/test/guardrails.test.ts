/**
 * Parity with api/llm/guardrails.py, nl2sql._scope_doctor and epi._suppress. Expected values for numbers_supported and
 * deidentify were produced by running the Python functions on the same inputs.
 */
import { describe, expect, it } from "vitest";
import { SERVE } from "../src/db/duck.js";
import { guardedQuery } from "../src/db/query.js";
import { numbersIn, numbersSupported, pyRound, unsupportedNumbers } from "../src/guardrails/numbers.js";
import { allowedTables, scopeDoctor, UnsafeSQL, validateSql } from "../src/guardrails/sql.js";
import { deidentify, pseudonymise, suppressObserved, suppressRow, suppressSmallCells } from "../src/guardrails/suppress.js";

const ALLOWED = new Set(["mart_rates", "mart_kpis", "ref_district", "ref_province"]);

describe("validateSql (port of validate_sql)", () => {
  // [sql, expected error substring] - same cases as tests/api/test_contract.py plus the B10 spike list
  const forbidden: [string, string][] = [
    ["SELECT * FROM read_parquet('x')", "function read_parquet is not allowed"],
    ["COPY mart_rates TO 'x.csv'", "file access is not allowed"], // Python: "only SELECT statements are allowed"
    ["ATTACH 'x' AS y", "only SELECT statements are allowed"],
    ["SELECT 1; DROP TABLE mart_rates", "only SELECT statements are allowed"], // Python: "exactly one statement" (parser order)
    ["PRAGMA database_list", "only SELECT statements are allowed"],
    ["INSTALL httpfs", "only SELECT statements are allowed"],
    ["SELECT given_name FROM pt_patient", "table pt_patient is not available to the ministry role"],
    ["SELECT * FROM main.mart_rates", "schema-qualified tables are not allowed"],
    ["SELECT getenv('HOME')", "function getenv is not allowed"],
    ["SELECT * FROM 'data.csv'", "file access is not allowed"],
    ["DELETE FROM mart_rates", "only SELECT statements are allowed"],
    ["SELECT * FROM glob('*')", "function glob is not allowed"],
    ["SELECT * FROM query_table('pt_patient')", "function query_table is not allowed"],
    ["SELECT * FROM read_csv('/etc/passwd')", "function read_csv is not allowed"],
    ["SELECT 1; SELECT 2", "exactly one statement is allowed"],
    ["SELECT * FROM range(10)", "table functions are not allowed"],
    ["SELECT * FROM mart_rates, (WITH pt_patient AS (SELECT 1) SELECT * FROM pt_patient) q, pt_patient", "table pt_patient is not available"],
    ["WITH a AS (SELECT * FROM pt_patient), pt_patient AS (SELECT 1) SELECT * FROM a", "table pt_patient is not available"],
    ["WITH pt_patient AS (SELECT * FROM pt_patient) SELECT * FROM pt_patient", "table pt_patient is not available"],
    ["SELECT (SELECT max(given_name) FROM pt_patient) FROM mart_rates", "table pt_patient is not available"],
    ["", "empty SQL"],
  ];
  it.each(forbidden)("blocks %s", async (sql, msg) => {
    const err = await validateSql(sql, "ministry", ALLOWED).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(UnsafeSQL);
    expect(String(err.message)).toContain(msg);
  });

  const allowed: [string, boolean][] = [
    ["SELECT geo_code, asr FROM mart_rates", true],
    ["WITH x AS (SELECT * FROM mart_rates) SELECT * FROM x", true],
    ["```sql\nSELECT asr FROM mart_rates;\n```", true],
    ["SELECT * FROM mart_rates LIMIT 10 OFFSET 5", false],
    ["WITH x AS (SELECT * FROM mart_rates) SELECT r.geo_code, x.asr FROM mart_rates r JOIN x USING (geo_code) LIMIT 5", false],
    ["SELECT 1 AS a UNION ALL SELECT 2", true],
    ["FROM mart_kpis SELECT year", true],
  ];
  it.each(allowed)("allows %s (limit added: %s)", async (sql, addsLimit) => {
    const v = await validateSql(sql, "ministry", ALLOWED, 1000);
    expect(v.sql.toUpperCase()).toContain("LIMIT");
    expect(v.limited).toBe(addsLimit);
  });

  it("reports the real tables read (CTE names excluded)", async () => {
    const v = await validateSql("WITH x AS (SELECT * FROM mart_rates) SELECT * FROM x JOIN ref_district d ON d.district_code = x.geo_code", "ministry", ALLOWED);
    expect(v.tables.sort()).toEqual(["mart_rates", "ref_district"]);
  });
});

describe("allowedTables (port of nl2sql.allowed_tables)", () => {
  const existing = ["mart_rates", "mart_kpis", "ml_eval_metrics", "ml_risk_history", "ml_landmarks", "mart_case_points", "pt_patient", "pt_risk",
    "pt_patient_facility", "core_dim_location", "ref_district", "ref_province", "mart_new_patient_level"];
  const cols = (t: string) => (t === "mart_new_patient_level" ? ["patient_id", "x"] : ["x"]);
  it("ministry: aggregate marts only", () => {
    const m = allowedTables("ministry", existing, cols);
    expect([...m].sort()).toEqual(["mart_kpis", "mart_rates", "ml_eval_metrics", "ref_district", "ref_province"]);
  });
  it("doctor: adds the facility-scoped patient tables", () => {
    const d = allowedTables("doctor", existing, cols);
    for (const t of ["pt_patient", "pt_risk", "pt_patient_facility", "ml_risk_history"]) expect(d.has(t)).toBe(true);
    expect(d.has("core_dim_location")).toBe(false);
    expect(d.has("ml_landmarks")).toBe(false);
  });
});

describe("doctor scoping (port of _scope_doctor)", () => {
  const doc = { role: "doctor" as const, facilityId: 101 };
  it("wraps SQL in facility-filtered CTEs", () => {
    const s = scopeDoctor("SELECT * FROM pt_risk", 101, new Set(["pt_patient", "pt_risk", "pt_patient_facility"]), (t) => (t === "pt_patient" ? ["patient_id", "given_name", "family_name"] : []));
    expect(s).toContain("pt_patient_facility AS (SELECT * FROM main.pt_patient_facility WHERE facility_id = 101)");
    expect(s).toContain('pt_patient AS (SELECT * EXCLUDE ("given_name", "family_name") FROM main.pt_patient');
    expect(s).toMatch(/SELECT \* FROM \(SELECT \* FROM pt_risk\) AS q$/);
  });
  it("restricts rows to the doctor's facility", async () => {
    const r = await guardedQuery(doc, "SELECT patient_id FROM pt_risk ORDER BY patient_id");
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.patient_id)).toEqual([1, 2]);
    const all = await SERVE().rows("SELECT patient_id FROM pt_risk");
    expect(all.length).toBe(4);
  });
  it("joins stay scoped (no other facility's patients through pt_patient_facility)", async () => {
    const r = await guardedQuery(doc, "SELECT DISTINCT f.facility_id FROM pt_patient_facility f");
    expect(r.rows.map((x) => x.facility_id)).toEqual([101]);
  });
  it("patient names cannot be selected by model SQL", async () => {
    const r = await guardedQuery(doc, "SELECT given_name, family_name FROM pt_patient");
    expect(r.ok).toBe(false);
    const ok = await guardedQuery(doc, "SELECT * FROM pt_patient");
    expect(ok.ok).toBe(true);
    expect(ok.columns).not.toContain("given_name");
    expect(JSON.stringify(ok.rows)).not.toMatch(/Alice|Uwase|Jean|Habimana/);
  });
  it("ministry cannot reach patient tables", async () => {
    const r = await guardedQuery({ role: "ministry", facilityId: null }, "SELECT given_name FROM pt_patient");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not available to the ministry role");
  });
  it("the serve connection itself refuses file access (defence in depth)", async () => {
    await expect(SERVE().rows("SELECT * FROM read_csv('/etc/passwd')")).rejects.toThrow(/disabled|Permission/i);
  });
});

describe("suppression (port of epi._suppress / _suppress_observed)", () => {
  it("nulls cases and rates of suppressed rows", () => {
    const r = suppressRow({ geo_code: "SOU-NYG", cases: 3, asr: 1.4, asr_lci: 0.3, asr_uci: 4.1, crude_rate: 1, suppressed: true });
    expect(r).toMatchObject({ cases: null, cases_label: "<5", asr: null, asr_lci: null, asr_uci: null, crude_rate: null });
    expect(suppressRow({ cases: 30, asr: 2, suppressed: false })).toEqual({ cases: 30, asr: 2, suppressed: false });
  });
  it("observed joinpoint points < 5 are suppressed", () => {
    expect(suppressObserved([{ year: 2014, cases: 3, asr: 1, lci: 0, uci: 2 }, { year: 2015, cases: 9, asr: 2 }])).toEqual([
      { year: 2014, cases: null, cases_label: "<5", asr: null, lci: null, uci: null },
      { year: 2015, cases: 9, asr: 2 },
    ]);
  });
  it("generic count columns < 5 are suppressed with their derived rates", () => {
    const [a, b] = suppressSmallCells([
      { stage_group: "I", n: 3, pct: 10, pct_known: 12 },
      { stage_group: "IV", n: 40, pct: 41, pct_known: 45 },
    ]);
    expect(a).toEqual({ stage_group: "I", n: null, n_label: "<5", pct: null, pct_known: null });
    expect(b).toEqual({ stage_group: "IV", n: 40, pct: 41, pct_known: 45 });
    // process denominators are not disease counts
    expect(suppressSmallCells([{ n_dyspepsia: 4, n_hp_tested: 1, hp_test_rate: 0.25 }])[0]).toEqual({ n_dyspepsia: 4, n_hp_tested: 1, hp_test_rate: 0.25 });
  });
  it("ministry query results come back suppressed", async () => {
    const r = await guardedQuery({ role: "ministry", facilityId: null }, "SELECT geo_code, cases, asr, suppressed FROM mart_rates WHERE geo_code = 'SOU-NYG' AND period = '2024'");
    expect(r.rows[0]).toMatchObject({ cases: null, cases_label: "<5", asr: null });
    expect(r.caveats.join(" ")).toContain("suppressed");
  });
});

describe("deidentify / pseudonymise", () => {
  it("matches Python deidentify", () => {
    const input = { name: "Musanze", given_name: "A", patient_id: 1, rows: [{ display_id: "X", asr: 1.2, phone: "1" }], n: 3 };
    expect(deidentify(input)).toEqual({ rows: [{ asr: 1.2 }], n: 3 }); // python output
    expect(deidentify(input, { keepName: true })).toEqual({ name: "Musanze", rows: [{ asr: 1.2 }], n: 3 });
  });
  it("doctor model view drops names but keeps display_id and facility names", () => {
    const v = pseudonymise({ patient: { patient_id: 1, display_id: "ES-1", name: "Alice Uwase", given_name: "Alice", birthdate: "1968-01-01", age: 58 }, facility: { name: "Musanze HC" } });
    expect(v).toEqual({ patient: { patient_id: 1, display_id: "ES-1", age: 58 }, facility: { name: "Musanze HC" } });
  });
});

describe("numbersSupported (port of numbers_supported)", () => {
  // [answer, allowed, python result]
  const cases: [string, number[], boolean][] = [
    ["The ASR rose from 5.4 in 2015 to 7.2 in 2024.", [5.43, 7.18], true],
    ["The ASR was 12.3 per 100,000.", [12.25], false],
    ["There were 1,234 cases.", [1234], true],
    ["There were 1,250 cases.", [1234], false],
    ["Survival was 45% at one year.", [0.452], true],
    ["Survival was 47% at one year.", [0.452], false],
    ["Top 5 districts in 2023-2025.", [], true],
    ["A rate of 123.6 was seen", [123.4], true],
    ["A rate of 124.4 was seen", [123.4], false],
    ["A rate of 124.6 was seen", [123.4], false],
    ["APC was -3.2% per year", [-3.21], true],
    ["APC was -3.4% per year", [-3.21], true],
    ["Median 199 days", [199], true],
    ["Median 42 days", [41.5], true],
    ["Median 43 days", [41.5], false],
    ["value 0.5 and 31", [], true],
    ["value 32", [], false],
    ["Rate 1990 and 2036", [], false],
    ["Probability 31.8%", [0.3182], true],
    ["Probability 31.8%", [0.318181812763], true],
    ["12,5 cases", [125], true],
    ["version 1.2.3 here", [], true],
    ["Between 20.5 and 21.5", [21], true],
    ["x 40.5", [40], true],
    ["x 41.5", [41], true],
    ["x 42.5", [42], true],
  ];
  it.each(cases)("%s %j -> %s", (text, pool, expected) => {
    expect(numbersSupported(text, pool)).toBe(expected);
  });
  it("numbersIn matches Python numbers_in", () => {
    expect(numbersIn("Top 5 districts in 2023-2025.")).toEqual([5, 2023, 2025]);
    expect(numbersIn("The ASR was 12.4 per 100,000.")).toEqual([12.4, 100000]);
    expect(numbersIn("version 1.2.3 here")).toEqual([]);
  });
  it("python round() semantics", () => {
    expect([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(2.6)]).toEqual([0, 2, 2, 3]);
  });
  it("agent extension: typographic minus and the '95% CI' label", () => {
    expect(unsupportedNumbers("APC +6.3% (95% CI −8.9% to +24.0%), change −39%", [6.25, -8.93, 23.95, -39.07])).toEqual([]);
  });
});

describe("collectNumbers (agent pool)", () => {
  it("adds magnitudes of negative values and numbers inside strings", async () => {
    const { collectNumbers } = await import("../src/guardrails/numbers.js");
    const pool = collectNumbers({ change_pct: -39.07, summary: "probability 13.1%", rows: [{ asr: 5.35 }] });
    expect(pool).toEqual(expect.arrayContaining([-39.07, 39.07, 13.1, 5.35]));
    expect(numbersSupported("The rate fell 39% to 5.4.", pool)).toBe(true);
  });
});
