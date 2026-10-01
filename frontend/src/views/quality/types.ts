export type Tier = "low" | "medium" | "high";
export type OutlierFlag = "LOW_OUTLIER" | "low" | "within" | "high" | "HIGH_OUTLIER" | "LOW_VOLUME";

export type FacilityQ = {
  location_id: number; name: string; district_code: string; province_code: string; facility_type: string;
  tier: Tier | null; derived_tier: Tier | null; lat: number | null; lon: number | null;
  n_dyspepsia: number; n_hp_tested: number; hp_test_rate: number | null;
  funnel_lower95: number; funnel_upper95: number; funnel_lower998: number; funnel_upper998: number;
  outlier_flag: OutlierFlag; target_rate: number; n_cases: number; pct_stage4: number | null; median_diag_interval: number | null;
};

export type StageTierRow = { facility_tier: string; stage_group: string; n: number; pct: number; pct_known: number | null };
export type ChiSquare = { chi2: number; dof: number; p: number } | null;

export type KmRow = { group_var: string; group_value: string; t_days: number; surv: number; lci: number; uci: number; n_at_risk: number; n_events: number };
export type SurvSummary = { group_var: string; group_value: string; n: number; surv_1y: number; surv_2y: number; median_surv_days: number | null; logrank_p: number | null };
export type CoxRow = { model_id: string; term: string; hr: number; lci: number; uci: number; p: number };

export const TIERS: Tier[] = ["low", "medium", "high"];
export const TIER_LABEL: Record<string, string> = { low: "Low testing", medium: "Medium testing", high: "High testing", unknown: "No prior GI visit" };
export const PROVINCE: Record<string, string> = { KGL: "Kigali", NOR: "Northern", SOU: "Southern", EAS: "Eastern", WES: "Western" };
export const FACILITY_TYPE: Record<string, string> = { HEALTH_CENTRE: "Health centre", DISTRICT: "District hospital", PROVINCIAL: "Provincial hospital", REFERRAL: "Referral hospital" };
