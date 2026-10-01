/** get_stage_mix, get_survival, get_facility_quality: ports of /stage-mix, /survival/*, /facilities/quality. */
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { suppressSmallCells } from "../guardrails/suppress.js";
import { round } from "./rates.js";
import { defineTool } from "./types.js";

export const getStageMix = defineTool({
  name: "get_stage_mix",
  title: "Stage at diagnosis",
  description:
    "Stage at diagnosis (stage_group I, II, III, IV, Unknown) with n, pct (of all) and pct_known (of known stage). by='year' " +
    "gives the mix per diagnosis year for a geography; by='tier' compares facility tiers (all years) with a chi-square test. " +
    "level NATIONAL (geo_code RW), PROVINCE (KGL NOR SOU EAS WES) or DISTRICT (e.g. NOR-MUS). Late stage = III + IV.",
  roles: ["ministry"],
  inputSchema: z.object({
    level: z.enum(["NATIONAL", "PROVINCE", "DISTRICT"]).default("NATIONAL"),
    geo_code: z.string().default("RW"),
    by: z.enum(["year", "tier", "all_years"]).default("year"),
  }),
  async execute(i, t) {
    const db = SERVE();
    const geo = i.level === "NATIONAL" ? "RW" : i.geo_code;
    let rows;
    let chi_square = null;
    if (i.by === "tier") {
      rows = await db.rows(
        `SELECT facility_tier, stage_group, n, pct, pct_known FROM mart_stage_mix WHERE level = ? AND geo_code = ?
         AND year = 'ALL' AND facility_tier <> 'ALL' ORDER BY 1, 2`, [i.level, geo]);
      chi_square = (await db.hasTable("mart_stage_tier_test")) ? await db.one("SELECT * FROM mart_stage_tier_test") : null;
    } else if (i.by === "all_years") {
      rows = await db.rows(
        `SELECT stage_group, n, pct, pct_known FROM mart_stage_mix WHERE level = ? AND geo_code = ? AND facility_tier = 'ALL'
         AND year = 'ALL' ORDER BY 1`, [i.level, geo]);
    } else {
      rows = await db.rows(
        `SELECT CAST(year AS INTEGER) AS year, stage_group, n, pct, pct_known FROM mart_stage_mix WHERE level = ? AND geo_code = ?
         AND facility_tier = 'ALL' AND year <> 'ALL' ORDER BY 1, 2`, [i.level, geo]);
    }
    rows = suppressSmallCells(rows).map((r) => ({ ...r, pct: round(r.pct, 1), pct_known: round(r.pct_known, 1) }));
    if (!rows.length) return { ok: false, error: `No stage mix for ${i.level} ${geo}` };
    return { ok: true, level: i.level, geo_code: geo, by: i.by, chi_square, dataset_id: t.datasets.register("get_stage_mix", rows), rows };
  },
});

export const getSurvival = defineTool({
  name: "get_survival",
  title: "Survival",
  description:
    "Kaplan-Meier survival after diagnosis grouped by group_var (stage, age_band, sex, province, facility_tier, hp_status, period): " +
    "n, surv_1y and surv_2y (fractions 0-1), median_surv_days. include_curve adds the KM curve points (t_days, surv, lci, uci) " +
    "for a line chart; include_cox adds Cox hazard ratios (forest plot: estimate hr, lci, uci, reference 1).",
  roles: ["ministry"],
  inputSchema: z.object({
    group_var: z.string().default("stage"),
    include_curve: z.boolean().default(false),
    include_cox: z.boolean().default(false),
  }),
  async execute(i, t) {
    const db = SERVE();
    const rows = suppressSmallCells(await db.rows("SELECT * FROM mart_survival_summary WHERE group_var = ? ORDER BY group_value", [i.group_var]))
      .map((r) => ({ ...r, surv_1y: round(r.surv_1y, 3), surv_2y: round(r.surv_2y, 3) }));
    if (!rows.length) {
      const avail = await db.rows("SELECT DISTINCT group_var FROM mart_survival_summary ORDER BY 1");
      return { ok: false, error: `Unknown group_var ${i.group_var}`, available: avail.map((r) => r.group_var) };
    }
    const out: Record<string, unknown> = { ok: true, group_var: i.group_var, units: { surv_1y: "fraction 0-1", median_surv_days: "days" } };
    out.dataset_id = t.datasets.register("get_survival", rows);
    out.rows = rows;
    if (i.include_curve && (await db.hasTable("mart_survival_km"))) {
      const curve = suppressSmallCells(await db.rows(
        "SELECT * FROM mart_survival_km WHERE group_var = ? ORDER BY group_value, t_days", [i.group_var]));
      // thin to <= 400 points so it fits a chart spec
      const step = Math.max(1, Math.ceil(curve.length / 400));
      const thin = curve.filter((_, k) => k % step === 0).map((r) => ({ ...r, surv: round(r.surv, 3), lci: round(r.lci, 3), uci: round(r.uci, 3) }));
      out.curve = { dataset_id: t.datasets.register("get_survival", thin), n_points: thin.length, rows: thin };
    }
    if (i.include_cox && (await db.hasTable("mart_cox"))) {
      const cox = (await db.rows("SELECT * FROM mart_cox ORDER BY model_id, term")).map((r) => ({ ...r, hr: round(r.hr), lci: round(r.lci), uci: round(r.uci), p: round(r.p, 4) }));
      out.cox = { dataset_id: t.datasets.register("get_survival", cox), rows: cox };
    }
    return out;
  },
});

export const getFacilityQuality = defineTool({
  name: "get_facility_quality",
  title: "Facility quality",
  description:
    "Per-facility quality of care: H. pylori testing among dyspepsia patients (n_dyspepsia, n_hp_tested, hp_test_rate as a " +
    "fraction 0-1, funnel-plot outlier_flag), cases diagnosed (n_cases), pct_stage4 and median diagnostic interval (days). " +
    "Filter by district or province, keep outliers only, sort and limit. Use for 'which facilities test the fewest / are " +
    "outliers' questions. Facilities with fewer than min_dyspepsia patients are excluded (default 10).",
  roles: ["ministry"],
  inputSchema: z.object({
    district_code: z.string().optional(),
    province_code: z.string().optional(),
    outliers_only: z.boolean().default(false),
    order_by: z.enum(["hp_test_rate", "n_dyspepsia", "pct_stage4", "median_diag_interval", "n_cases"]).default("hp_test_rate"),
    order: z.enum(["asc", "desc"]).default("asc"),
    min_dyspepsia: z.number().int().min(0).default(10),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  async execute(i, t) {
    const where = ["n_dyspepsia >= ?"];
    const params: unknown[] = [i.min_dyspepsia];
    if (i.district_code) { where.push("district_code = ?"); params.push(i.district_code); }
    if (i.province_code) { where.push("province_code = ?"); params.push(i.province_code); }
    if (i.outliers_only) where.push("outlier_flag IS NOT NULL");
    const rows = await SERVE().rows(
      `SELECT location_id, name, district_code, province_code, facility_type, tier, n_dyspepsia, n_hp_tested, hp_test_rate,
              funnel_lower95, funnel_upper95, outlier_flag, target_rate, n_cases, pct_stage4, median_diag_interval
       FROM mart_facility_quality WHERE ${where.join(" AND ")}
       ORDER BY ${i.order_by} ${i.order === "asc" ? "ASC" : "DESC"} NULLS LAST LIMIT ?`,
      [...params, i.limit],
    );
    const out = suppressSmallCells(rows).map((r) => ({
      ...r, hp_test_rate: round(r.hp_test_rate, 3), hp_test_rate_pct: typeof r.hp_test_rate === "number" ? round(100 * r.hp_test_rate, 1) : null,
      funnel_lower95: round(r.funnel_lower95, 3), funnel_upper95: round(r.funnel_upper95, 3), pct_stage4: round(r.pct_stage4, 1),
    }));
    return { ok: true, count: out.length, dataset_id: t.datasets.register("get_facility_quality", out), rows: out };
  },
});
