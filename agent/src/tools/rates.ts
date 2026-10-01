/** get_rates_trend: port of GET /rates + GET /trends/joinpoint (api/routers/epi.py). */
import { z } from "zod";
import { parseJson, SERVE, type RowObject } from "../db/duck.js";
import { suppressObserved, suppressRow } from "../guardrails/suppress.js";
import { defineTool } from "./types.js";

export const SEX = ["ALL", "M", "F"] as const;
export const BANDS = ["ALL", "<50", "50-64", "65+"] as const;
export const CASE_DEFS = ["CONFIRMED_PROBABLE", "CONFIRMED"] as const;
export const LEVELS = ["NATIONAL", "PROVINCE", "DISTRICT"] as const;

export const getRatesTrend = defineTool({
  name: "get_rates_trend",
  title: "Incidence trend",
  description:
    "Yearly gastric cancer incidence (age-standardised rate per 100,000 with 95% CI, crude rate, cases) for the nation, a " +
    "province or a district, by sex / age band / case definition, plus the joinpoint trend model (segments with APC = annual " +
    "percent change and 95% CI, AAPC over the last 10 years) when one exists. Use for any 'how has X changed / trend / since " +
    "<year>' question. Cells with <5 cases are suppressed. Years flagged coverage_flag=LOW_EMR_COVERAGE rest on few facilities.",
  roles: ["ministry"],
  inputSchema: z.object({
    level: z.enum(LEVELS).default("NATIONAL"),
    geo_code: z.string().optional().describe("Province code (KGL NOR SOU EAS WES) or district code (e.g. WES-RUS); omit for national"),
    sex: z.enum(SEX).default("ALL"),
    age_band: z.enum(BANDS).default("ALL").describe("'<50' for under-50 / young-onset"),
    case_def: z.enum(CASE_DEFS).default("CONFIRMED_PROBABLE"),
    year_from: z.number().int().optional(),
    year_to: z.number().int().optional(),
    include_partial_year: z.boolean().default(false).describe("Include the current, incomplete year"),
  }),
  async execute(i, t) {
    const geo = i.level === "NATIONAL" ? "RW" : i.geo_code;
    if (!geo) return { ok: false, error: "geo_code is required for PROVINCE and DISTRICT levels" };
    const raw = await SERVE().rows(
      `SELECT CAST(period AS INTEGER) AS year, geo_code, cases, population, crude_rate, asr, asr_lci, asr_uci, suppressed, coverage_flag, partial_year
       FROM mart_rates WHERE level = ? AND geo_code = ? AND sex = ? AND age_band = ? AND case_def = ? AND period_type = 'YEAR' ORDER BY 1`,
      [i.level, geo, i.sex, i.age_band, i.case_def],
    );
    if (!raw.length) {
      const avail = await SERVE().rows("SELECT DISTINCT geo_code FROM mart_rates WHERE level = ? ORDER BY 1", [i.level]);
      return { ok: false, error: `No rates for ${i.level} ${geo}`, available_geo_codes: avail.map((r) => r.geo_code) };
    }
    const rows: RowObject[] = raw
      .filter((r) => (i.year_from === undefined || (r.year as number) >= i.year_from) && (i.year_to === undefined || (r.year as number) <= i.year_to))
      .filter((r) => i.include_partial_year || !r.partial_year)
      .map((r) => {
        const s = suppressRow(r);
        const out: RowObject = {};
        for (const k of ["year", "cases", "asr", "asr_lci", "asr_uci", "crude_rate", "coverage_flag", "partial_year"]) out[k] = s[k] ?? null;
        if (s.cases_label) out.cases_label = s.cases_label as string;
        for (const k of ["asr", "asr_lci", "asr_uci", "crude_rate"]) if (typeof out[k] === "number") out[k] = Math.round((out[k] as number) * 100) / 100;
        return out;
      });
    const sid = `${i.level === "NATIONAL" ? "NATIONAL" : geo}|${i.sex}|${i.age_band}|${i.case_def}`;
    const jp = await SERVE().rows("SELECT * FROM mart_joinpoint WHERE series_id = ? ORDER BY segment_no", [sid]);
    let joinpoint: unknown = null;
    if (jp.length) {
      const f = jp[0];
      joinpoint = {
        series_id: sid,
        n_joinpoints: f.n_joinpoints,
        segments: jp.filter((x) => x.segment_no).map((x) => ({
          segment_no: x.segment_no, start_year: x.start_year, end_year: x.end_year, apc: round(x.apc), apc_lci: round(x.apc_lci),
          apc_uci: round(x.apc_uci), significant: x.significant,
        })),
        aapc_last10: { value: round(f.aapc_last10), lci: round(f.aapc_lci), uci: round(f.aapc_uci) },
        events: parseJson(f.events_json) ?? [],
        observed_suppressed_years: suppressObserved((parseJson(f.observed_json) as Record<string, unknown>[]) ?? [])
          .filter((o) => o.cases_label === "<5").map((o) => o.year),
      };
    }
    const first = rows.find((r) => typeof r.asr === "number");
    const last = [...rows].reverse().find((r) => typeof r.asr === "number");
    return {
      ok: true,
      series: { level: i.level, geo_code: geo, sex: i.sex, age_band: i.age_band, case_def: i.case_def },
      unit: "per 100,000 person-years (asr = WHO world standard)",
      summary: first && last ? {
        first_year: first.year, first_asr: first.asr, last_year: last.year, last_asr: last.asr,
        change_pct: typeof first.asr === "number" && typeof last.asr === "number" && first.asr ? round((100 * (last.asr - first.asr)) / first.asr) : null,
      } : null,
      joinpoint,
      dataset_id: t.datasets.register("get_rates_trend", rows),
      rows,
    };
  },
});

export function round(v: unknown, d = 2): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;
}

/** Rounds floats for readability (2 decimals, 4 below 1) - keeps numbers the model quotes identical to the tool output. */
export function roundDeep<T>(o: T): T {
  if (typeof o === "number") return (Number.isInteger(o) ? o : Math.abs(o) < 1 ? Math.round(o * 1e4) / 1e4 : Math.round(o * 100) / 100) as T;
  if (Array.isArray(o)) return o.map(roundDeep) as T;
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, roundDeep(v)])) as T;
  return o;
}
