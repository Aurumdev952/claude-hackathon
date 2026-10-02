/** Care-coordination aggregates for the ministry (docs/contracts/v3-loop.md §4.2, §4.4, §5). Cells under 5 arrive as
 * null with a `<field>_label: "<5"`. Query keys start with "quality" so a WebSocket refresh after a sim tick refetches. */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { get, qs } from "@/api/client";

export const FUNNEL_STEPS = ["flagged", "approved", "notified", "attended", "endoscopy", "cancer_found", "early_stage"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const STEP_LABEL: Record<FunnelStep, string> = {
  flagged: "Flagged", approved: "Approved by a doctor", notified: "Patient notified", attended: "Attended", endoscopy: "Endoscopy done",
  cancer_found: "Cancer found", early_stage: "Found at an early stage",
};
export type Funnel = {
  steps: { step: FunnelStep; n: number | null; n_label?: string }[];
  by_district: (Record<string, number | string | null> & { district_code: string })[];
  by_pathway: (Record<string, number | string | null> & { pathway: string })[];
};
export type AdherenceDim = "channel" | "distance" | "sex" | "age" | "pathway" | "district";
export type AdherenceRow = { dim: string; level: string; n: number | null; adhered: number | null; rate: number | null; median_days: number | null; n_label?: string; adhered_label?: string };
export type ImpactRow = { route: "care_pathway" | "usual"; n: number | null; early_stage_pct: number | null; surv_1y: number | null; n_surv_eligible: number | null; n_label?: string; note?: string };
export type ChwRow = { district_code: string; district_name: string | null; open_visits: number | null; overdue: number | null; completed_30d: number | null; open_visits_label?: string; overdue_label?: string; completed_30d_label?: string };
export type Pathway = { id: string; name: string };

export function useFunnel(p: { from?: string | null; to?: string | null; district?: string | null }) {
  const params = { from: p.from ?? undefined, to: p.to ?? undefined, district: p.district ?? undefined };
  return useQuery({ queryKey: ["quality", "care", "funnel", params], queryFn: () => get<Funnel>(`/care/funnel${qs(params)}`), placeholderData: keepPreviousData });
}
export const useAdherence = (by: AdherenceDim) =>
  useQuery({ queryKey: ["quality", "care", "adherence", by], queryFn: () => get<AdherenceRow[]>(`/care/adherence${qs({ by })}`), placeholderData: keepPreviousData });
export const useImpact = () => useQuery({ queryKey: ["quality", "care", "impact"], queryFn: () => get<ImpactRow[]>("/care/impact") });
export const useChw = () => useQuery({ queryKey: ["quality", "care", "chw"], queryFn: () => get<ChwRow[]>("/care/chw-workload") });
export const usePathways = () => useQuery({ queryKey: ["quality", "care", "pathways"], queryFn: () => get<Pathway[]>("/care/pathways"), staleTime: Infinity });

/** Channel codes as people say them. */
export const CHANNEL_LABEL: Record<string, string> = {
  APP: "App only", SMS: "SMS only", "APP+SMS": "App and SMS", CHW: "Community health worker", "APP+CHW": "App and CHW visit",
  "SMS+CHW": "SMS and CHW visit", "APP+SMS+CHW": "App, SMS and CHW visit", NONE: "No reminders",
};
export const levelLabel = (dim: AdherenceDim, level: string, pathways?: Pathway[]) =>
  dim === "channel" ? CHANNEL_LABEL[level] ?? level.replace(/\+/g, " and ")
  : dim === "sex" ? (level === "F" ? "Women" : level === "M" ? "Men" : level)
  : dim === "age" ? `Aged ${level}`
  : dim === "pathway" ? pathways?.find((p) => p.id === level)?.name ?? level
  : level;
