/** Patient app data (contract §4.2, `X-Role: patient` + `X-Patient-Id`). Query keys start with "me" so the WS
 * `notification` handler can refresh every screen at once. The given name only ever lives in these responses. */
import { useQuery } from "@tanstack/react-query";
import { get } from "@/api/client";
import { useRole } from "@/state/role";
import type { CarePlan, Journey, JourneyPhase, Point } from "@/views/doctor/care";

export type Me = { patient_id: number; display_id: string; given_name: string | null; facility: { id: number; name: string | null }; chw: { name: string; phone: string } };
export type Note = {
  id: string; plan_id: string; task_id: string | null; channel: "APP" | "SMS"; template_key: string; title: string; body: string;
  created_sim: string; delivered_sim: string | null; read_sim: string | null; acted_sim: string | null; greeting?: string;
};
export type MyPlan = CarePlan & { target_facility_name?: string | null };
export type MyJourney = { phases: (JourneyPhase & { label: string })[]; recovery: null | { next_visit: string | null; treatment_cycles: { done: number | null; planned: number | null }; weight: Point[]; missed_visits: number | null } };
export type Dose = { id: string; course: string; taken: boolean; created_sim: string };
export type DemoPatient = { patient_id: number; display_id: string; plan_count: number; has_notifications: boolean };

const usePid = () => useRole((s) => (s.role === "patient" ? s.patientId : null));

export function useMe() {
  const pid = usePid();
  return useQuery({ queryKey: ["me", pid, "profile"], queryFn: () => get<Me>("/me"), enabled: !!pid, staleTime: 5 * 60_000 });
}
export function useNotes() {
  const pid = usePid();
  return useQuery({ queryKey: ["me", pid, "notifications"], queryFn: () => get<Note[]>("/me/notifications"), enabled: !!pid });
}
export function useMyPlan() {
  const pid = usePid();
  return useQuery({ queryKey: ["me", pid, "plan"], queryFn: () => get<{ plans: MyPlan[] }>("/me/plan"), enabled: !!pid });
}
export function useMyJourney() {
  const pid = usePid();
  return useQuery({ queryKey: ["me", pid, "journey"], queryFn: () => get<MyJourney>("/me/journey"), enabled: !!pid });
}
export function useDoses() {
  const pid = usePid();
  return useQuery({ queryKey: ["me", pid, "doses"], queryFn: () => get<Dose[]>("/me/doses"), enabled: !!pid });
}
export function useDemoPatients() {
  return useQuery({ queryKey: ["patient-app", "demo"], queryFn: () => get<DemoPatient[]>("/patient-app/demo-patients"), staleTime: 60_000 });
}

/** Medicine courses the tracker knows, keyed by the plan step that starts them. */
export const COURSES: Record<string, { id: string; name: string; days: number; how: string }> = {
  HP_TREATMENT: { id: "HP_ERADICATION", name: "Stomach infection medicine", days: 14, how: "Take all the tablets each day for 14 days, even if you feel better." },
  IRON_COURSE: { id: "IRON", name: "Iron tablets", days: 30, how: "One tablet a day with food. Dark stools are normal." },
};

const short = (n: string | null | undefined) => String(n ?? "").replace(" (Synthetic)", "");
export const facilityShort = short;

export const OPEN = new Set(["SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED"]);

/** Sim date helpers: the clock stores 23:59:59, so show dates only. */
export const day = (s: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }) =>
  s ? new Date(s.length <= 10 ? `${s}T12:00:00` : s).toLocaleDateString("en-GB", opts) : "";
export const weekday = (s: string | null | undefined) => day(s, { weekday: "long", day: "numeric", month: "long" });
export const sameDay = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 10) === b.slice(0, 10);
export const relDays = (from: string | null | undefined, to: string | null | undefined) => {
  if (!from || !to) return null;
  return Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86400_000);
};

export type { CarePlan, Journey };
