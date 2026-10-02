/** get_model_metrics: port of GET /models + /models/subgroups (risk model evaluation; aggregate, both roles). */
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { round } from "./rates.js";
import { defineTool } from "./types.js";

export const getModelMetrics = defineTool({
  name: "get_model_metrics",
  title: "Risk model performance",
  description:
    "Evaluation of the gastric cancer risk models: tier 1 points score, tier 2 XGBoost, tier 3 sequence model and the ensemble " +
    "(tier 0) on the validation / test split: auroc, auprc, brier, sensitivity at 90% specificity, PPV and number needed to " +
    "scope in the top 2%, median lead time (days). include_subgroups adds AUROC by subgroup (fairness).",
  roles: ["ministry", "doctor"],
  inputSchema: z.object({
    split: z.enum(["test", "val"]).default("test"),
    include_subgroups: z.boolean().default(false),
  }),
  async execute(i, t) {
    const db = SERVE();
    if (!(await db.hasTable("ml_eval_metrics"))) return { ok: false, error: "Models are not trained yet" };
    const rows = (await db.rows("SELECT * FROM ml_eval_metrics WHERE split = ? ORDER BY tier", [i.split])).map((r) => {
      const o = { ...r };
      for (const k of ["auroc", "auprc", "brier", "ece", "sens_at_spec90", "ppv_at_top2pct", "high_threshold"]) if (k in o) o[k] = round(o[k], 3);
      for (const k of ["nns_at_top2pct", "median_lead_time_days", "pct_flagged_ge_90d", "pct_flagged_ever"]) if (k in o) o[k] = round(o[k], 1);
      return o;
    });
    const thresholds = (await db.hasTable("ml_thresholds")) ? await db.one("SELECT high_cut, medium_cut FROM ml_thresholds") : null;
    const out: Record<string, unknown> = { ok: true, split: i.split, thresholds, dataset_id: t.datasets.register("get_model_metrics", rows), rows };
    if (i.include_subgroups && (await db.hasTable("ml_subgroup_metrics"))) {
      const sg = (await db.rows("SELECT model_id, subgroup_var, subgroup_value, n, n_pos, auroc FROM ml_subgroup_metrics ORDER BY model_id, subgroup_var, subgroup_value")
        .catch(() => db.rows("SELECT model_id, subgroup_var, subgroup_value, n, auroc FROM ml_subgroup_metrics ORDER BY 1, 2, 3")))
        .map((r) => ({ ...r, auroc: round(r.auroc, 3) }));
      out.subgroups = { dataset_id: t.datasets.register("get_model_metrics", sg), rows: sg };
    }
    return out;
  },
});
