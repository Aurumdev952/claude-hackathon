import type { Alert, Reason } from "@/api/types";

/** Payload of GET /patients/{id}/case (SPEC v1.1 §14 addendum). */
export type CaseCondition = {
  concept_id: number; label: string; category: "diagnosis" | "symptom" | "lab" | "procedure"; organ_ids: string[]; weight: number;
  region: string | null; first_ts: string; last_ts: string; count: number; certainty: string | null; is_alarm: boolean;
  months_since_last: number; severity: number;
};
export type CaseOrgan = { organ_id: string; label: string; score: number; conditions: string[] };
export type SeriesPoint = { ts: string; value: number; abnormal: boolean };
export type Measure = {
  concept_id: number; name: string; unit: string | null; latest: number | string; latest_ts: string; abnormal: boolean;
  change_pct_12m?: number | null; slope_per_month?: number | null; n: number; series: SeriesPoint[]; coded?: boolean;
};
export type ReplayEvent = {
  ts: string; event_type: string; concept_id: number; label: string | null; value_num: number | null; value_text: string | null;
  unit: string | null; is_abnormal: boolean; organ_ids: string[]; weight: number; region: string | null; facility: string | null;
};
export type Spread = { t_level: number; lymph_node_groups: number; metastasis_sites: string[]; region: string };
export type Tumour = {
  patient_id: number; lesion_location: string | null; lesion_size_mm: number | null; endo_date: string | null; t_stage: string | null;
  n_stage: string | null; m_stage: string | null; stage_group: string | null; lauren: string | null; grade: string | null;
  treatment_intent: string | null; spread: Spread; [k: string]: unknown;
};
export type CaseRisk = {
  risk_band: string | null; ensemble_prob: number; t1_score: number; t1_band: string; t2_prob: number | null; t3_prob: number | null;
  top_reasons: Reason[]; [k: string]: unknown;
};
export type CaseData = {
  header: {
    patient_id: number; display_id: string; name: string; sex: string; age: number; district_code: string; district_name?: string;
    province?: string; home_facility_name?: string; is_case: boolean; case_status: string | null; dx_date?: string | null;
    death_date?: string | null; [k: string]: unknown;
  };
  risk: CaseRisk | null; alerts: Alert[]; tumour: Tumour | null;
  suspected: { organ_id: string; region: string; score: number; region_scores: Record<string, number> } | null;
  conditions: CaseCondition[]; organs: CaseOrgan[]; vitals: Measure[]; labs: Measure[];
  medications: {
    ppi_courses_24m: number; eradication_courses: number; iron: number; antimalarial: number; anthelminthic: number;
    recent: { ts: string; label: string; days: number | null; course_type: string }[];
  };
  endoscopies: { ts: string; impression: string; location: string | null; size_mm: number | null }[];
  events: ReplayEvent[]; window: { start: string; end: string; months: number };
  notes: { note_id?: number; note: string; created_at: string }[];
  body_map: { organs: Record<string, { label: string; system: string }>; stomach_regions: string[] };
  /** v3: curative surgery from the journey (GET /patients/{id}/journey), merged in by CaseAnalysis. */
  surgery?: { date: string; kind: "gastrectomy" } | null;
};

/** What the 3D scene renders at one moment in time (current state or a replay frame). */
export type BodyState = {
  organScores: Record<string, number>;          // 0..1 glow per organ
  flashes: Record<string, number>;              // recent event flash per organ (replay)
  pulse: number | null; rr: number | null; sbp: number | null; temp: number | null; hb: number | null;
  weightChangePct: number | null;               // vs the start of the window -> body thinning
  lesion: { region: string; level: number; nodes: number; mets: string[]; suspected: boolean; sizeMm: number | null } | null;
  /** v3 post-gastrectomy: 0 before surgery, ramps to 1 over the days after it (the stomach is ghosted). */
  resected?: number;
  /** months since the surgery (null before or without surgery) */
  recoveryMonths?: number | null;
};
