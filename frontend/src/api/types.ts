export type Kpis = {
  year: number; cases: number; cases_annualised: number; cases_delta_pct: number | null; national_asr: number | null;
  national_asr_ci: [number | null, number | null]; asr_delta: number | null; pct_stage_iv: number | null;
  median_diag_interval_days: number | null; hp_testing_rate_dyspepsia: number | null; young_onset_share: number | null;
  high_risk_awaiting_endoscopy: number | null; partial_year: boolean; years: number[];
  sparklines: Record<string, { year: number; value: number | null }[]>;
};
export type RateRow = {
  level: string; geo_code: string; period: string; period_type: string; sex: string; age_band: string; case_def: string;
  cases: number | null; cases_label?: string; population: number; crude_rate: number | null; asr: number | null; asr_lci: number | null;
  asr_uci: number | null; suppressed: boolean; coverage_flag: string | null; partial_year: boolean;
};
export type MapRow = RateRow & {
  name: string; lisa_quadrant?: string | null; sir?: number | null; gi_star_z?: number | null; eb_smoothed_rate?: number | null;
  hp_test_rate?: number | null; pct_stage4?: number | null; rank: number;
};
export type Segment = { segment_no: number; start_year: number; end_year: number; apc: number; apc_lci: number; apc_uci: number; significant: boolean };
export type Joinpoint = {
  series_id: string; observed: { year: number; asr: number | null; lci: number | null; uci: number | null; cases: number; coverage_flag?: string | null; partial_year?: boolean }[];
  fitted: { year: number; asr: number }[]; segments: Segment[]; aapc_last10: { value: number | null; lci: number | null; uci: number | null };
  n_joinpoints: number | null; events: { date: string; label: string; geo_code: string }[];
};
export type Reason = { feature: string; label: string; contribution: number; value?: number | null };
export type PatientRow = {
  patient_id: number; display_id: string; name: string; sex: string; age: number; district_code: string; is_case: boolean;
  case_status: string | null; dx_date: string | null; last_visit: string | null; risk_band: string | null; ensemble_prob: number | null;
  t1_score: number | null; top_reasons: Reason[]; open_alerts: number; rank_in_facility: number | null;
};
export type Alert = {
  alert_id: string; patient_id: number; facility_id: number; created_at: string; trigger: string; severity: string; status: string;
  summary: string; reasons: Reason[]; suggested_action: string; display_id: string; name: string; note?: string | null;
};
export type Insight = { id: string; title: string; body: string; severity: "info" | "warning" | "critical"; evidence: unknown[]; generated_by: string };
