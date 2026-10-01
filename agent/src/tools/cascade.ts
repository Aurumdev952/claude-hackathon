/** get_care_cascade: port of GET /cohort/funnel (H. pylori and endoscopy pathways of the GI cohort). */
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { suppressSmallCells } from "../guardrails/suppress.js";
import { round } from "./rates.js";
import { defineTool } from "./types.js";

export const getCareCascade = defineTool({
  name: "get_care_cascade",
  title: "Care cascade",
  description:
    "Care cascade of the GI-symptom cohort: pathway 'hp' (gi_flagged -> hp_tested -> hp_positive -> eradicated) and pathway " +
    "'endoscopy' (gi_flagged -> referred -> scoped -> biopsied -> diagnosed), with n and pct_of_prev (% of the previous step). " +
    "Filter by cohort entry year ('ALL' or e.g. '2024') and province ('ALL' or KGL NOR SOU EAS WES). Use for drop-off / " +
    "funnel / testing / referral questions; chart as a bar (x=stage, y=n).",
  roles: ["ministry"],
  inputSchema: z.object({
    year: z.string().default("ALL"),
    province: z.string().default("ALL"),
    pathway: z.enum(["hp", "endoscopy", "both"]).default("both"),
  }),
  async execute(i, t) {
    const raw = await SERVE().rows(
      "SELECT pathway, stage, year, province, n, pct_of_prev FROM mart_cohort_funnel WHERE year = ? AND province = ? ORDER BY pathway, rowid",
      [i.year, i.province],
    ).catch(() => SERVE().rows(
      "SELECT pathway, stage, year, province, n, pct_of_prev FROM mart_cohort_funnel WHERE year = ? AND province = ? ORDER BY pathway",
      [i.year, i.province],
    ));
    const rows = suppressSmallCells(raw.filter((r) => i.pathway === "both" || r.pathway === i.pathway))
      .map((r) => ({ ...r, pct_of_prev: round(r.pct_of_prev, 1) }));
    if (!rows.length) {
      const opts = await SERVE().rows("SELECT DISTINCT year, province FROM mart_cohort_funnel ORDER BY 1, 2");
      return { ok: false, error: "No cascade rows for that filter", available: opts.slice(0, 40) };
    }
    return { ok: true, year: i.year, province: i.province, dataset_id: t.datasets.register("get_care_cascade", rows), rows };
  },
});
