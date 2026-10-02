/**
 * SQL guardrails: 1:1 port of api/llm/guardrails.py `validate_sql` + api/llm/nl2sql.py `allowed_tables` / `_scope_doctor`.
 *
 * Instead of sqlglot, the statement is parsed by DuckDB itself (`json_serialize_sql`), so the check sees exactly what the
 * engine would run. Rules (SPEC §15.1): exactly one read-only SELECT, no table functions, no file/`read_*`/forbidden
 * functions, no schema-qualified tables, only allow-listed tables (CTE names exempt, scope-aware), LIMIT added when absent.
 * The Python regex nets (file literals, `read_` calls, code fences) are kept as a second layer.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export const FORBIDDEN_FUNCS = new Set([
  "read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto", "read_text", "read_blob", "glob", "sniff_csv",
  "query", "query_table", "getenv", "parquet_scan", "csv_scan",
  // additions over the Python list (all harmless to block in analytics SQL)
  "read_json_objects", "read_ndjson", "read_ndjson_auto", "read_ndjson_objects", "parquet_metadata", "parquet_schema",
  "json_execute_serialized_sql", "getvariable", "current_setting", "duckdb_secrets", "which_secret",
]);

/** Patient-level tables a doctor may query; every one is shadowed by a facility-scoped CTE before execution. */
export const DOCTOR_TABLES = [
  "pt_patient", "pt_patient_facility", "pt_risk", "pt_alerts", "pt_timeline", "pt_tumour", "pt_features", "ml_risk_history",
  // v3 care coordination and recovery journey (snapshots of data/analytics/care.sqlite + journey marts)
  "pt_care_plan", "pt_care_task", "pt_journey", "pt_recovery", "pt_treatment",
  "care_plans", "care_tasks", "care_events", "care_notifications", "care_patient_reports", "care_recommendation_outcomes",
] as const;

/** Synthetic external aggregates (registry, surveys, population projections; plan §5a): both roles may query them. */
export const EXTERNAL_TABLES = ["ext_registry", "ext_surveys", "ext_population"] as const;

/**
 * Point- or patient-level tables kept away from model-written SQL even though they are mart_/ml_ prefixed (case
 * coordinates, journey samples, training landmarks/features, per-patient risk history). Any mart_/ml_ table with a
 * patient key column is excluded too (checked against information_schema), so new patient-level marts fail closed.
 */
export const PATIENT_LEVEL_TABLES = new Set([
  "ml_risk_history", "ml_landmarks", "ml_train_features", "mart_case_points", "mart_cohort_points", "mart_journey_events",
]);
export const PATIENT_KEY_COLUMNS = ["patient_id", "case_id", "case_index", "person_id", "display_id"];

/**
 * Care-coordination aggregates are small counts (a few plans per district): free SQL over them could rebuild a hidden cell
 * by differencing (a total minus the visible cells). They are read only through the API (get_care_funnel), which applies
 * complementary suppression (api/suppress.py).
 */
export const CARE_AGGREGATE_TABLES = new Set(["mart_care_funnel", "mart_care_adherence", "mart_care_impact", "mart_chw_workload"]);

/** Identifying columns that never leave the doctor's scoped CTEs (the model works with display_id only). */
export const DOCTOR_HIDDEN_COLUMNS = ["given_name", "family_name", "birthdate", "phone", "national_id", "name"];

export class UnsafeSQL extends Error {
  override name = "UnsafeSQL";
}

export type Role = "ministry" | "doctor";

/**
 * Port of nl2sql.allowed_tables: mart_* + ml_* + ref_district + ref_province + ext_* (synthetic external aggregates), plus
 * the facility-scoped patient and care tables for doctors (the ministry never gets care_* patient rows). Patient-level marts are removed for both roles (the doctor reaches patients only through the scoped pt_* CTEs).
 */
export function allowedTables(role: Role, existing: Iterable<string>, columns?: (t: string) => string[]): Set<string> {
  const out = new Set<string>();
  const ex = new Set(existing);
  for (const t of ex) {
    if (!(t.startsWith("mart_") || t.startsWith("ml_")) || PATIENT_LEVEL_TABLES.has(t) || CARE_AGGREGATE_TABLES.has(t)) continue;
    if (columns && columns(t).some((c) => PATIENT_KEY_COLUMNS.includes(c))) continue;
    out.add(t);
  }
  out.add("ref_district");
  out.add("ref_province");
  for (const t of EXTERNAL_TABLES) if (ex.has(t)) out.add(t);
  if (role === "doctor") for (const t of DOCTOR_TABLES) if (ex.has(t)) out.add(t);
  return out;
}

// ------------------------------------------------------------------------------------------------ parser connection
let parserCon: Promise<DuckDBConnection> | null = null;
function parser(): Promise<DuckDBConnection> {
  if (!parserCon) {
    parserCon = DuckDBInstance.create(":memory:", { enable_external_access: "false", lock_configuration: "true" }).then((i) =>
      i.connect(),
    );
  }
  return parserCon;
}

type AstNode = Record<string, unknown>;

export async function serializeSql(sql: string): Promise<{ error: boolean; error_message?: string; error_type?: string; statements?: AstNode[] }> {
  const con = await parser();
  const r = await con.runAndReadAll("SELECT json_serialize_sql(?::VARCHAR) AS j", [sql]);
  return JSON.parse(String(r.getRowObjectsJS()[0].j));
}

/** Strip code fences, whitespace and trailing semicolons (same normalisation as the Python guard). */
export function cleanSql(sql: string): string {
  let s = sql.trim();
  s = s.replace(/^```(?:sql)?/i, "").replace(/```$/, "").trim();
  while (s.endsWith(";")) s = s.slice(0, -1).trim();
  return s;
}

export interface Validated {
  sql: string;
  tables: string[];
  limited: boolean;
}

/**
 * Port of guardrails.validate_sql. Throws UnsafeSQL with a message the model can act on.
 * Returns the SQL to run (original text + LIMIT when there was none) and the real tables it reads.
 */
export async function validateSql(sqlIn: string, role: Role, allowed: Set<string>, maxRows = 1000): Promise<Validated> {
  const sql = cleanSql(sqlIn);
  if (!sql) throw new UnsafeSQL("empty SQL");
  const lowered = sql.toLowerCase();
  // regex nets first (cheap; the same patterns as the Python safety net)
  for (const fn of FORBIDDEN_FUNCS) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(lowered)) throw new UnsafeSQL(`function ${fn} is not allowed`);
  }
  if (/\bread_\w+\s*\(/.test(lowered) || /'[^']*\.(csv|parquet|json|duckdb|db)'/.test(lowered)) {
    throw new UnsafeSQL("file access is not allowed");
  }
  const parsed = await serializeSql(sql);
  if (parsed.error) {
    const msg = parsed.error_message ?? "parse error";
    if (/only select statements/i.test(msg)) throw new UnsafeSQL("only SELECT statements are allowed");
    throw new UnsafeSQL(`could not parse SQL: ${msg}`);
  }
  const stmts = parsed.statements ?? [];
  if (stmts.length !== 1) throw new UnsafeSQL("exactly one statement is allowed");
  const root = stmts[0].node as AstNode | undefined;
  if (!root) throw new UnsafeSQL("only SELECT statements are allowed");

  const tables = new Set<string>();
  walk(root, new Set(), (msg) => {
    throw new UnsafeSQL(msg);
  }, (name) => {
    if (!allowed.has(name)) throw new UnsafeSQL(`table ${name} is not available to the ${role} role`);
    tables.add(name);
  });

  const modifiers = (root.modifiers as AstNode[] | undefined) ?? [];
  const hasLimit = modifiers.some((m) => String(m.type).startsWith("LIMIT"));
  return { sql: hasLimit ? sql : `${sql}\nLIMIT ${maxRows}`, tables: [...tables], limited: !hasLimit };
}

/**
 * Scope-aware AST walk. CTE names are visible to the query that defines them and to later CTEs of the same WITH, never
 * to the CTE's own body (a non-recursive self reference would read the real table) nor to sibling subqueries.
 */
function walk(x: unknown, visible: Set<string>, fail: (m: string) => never, onTable: (name: string) => void): void {
  if (Array.isArray(x)) {
    for (const v of x) walk(v, visible, fail, onTable);
    return;
  }
  if (!x || typeof x !== "object") return;
  const o = x as AstNode;
  let vis = visible;
  const cteMap = (o.cte_map as { map?: { key: string; value: unknown }[] } | undefined)?.map;
  if (Array.isArray(cteMap) && cteMap.length) {
    vis = new Set(visible);
    for (const entry of cteMap) {
      walk(entry.value, vis, fail, onTable);
      vis.add(String(entry.key).toLowerCase());
    }
  }
  const type = o.type;
  if (type === "TABLE_FUNCTION") fail("table functions are not allowed");
  if (type === "BASE_TABLE") {
    const name = String(o.table_name ?? "").toLowerCase();
    if (o.schema_name || o.catalog_name) fail("schema-qualified tables are not allowed");
    if (name && !vis.has(name)) onTable(name);
  }
  if (o.class === "FUNCTION" || type === "FUNCTION") {
    const fn = String(o.function_name ?? "").toLowerCase();
    if (FORBIDDEN_FUNCS.has(fn) || fn.startsWith("read_")) fail(`function ${fn} is not allowed`);
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "cte_map") continue;
    if (v && typeof v === "object") walk(v, vis, fail, onTable);
  }
}

/**
 * Port of nl2sql._scope_doctor: shadow every patient-level table with a CTE filtered to the doctor's facility
 * (pt_patient_facility = home facility, its district hospital and recent GI encounters there). Identifying columns are
 * excluded inside the CTE, so model-written SQL can never select a patient's name.
 */
export function scopeDoctor(sql: string, facilityId: number, existing: Set<string>, columns: (t: string) => string[] = () => []): string {
  const f = Math.trunc(Number(facilityId));
  if (!Number.isFinite(f)) throw new UnsafeSQL("doctor queries need a facility");
  const sel = (t: string) => {
    const hide = columns(t).filter((c) => DOCTOR_HIDDEN_COLUMNS.includes(c));
    return hide.length ? `SELECT * EXCLUDE (${hide.map((c) => `"${c}"`).join(", ")})` : "SELECT *";
  };
  const ctes = [`pt_patient_facility AS (SELECT * FROM main.pt_patient_facility WHERE facility_id = ${f})`];
  for (const t of DOCTOR_TABLES) {
    if (t === "pt_patient_facility" || !existing.has(t)) continue;
    ctes.push(`${t} AS (${sel(t)} FROM main.${t} WHERE patient_id IN (SELECT patient_id FROM pt_patient_facility))`);
  }
  return `WITH ${ctes.join(", ")} SELECT * FROM (${sql}) AS q`;
}

export function needsDoctorScope(tables: string[]): boolean {
  return tables.some((t) => (DOCTOR_TABLES as readonly string[]).includes(t));
}
