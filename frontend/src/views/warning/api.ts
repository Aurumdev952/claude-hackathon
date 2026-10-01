import { useQuery } from "@tanstack/react-query";
import { get, qs } from "@/api/client";

export type FunnelRow = { pathway: "hp" | "endoscopy"; stage: string; year: string; province: string; n: number; pct_of_prev: number | null };
export type CurveRow = { month_before: number; metric: string; group: "case" | "control"; value: number | null; lci: number | null; uci: number | null; n: number };
export type OrRow = { signal: string; or: number; lci: number; uci: number; p: number; pct_cases: number; pct_controls: number };
export type SummaryRow = { metric: string; case: number | null; control: number | null };
export type IntervalRow = { group_var: string; group: string; median_days: number; q1: number; q3: number; n: number; p_value: number | null };
export type JourneyRow = { case_index: number; month_before: number; kind: string; is_abnormal: boolean | null; stage_group: string };

/** Query keys start with "warning" so the WS refresh (changed: ["warning"]) invalidates them. */
export const useFunnel = (province: string) =>
  useQuery({ queryKey: ["warning", "funnel", province], queryFn: () => get<FunnelRow[]>(`/cohort/funnel${qs({ year: "ALL", province })}`), staleTime: 60_000 });
export const useCurves = () => useQuery({ queryKey: ["warning", "curves"], queryFn: () => get<CurveRow[]>("/warning-signs/curves"), staleTime: 60_000 });
export const useOr = () => useQuery({ queryKey: ["warning", "or"], queryFn: () => get<OrRow[]>("/warning-signs/or"), staleTime: 60_000 });
export const useIntervals = () => useQuery({ queryKey: ["warning", "diag-interval"], queryFn: () => get<IntervalRow[]>("/diag-interval"), staleTime: 60_000 });
export const useJourney = () => useQuery({ queryKey: ["warning", "journey"], queryFn: () => get<JourneyRow[]>("/warning-signs/journey"), staleTime: 60_000 });

export const DAYS_PER_MONTH = 30.44;
export const PROVINCES: Record<string, string> = { KGL: "Kigali", NOR: "Northern", SOU: "Southern", EAS: "Eastern", WES: "Western" };
export const MALARIA_ENDEMIC = ["EAS", "SOU"];

export const SIGNAL_LABEL: Record<string, string> = {
  gi_visits_ge3_12m: "≥3 GI visits in 12 months",
  hb_drop_ge1_5: "Hb drop ≥1.5 g/dL",
  ppi_courses_ge2_12m: "≥2 PPI courses in 12 months",
  weight_loss_ge5pct_6m: "Weight loss ≥5% in 6 months",
  alarm_symptom_12m: "Alarm symptom in 12 months",
};

/** Event kinds in a fixed order -> fixed categorical slot (colour follows the kind). */
export const KINDS = [
  { id: "VISIT", label: "GI visit" },
  { id: "SYMPTOM", label: "Symptom recorded" },
  { id: "DRUG", label: "Prescription" },
  { id: "LAB", label: "Lab test" },
  { id: "HB", label: "Haemoglobin test" },
  { id: "ORDER", label: "Order / referral" },
  { id: "DIAGNOSIS", label: "Working diagnosis" },
] as const;
