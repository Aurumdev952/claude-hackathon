import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { useLive } from "@/state/live";
import { useRole } from "@/state/role";

export type PushNotification = { id: string; channel: string; title: string; body: string; created_sim: string };

/** Patient-app push queue (v3 §4.3 `notification`): the phone simulator and the PWA show each one as a banner. */
export const usePush = create<{
  banners: PushNotification[]; seq: number;
  push: (n: PushNotification) => void; shift: () => void;
}>((set) => ({
  banners: [], seq: 0,
  push: (n) => set((s) => (s.banners.some((b) => b.id === n.id) ? s : { banners: [...s.banners.slice(-2), n], seq: s.seq + 1 })),
  shift: () => set((s) => ({ banners: s.banners.slice(1) })),
}));

/** The subscription this client should hold for its role (contract §4.3), or null for broadcast-only. */
function subscription(): Record<string, unknown> | null {
  const { role, facilityId, patientId } = useRole.getState();
  if (role === "doctor" && facilityId) return { role: "doctor", facility_id: facilityId };
  if (role === "patient" && patientId) return { role: "patient", patient_id: patientId };
  return { role: "ministry" };
}

const ESCALATION_KINDS = new Set(["escalated", "chw_assigned"]);

/** WebSocket push (SPEC §14.3, v3 §4.3): invalidate only the query keys named in `changed`; subscribe to targeted care
 * events for the current role (re-subscribing when the role, facility or patient changes). */
export function useLiveSocket() {
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: number | undefined;
    let careTimer: number | undefined;
    // care events arrive in bursts (one per step / message): coalesce the refetch
    const refreshCare = () => {
      window.clearTimeout(careTimer);
      careTimer = window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["care"] });
        qc.invalidateQueries({ queryKey: ["me"] });
      }, 400);
    };
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        useLive.getState().update({ connected: true });
        const sub = subscription();
        if (sub) ws?.send(JSON.stringify({ subscribe: sub }));
      };
      ws.onclose = () => { useLive.getState().update({ connected: false }); if (!stop) retry = window.setTimeout(open, 3000); };
      ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "refresh") {
          useLive.getState().update({ runId: m.run_id, simTime: m.sim_time, lastRefresh: Date.now() });
          const changed: string[] = m.changed ?? [];
          qc.invalidateQueries({ predicate: (q) => changed.length === 0 || changed.includes(String(q.queryKey[0])) || q.queryKey[0] === "status" || q.queryKey[0] === "care" || q.queryKey[0] === "me" });
        } else if (m.type === "alert_new") {
          const { role, facilityId } = useRole.getState();
          if (role === "doctor" && facilityId === m.facility_id) useLive.getState().toast("New high-risk alert for one of your patients", "alert");
        } else if (m.type === "sim_tick") {
          useLive.getState().update({ simTime: m.sim_time });
        } else if (m.type === "care_update") {
          const { role, facilityId } = useRole.getState();
          if (role !== "doctor" || facilityId !== m.facility_id) return;
          refreshCare();
          if (ESCALATION_KINDS.has(String(m.kind))) {
            useLive.getState().toast(m.kind === "chw_assigned" ? "A care step is a week late: a community health worker visit was arranged" : "A care step is two weeks late and needs your follow-up", "alert");
          }
        } else if (m.type === "notification") {
          const { role, patientId } = useRole.getState();
          if (role !== "patient" || patientId !== m.patient_id) return;
          if (m.notification) usePush.getState().push(m.notification);
          refreshCare();
        } else if (m.type === "sim_job") {
          if (m.status === "done") for (const k of ["care", "me", "status", "alerts", "patients"]) qc.invalidateQueries({ queryKey: [k] });
        }
      };
    };
    open();
    // re-subscribe when the role, facility or patient changes (no reconnect needed)
    const unsub = useRole.subscribe((s, prev) => {
      if (s.role === prev.role && s.facilityId === prev.facilityId && s.patientId === prev.patientId) return;
      const sub = subscription();
      if (sub && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ subscribe: sub }));
    });
    return () => { stop = true; unsub(); window.clearTimeout(retry); window.clearTimeout(careTimer); ws?.close(); };
  }, [qc]);
}
