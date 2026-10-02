/** Care coordination types, labels and queries shared by the doctor workspace, the case screen and the patient app
 * (docs/contracts/v3-loop.md §4.2). Query keys start with "care" (or "patients" for patient-scoped reads) so the WS
 * `care_update` handler and mutations can invalidate them in one call. */
import { useQuery } from "@tanstack/react-query";
import { get } from "@/api/client";

export type Channel = "APP" | "SMS" | "CHW";
export type TaskStatus = "SCHEDULED" | "DUE" | "NOTIFIED" | "COMPLETED" | "OVERDUE" | "ESCALATED" | "CANCELLED" | "DECLINED";
export type PlanStatus = "ACTIVE" | "COMPLETED" | "CANCELLED" | "ESCALATED";

export type PathwayTask = { type: string; title: string; due_days: number | null; repeat?: unknown; start?: boolean; patient_facing?: boolean };
export type Pathway = { id: string; name: string; description: string; triggers: string[]; tasks: PathwayTask[]; default_channels: Channel[] };
export type Evidence = { table: string; id: number; concept_id: number; value: unknown; date: string; encounter_id?: number } | null;
export type CareTask = {
  id: string; plan_id: string; patient_id?: number; seq: number; type: string; title: string; status: TaskStatus;
  opens_at: string | null; due_at: string | null; completed_at: string | null; evidence?: Evidence; result?: string | null;
  reminders?: number; escalation_level?: number; occurrence?: number | null; patient_facing?: boolean;
};
export type CareEvent = {
  id: number; plan_id?: string; task_id: string | null; kind: string; actor: string; sim_time: string;
  detail?: Record<string, any> | null; wall_time?: string;
};
export type CarePlan = {
  id: string; patient_id: number; display_id: string; facility_id: number; pathway: string; pathway_name?: string; status: PlanStatus;
  approved_at: string; channels: Channel[]; due_override: string | null; target_facility_id: number | null; note?: string | null;
  trigger?: string | null; created_sim: string; closed_sim: string | null; tasks: CareTask[]; events: CareEvent[];
};
export type WorkItem = {
  task: CareTask & { overdue_days: number; last_reminder_sim: string | null };
  plan: { id: string; pathway: string; status: PlanStatus; approved_at: string; facility_id: number; target_facility_id: number | null };
  patient: { patient_id: number; display_id: string; given_name?: string; family_name?: string; age?: number; sex?: string };
  p_adhere: number; priority: number;
};
export type Point = { date: string; value: number };
export type JourneyPhase = { phase: string; label?: string; start: string | null; end: string | null; status: "done" | "current" | "upcoming" | "missed"; milestones: { date: string; label: string; kind: string }[] };
export type Journey = {
  phases: JourneyPhase[]; source?: string;
  recovery: null | {
    series: { weight: Point[]; hb: Point[]; b12: Point[]; albumin: Point[]; ecog: Point[] };
    chemo: { done: number | null; planned: number | null }; next_visit: string | null; missed_visits: number | null; recurrence: string | null;
    summary?: { as_of?: string; dx_date?: string; intent?: string | null; gastrectomy?: boolean | null; weight_base?: number | null; weight_last?: number | null;
      weight_change_pct?: number | null; hb_last?: number | null; b12_last?: number | null; albumin_last?: number | null; ecog_last?: number | null };
  };
};
export type PathwaysEnvelope = { data: Pathway[]; trigger_pathway?: Record<string, string | null>; sources?: Record<string, string>; ladder?: unknown[] };

export const CHANNELS: { key: Channel; label: string; long: string }[] = [
  { key: "APP", label: "App", long: "Patient app" },
  { key: "SMS", label: "SMS", long: "SMS" },
  { key: "CHW", label: "Health worker", long: "Community health worker" },
];
export const channelLabel = (c: string) => CHANNELS.find((x) => x.key === c)?.long ?? c;

export const PATHWAY_NAME: Record<string, string> = {
  ENDOSCOPY_REFERRAL: "Endoscopy referral", HP_TEST_AND_TREAT: "H. pylori test and treat", ANAEMIA_WORKUP: "Anaemia work-up",
  ONCOLOGY_TREATMENT: "Specialist treatment", SURVIVORSHIP: "Survivorship follow-up", PALLIATIVE_SUPPORT: "Comfort and support care",
};

export const pathwayName = (p: { pathway: string; pathway_name?: string }) => p.pathway_name ?? PATHWAY_NAME[p.pathway] ?? p.pathway;

/** Pathways a doctor may start without an alert (diagnosed patients). */
export const DX_PATHWAYS = ["ONCOLOGY_TREATMENT", "SURVIVORSHIP", "PALLIATIVE_SUPPORT"];

export const TASK_STATUS: Record<string, { label: string; tone: "done" | "open" | "late" | "quiet" }> = {
  SCHEDULED: { label: "Scheduled", tone: "quiet" }, DUE: { label: "Due", tone: "open" }, NOTIFIED: { label: "Reminded", tone: "open" },
  COMPLETED: { label: "Done", tone: "done" }, OVERDUE: { label: "Overdue", tone: "late" }, ESCALATED: { label: "Escalated", tone: "late" },
  CANCELLED: { label: "Cancelled", tone: "quiet" }, DECLINED: { label: "Declined", tone: "quiet" },
};
export const taskStatus = (s: string) => TASK_STATUS[s] ?? { label: s.charAt(0) + s.slice(1).toLowerCase(), tone: "quiet" as const };
export const PLAN_STATUS: Record<string, string> = { ACTIVE: "Active", COMPLETED: "Completed", CANCELLED: "Cancelled", ESCALATED: "Escalated" };
export const ESCALATION = ["No escalation", "SMS reminder", "Health worker visit", "Doctor follow-up"];

/** Plain-words labels for care events (doctor history and the patient-app event log). */
export function eventLabel(e: CareEvent, taskTitle?: string, audience: "doctor" | "patient" = "doctor"): string {
  const t = taskTitle ? `: ${taskTitle}` : "";
  const d = e.detail ?? {};
  switch (e.kind) {
    case "PLAN_CREATED": return audience === "patient" ? "Your doctor approved a care plan" : "Plan approved";
    case "TASK_CREATED": return `Step added${t}`;
    case "TASK_OPENED": return `Step is now due${t}`;
    case "NOTIFIED": return `${channelLabel(d.channel ?? "APP")} message sent${d.stage ? ` (${String(d.stage)})` : ""}`;
    case "COMPLETED": return `Step completed${t}`;
    case "OVERDUE": return `Step overdue${t}`;
    case "ESCALATED": return `Escalated${d.level ? ` to ${ESCALATION[d.level]?.toLowerCase() ?? `level ${d.level}`}` : ""}${t}`;
    case "CHW_ASSIGNED": return "Community health worker visit arranged";
    case "RESCHEDULED": return `New due date${t}`;
    case "DECLINED": return `Declined${t}`;
    case "PATIENT_CONFIRMED": return audience === "patient" ? `You said you have booked${t}` : `Patient says booked${t}`;
    case "PATIENT_ACTED": return `Patient opened the message${t}`;
    case "CHECKIN": return "Weekly check-in sent";
    case "DOSE": return "Medicine dose recorded";
    case "MISSED": return `Missed${t}`;
    case "PLAN_COMPLETED": return "Plan completed";
    case "PLAN_CANCELLED": return "Plan cancelled";
    case "NEXT_PATHWAY_SUGGESTED": return `Next plan suggested: ${PATHWAY_NAME[d.pathway] ?? String(d.pathway ?? "").toLowerCase().replace(/_/g, " ")}`;
    default: return `${e.kind.charAt(0)}${e.kind.slice(1).toLowerCase().replace(/_/g, " ")}${t}`;
  }
}

/** ISO sim time without the fake end-of-day seconds: "2026-06-30T23:59:59" -> Date at that day. */
export const simDate = (s: string | null | undefined) => (s ? new Date(s.length <= 10 ? `${s}T12:00:00` : s) : null);
export const daysBetween = (a: string | null | undefined, b: string | null | undefined) => {
  const x = simDate(a), y = simDate(b);
  return x && y ? Math.round((y.getTime() - x.getTime()) / 86400_000) : null;
};

export function usePathways() {
  return useQuery({ queryKey: ["care", "pathways"], queryFn: () => get<Pathway[]>("/care/pathways") as Promise<PathwaysEnvelope & any>, staleTime: Infinity });
}
export function usePatientCare(patientId: number | null | undefined) {
  return useQuery({ queryKey: ["care", "patient", patientId], queryFn: () => get<{ plans: CarePlan[] }>(`/patients/${patientId}/care`), enabled: !!patientId });
}
export function useJourney(patientId: number | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["care", "journey", patientId], queryFn: () => get<Journey>(`/patients/${patientId}/journey`), enabled: !!patientId && enabled });
}

/** Open plans first, newest first. */
export const sortPlans = (plans: CarePlan[]) =>
  [...plans].sort((a, b) => Number(b.status === "ACTIVE" || b.status === "ESCALATED") - Number(a.status === "ACTIVE" || a.status === "ESCALATED") || b.approved_at.localeCompare(a.approved_at));
export const isOpenPlan = (p: CarePlan) => p.status === "ACTIVE" || p.status === "ESCALATED";
export const nextTask = (p: CarePlan) =>
  p.tasks.filter((t) => !["COMPLETED", "CANCELLED", "DECLINED"].includes(t.status)).sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""))[0] ?? null;

/** Gastrectomy date from the journey (treatment milestone), for the post-gastrectomy body state. */
export function gastrectomyDate(j: Journey | undefined | null): string | null {
  for (const p of j?.phases ?? []) for (const m of p.milestones) if (m.kind === "treatment" && /gastrectomy|operation/i.test(m.label)) return m.date;
  return null;
}
