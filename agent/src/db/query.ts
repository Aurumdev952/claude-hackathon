/**
 * Guarded execution of model-written SQL (port of nl2sql.ask steps 5-8): validate -> facility scope (doctor) ->
 * read-only execution with a watchdog -> ministry small-cell suppression + de-identification -> caveats.
 * Errors come back as data so the model can repair its SQL once.
 */
import type { AgentContext } from "../context.js";
import { allowedTables, needsDoctorScope, scopeDoctor, UnsafeSQL, validateSql } from "../guardrails/sql.js";
import { ministryView, suppressSmallCells } from "../guardrails/suppress.js";
import { SERVE, type RowObject, type ServeDB } from "./duck.js";

export const MAX_ROWS = 1000;
export const SYNTHETIC_CAVEAT = "Synthetic data for demonstration - not real patients or real district statistics.";

export interface QueryResult {
  ok: boolean;
  sql_executed: string | null;
  columns: string[];
  rows: RowObject[];
  row_count: number;
  truncated: boolean;
  caveats: string[];
  error?: string;
  error_kind?: "unsafe" | "execution" | "timeout";
  ms?: number;
}

/** Port of nl2sql.caveats. */
export function caveats(columns: string[], rows: RowObject[]): string[] {
  const out: string[] = [];
  if (columns.includes("cases")) {
    const small = rows.some((r) => typeof r.cases === "number" && r.cases < 20) || rows.some((r) => r.cases_label === "<5");
    if (small) out.push("Small numbers: some rows have fewer than 20 cases - interpret rates with care.");
  }
  if (rows.some((r) => Object.keys(r).some((k) => k.endsWith("_label") && r[k] === "<5"))) {
    out.push("Cells with fewer than 5 cases are suppressed (shown as <5) for the ministry role.");
  }
  out.push(SYNTHETIC_CAVEAT);
  return out;
}

export async function allowedFor(ctx: AgentContext, db: ServeDB = SERVE()): Promise<Set<string>> {
  const tables = await db.tables();
  const cols = new Map<string, string[]>();
  for (const t of tables) cols.set(t, await db.columns(t));
  return allowedTables(ctx.role, tables, (t) => cols.get(t) ?? []);
}

/** Validates and scopes; returns the SQL that would run (used by query_marts and the sandbox data hand-off). */
export async function prepareSql(ctx: AgentContext, sql: string, maxRows = MAX_ROWS, db: ServeDB = SERVE()) {
  const allowed = await allowedFor(ctx, db);
  const v = await validateSql(sql, ctx.role, allowed, maxRows);
  let run = v.sql;
  if (ctx.role === "doctor" && needsDoctorScope(v.tables)) {
    const tables = await db.tables();
    const cols = new Map<string, string[]>();
    for (const t of tables) cols.set(t, await db.columns(t));
    run = scopeDoctor(v.sql, ctx.facilityId as number, tables, (t) => cols.get(t) ?? []);
  }
  return { ...v, run };
}

/** Role-specific output filter applied to every row set before it leaves the server. */
export function filterRows(ctx: AgentContext, rows: RowObject[]): RowObject[] {
  return ctx.role === "ministry" ? ministryView(suppressSmallCells(rows)) : rows;
}

export async function guardedQuery(ctx: AgentContext, sql: string, opts: { maxRows?: number; db?: ServeDB } = {}): Promise<QueryResult> {
  const db = opts.db ?? SERVE();
  const maxRows = Math.min(opts.maxRows ?? MAX_ROWS, MAX_ROWS);
  let prepared: Awaited<ReturnType<typeof prepareSql>>;
  try {
    prepared = await prepareSql(ctx, sql, maxRows, db);
  } catch (e) {
    const unsafe = e instanceof UnsafeSQL;
    return {
      ok: false, sql_executed: null, columns: [], rows: [], row_count: 0, truncated: false, caveats: [],
      error: unsafe ? `Rejected by the SQL guardrails: ${(e as Error).message}` : String((e as Error).message ?? e),
      error_kind: unsafe ? "unsafe" : "execution",
    };
  }
  try {
    const r = await db.execute(prepared.run, { maxRows });
    const rows = filterRows(ctx, r.rows);
    const columns = rows.length ? Object.keys(rows[0]) : r.columns.filter((c) => ctx.role !== "ministry" || !["given_name", "family_name", "display_id", "patient_id", "birthdate", "phone", "national_id"].includes(c));
    return {
      ok: true, sql_executed: prepared.sql, columns, rows, row_count: rows.length,
      truncated: r.totalRows > rows.length || (prepared.limited && r.totalRows >= maxRows), caveats: caveats(columns, rows), ms: r.ms,
    };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const timeout = msg.includes("interrupted") || (e as Error).constructor?.name === "QueryTimeout";
    return {
      ok: false, sql_executed: prepared.sql, columns: [], rows: [], row_count: 0, truncated: false, caveats: [],
      error: timeout ? `Query timed out: ${msg}` : `DuckDB error: ${msg.split("\n")[0].slice(0, 400)}`,
      error_kind: timeout ? "timeout" : "execution",
    };
  }
}
