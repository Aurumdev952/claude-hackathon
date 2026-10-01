/** describe_tables: semantic layer + information_schema for the tables this role may query. */
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { allowedFor } from "../db/query.js";
import { semantic } from "../db/semantic.js";
import { DOCTOR_HIDDEN_COLUMNS, DOCTOR_TABLES } from "../guardrails/sql.js";
import { defineTool } from "./types.js";

export const describeTables = defineTool({
  name: "describe_tables",
  title: "Data dictionary",
  description:
    "Lists the tables you may query with query_marts (descriptions, grain, columns, default filters, glossary). Pass `tables` " +
    "to get full column lists for specific tables. Call this before writing SQL against a table you have not used yet.",
  roles: ["ministry", "doctor"],
  inputSchema: z.object({ tables: z.array(z.string()).max(12).optional() }),
  async execute({ tables }, t) {
    const db = SERVE();
    const allowed = [...(await allowedFor(t.ctx, db))].sort();
    const sem = semantic();
    const want = tables?.length ? tables.map((x) => x.toLowerCase()) : null;
    const out = [];
    for (const name of allowed) {
      if (want && !want.includes(name)) continue;
      if (!(await db.hasTable(name))) continue;
      let cols = await db.columns(name);
      if (t.ctx.role === "doctor" && (DOCTOR_TABLES as readonly string[]).includes(name)) cols = cols.filter((c) => !DOCTOR_HIDDEN_COLUMNS.includes(c));
      const doc = sem.tables[name] ?? {};
      out.push({
        name, description: doc.description ?? null, ...(doc.grain ? { grain: doc.grain } : {}),
        ...(doc.default_filters ? { default_filters: doc.default_filters } : {}),
        columns: want ? cols : cols.join(", "),
        ...(want && doc.columns ? { column_docs: doc.columns } : {}),
      });
    }
    const unknown = want ? want.filter((w) => !allowed.includes(w)) : [];
    return {
      ok: true,
      role: t.ctx.role,
      tables: out,
      ...(unknown.length ? { not_available: unknown } : {}),
      glossary: sem.glossary,
      rules: [
        "One read-only SELECT (CTEs allowed). No schema prefixes, no file or table functions.",
        "mart_rates default filters: sex='ALL' AND age_band='ALL' AND case_def='CONFIRMED_PROBABLE' AND period_type='YEAR'; period is VARCHAR ('2024' or '2023-2025').",
        "Prefer asr when the user says 'rate'. Fractions (0-1) vs percentages: check the column docs.",
        ...(t.ctx.role === "doctor"
          ? ["pt_* tables and ml_risk_history are automatically restricted to patients of your facility; names are not available - use display_id."]
          : ["Counts below 5 are suppressed in results (shown as <5)."]),
      ],
    };
  },
});
