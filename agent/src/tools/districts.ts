/** get_district_ranking: port of GET /rates/map (district / province map with LISA hotspots, SIR, HP testing, stage IV). */
import { z } from "zod";
import { SERVE, type RowObject } from "../db/duck.js";
import { suppressRow } from "../guardrails/suppress.js";
import { BANDS, CASE_DEFS, round, SEX } from "./rates.js";
import { defineTool } from "./types.js";

const METRICS = ["asr", "crude_rate", "sir", "lisa_quadrant", "hp_test_rate", "pct_stage4", "cases"] as const;
const UNITS: Record<(typeof METRICS)[number], string> = {
  asr: "per 100,000", crude_rate: "per 100,000", sir: "ratio", hp_test_rate: "%", pct_stage4: "%", cases: "cases", lisa_quadrant: "category",
};

export const getDistrictRanking = defineTool({
  name: "get_district_ranking",
  title: "District / province ranking",
  description:
    "Ranks districts (or provinces) for one period on a metric: asr (default), crude_rate, sir (standardised incidence ratio), " +
    "hp_test_rate (% of dyspepsia patients tested), pct_stage4 (% stage IV of known stage) or cases. District rows include the " +
    "spatial statistics: lisa_quadrant (HH = High-High hotspot, LL, HL, LH, NS), gi_star_z, eb_smoothed_rate, sir. Default period " +
    "is the latest 3-year pooled window. Use for 'which districts are highest / hotspots / map' questions; chart with a choropleth " +
    "(geo_key=geo_code) or a horizontal bar. Cells with <5 cases are suppressed.",
  roles: ["ministry"],
  inputSchema: z.object({
    level: z.enum(["DISTRICT", "PROVINCE"]).default("DISTRICT"),
    metric: z.enum(METRICS).default("asr"),
    period_type: z.enum(["POOLED3", "POOLED_ALL", "YEAR"]).default("POOLED3"),
    period: z.string().optional().describe("e.g. '2023-2025' (POOLED3), '2024' (YEAR); omit for the latest"),
    sex: z.enum(SEX).default("ALL"),
    age_band: z.enum(BANDS).default("ALL"),
    case_def: z.enum(CASE_DEFS).default("CONFIRMED_PROBABLE"),
    hotspots_only: z.boolean().default(false).describe("Only LISA High-High districts"),
    top: z.number().int().min(1).max(60).optional().describe("Keep the top N after ranking"),
    order: z.enum(["desc", "asc"]).default("desc"),
  }),
  async execute(i, t) {
    const db = SERVE();
    let period = i.period;
    if (!period) {
      const periods = await db.rows("SELECT DISTINCT period FROM mart_rates WHERE period_type = ? ORDER BY period", [i.period_type]);
      if (!periods.length) return { ok: false, error: `Unknown period_type ${i.period_type}` };
      if (i.period_type === "YEAR") {
        const full = await db.one("SELECT max(period) AS p FROM mart_rates WHERE period_type = 'YEAR' AND NOT coalesce(partial_year, FALSE)");
        period = String(full?.p ?? periods.at(-1)!.period);
      } else {
        const end = (p: string) => p.split("-").at(-1)!;
        period = periods.map((p) => String(p.period)).sort((a, b) => end(a).localeCompare(end(b)) || a.localeCompare(b)).at(-1)!;
      }
    }
    let rows = await db.rows(
      `SELECT r.geo_code, coalesce(d.name, p.name) AS name, r.cases, r.population, r.crude_rate, r.asr, r.asr_lci, r.asr_uci, r.suppressed, r.coverage_flag
       FROM mart_rates r LEFT JOIN ref_district d ON d.district_code = r.geo_code
       LEFT JOIN (SELECT DISTINCT province_code, province AS name FROM ref_district) p ON p.province_code = r.geo_code
       WHERE r.level = ? AND r.period = ? AND r.sex = ? AND r.age_band = ? AND r.case_def = ?`,
      [i.level, period, i.sex, i.age_band, i.case_def],
    );
    if (!rows.length) return { ok: false, error: `No ${i.level} rates for period ${period}` };
    if (i.level === "DISTRICT") {
      const sp = new Map((await db.rows("SELECT * FROM mart_spatial")).map((x) => [x.district_code, x]));
      const fq = new Map((await db.rows(
        "SELECT district_code, 100.0 * sum(n_hp_tested) / nullif(sum(n_dyspepsia), 0) AS hp_test_rate, sum(n_dyspepsia) AS n_dyspepsia FROM mart_facility_quality GROUP BY 1",
      )).map((x) => [x.district_code, x]));
      const st = new Map((await db.rows(
        `SELECT geo_code, sum(n) FILTER (WHERE stage_group = 'IV') * 100.0 / nullif(sum(n) FILTER (WHERE stage_group <> 'Unknown'), 0) AS pct_stage4
         FROM mart_stage_mix WHERE level = 'DISTRICT' AND year = 'ALL' AND facility_tier = 'ALL' GROUP BY 1`,
      )).map((x) => [x.geo_code, x]));
      rows = rows.map((x) => {
        const s = sp.get(x.geo_code) ?? {};
        return {
          ...x, lisa_quadrant: s.lisa_quadrant ?? null, sir: round(s.sir), gi_star_z: round(s.gi_star_z), eb_smoothed_rate: round(s.eb_smoothed_rate),
          hp_test_rate: round(fq.get(x.geo_code)?.hp_test_rate, 1), pct_stage4: round(st.get(x.geo_code)?.pct_stage4, 1),
        };
      });
    }
    rows = rows.map((x) => {
      const s = suppressRow(x);
      for (const k of ["crude_rate", "asr", "asr_lci", "asr_uci"]) if (typeof s[k] === "number") (s as RowObject)[k] = round(s[k]);
      delete (s as RowObject).population;
      return s;
    });
    const num = (z: RowObject) => (typeof z[i.metric] === "number" ? (z[i.metric] as number) : null);
    rows.sort((a, b) => {
      const va = num(a), vb = num(b);
      if (va === null && vb === null) return String(a.geo_code).localeCompare(String(b.geo_code));
      if (va === null) return 1;
      if (vb === null) return -1;
      return i.order === "desc" ? vb - va : va - vb;
    });
    rows.forEach((x, k) => (x.rank = k + 1));
    if (i.hotspots_only) rows = rows.filter((x) => x.lisa_quadrant === "HH");
    if (i.top) rows = rows.slice(0, i.top);
    const vals = rows.map(num).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const nat = await db.one(
      "SELECT asr, crude_rate FROM mart_rates WHERE level = 'NATIONAL' AND period = ? AND sex = ? AND age_band = ? AND case_def = ?",
      [period, i.sex, i.age_band, i.case_def],
    );
    const glob = i.level === "DISTRICT" ? await db.one("SELECT global_morans_i, global_p, period FROM mart_spatial WHERE district_code = 'RW'") : null;
    return {
      ok: true,
      level: i.level,
      period,
      metric: i.metric,
      legend: {
        metric: i.metric, unit: UNITS[i.metric], min: vals[0] ?? null, max: vals.at(-1) ?? null,
        national: round(nat?.[i.metric === "crude_rate" ? "crude_rate" : "asr"]), period,
      },
      spatial: glob ? { morans_i: round(glob.global_morans_i, 3), p: round(glob.global_p, 4), period: glob.period } : null,
      dataset_id: t.datasets.register("get_district_ranking", rows),
      rows,
    };
  },
});
