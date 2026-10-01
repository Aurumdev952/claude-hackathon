/** get_kpis: port of GET /kpis (api/routers/epi.py). */
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { suppressSmallCells } from "../guardrails/suppress.js";
import { roundDeep } from "./rates.js";
import { defineTool } from "./types.js";

const SPARK = ["cases", "cases_annualised", "national_asr", "pct_stage_iv", "median_diag_interval_days", "hp_testing_rate_dyspepsia", "young_onset_share"];

export const getKpis = defineTool({
  name: "get_kpis",
  title: "Headline KPIs",
  description:
    "National headline indicators for one year (default: latest; the latest year may be partial) plus their history by year: " +
    "cases, national ASR with 95% CI, % stage IV (of known stage), median diagnostic interval (days), H. pylori testing rate " +
    "among dyspepsia patients (0-1), young-onset share (<50, 0-1), high-risk patients awaiting endoscopy. " +
    "`rows` (dataset_id) is one row per year for charts.",
  roles: ["ministry"],
  inputSchema: z.object({ year: z.number().int().optional().describe("Calendar year; omit for the latest") }),
  async execute({ year }, t) {
    const rows = await SERVE().cached("kpis", () => SERVE().rows("SELECT * FROM mart_kpis ORDER BY year"));
    if (!rows.length) return { ok: false, error: "No KPIs published" };
    const y = year ?? (rows[rows.length - 1].year as number);
    const row = rows.find((r) => r.year === y);
    if (!row) return { ok: false, error: `No KPIs for year ${y}`, years: rows.map((r) => r.year) };
    const series = roundDeep(suppressSmallCells(rows.map((r) => Object.fromEntries([["year", r.year], ["partial_year", r.partial_year], ...SPARK.map((k) => [k, r[k] ?? null])]))));
    const lastFull = [...rows].reverse().find((r) => !r.partial_year)?.year ?? null;
    return {
      ok: true,
      year: y,
      partial_year: !!row.partial_year,
      last_full_year: lastFull,
      kpis: roundDeep({ ...row, national_asr_ci: [row.national_asr_lci, row.national_asr_uci] }),
      units: {
        national_asr: "per 100,000 (WHO world standard)", pct_stage_iv: "% of cases with known stage",
        hp_testing_rate_dyspepsia: "fraction 0-1", young_onset_share: "fraction 0-1", median_diag_interval_days: "days",
      },
      dataset_id: t.datasets.register("get_kpis", series),
      rows: series,
    };
  },
});
