export type Metrics = {
  model_id: string; tier: number; split: "val" | "test";
  auroc: number | null; auprc: number | null; brier: number | null; ece: number | null;
  sens_at_spec90: number | null; ppv_at_top2pct: number | null; nns_at_top2pct: number | null;
  n_pos: number; n_neg: number; high_threshold: number | null;
  median_lead_time_days?: number | null; pct_flagged_ge_90d?: number | null; pct_flagged_ever?: number | null;
};
export type RegistryModel = {
  model_id: string; tier: number; version: string; trained_at: string; train_window: string; features_hash: string;
  params_json: any; artefact_path: string; is_active: boolean; metrics: Partial<Record<"val" | "test", Metrics>>;
};
export type Thresholds = { high_cut: number; medium_cut: number; version: string; hiv_shap_rank: number } | null;
export type CurvePt = { x: number; y: number };
export type Curves = Partial<Record<"roc" | "pr" | "calibration" | "lead_time", CurvePt[]>>;
export type Importance = { feature: string; mean_abs_shap: number; rank: number };
export type Subgroup = { model_id: string; subgroup_var: string; subgroup_value: string; auroc: number; sens: number; ppv: number | null; n: number; n_pos: number };

/** Model identity: colour slot follows the tier (entity), never its rank. Ensemble takes slot 4. */
export const TIER_META: Record<number, { slot: number; name: string; short: string; blurb: string }> = {
  1: { slot: 0, name: "Points score", short: "Points", blurb: "Transparent tally of warning signs — works on paper at any health centre." },
  2: { slot: 1, name: "XGBoost", short: "XGBoost", blurb: "Gradient-boosted trees on ~80 engineered features, explained with SHAP." },
  3: { slot: 2, name: "Sequence model", short: "Sequence", blurb: "Recurrent network reading the patient's coded timeline event by event." },
  0: { slot: 3, name: "Ensemble", short: "Ensemble", blurb: "Mean of XGBoost and sequence probabilities — drives the final risk band." },
};
