/** query_marts: guarded read-only SQL over the marts (NL->SQL path of SPEC §15.2, executed by the agent). */
import { z } from "zod";
import { guardedQuery } from "../db/query.js";
import { defineTool } from "./types.js";

export const queryMarts = defineTool({
  name: "query_marts",
  title: "SQL over the data marts",
  description:
    "Runs ONE read-only DuckDB SELECT against the published data marts (use describe_tables first for columns). Returns " +
    "{ sql_executed, columns, rows, row_count, truncated, caveats, dataset_id }. Max 1000 rows; a LIMIT is added when missing. " +
    "On error you get { ok:false, error } - fix the SQL once and retry. Prefer the typed tools (get_kpis, get_rates_trend, ...) " +
    "when they answer the question.",
  roles: ["ministry", "doctor"],
  inputSchema: z.object({
    sql: z.string().min(6).max(6000).describe("A single DuckDB SELECT statement"),
    purpose: z.string().max(200).optional().describe("One line: what this query answers"),
  }),
  async execute({ sql }, t) {
    const r = await guardedQuery(t.ctx, sql);
    if (!r.ok) return r;
    return { ...r, dataset_id: t.datasets.register("query_marts", r.rows, r.sql_executed) };
  },
});
