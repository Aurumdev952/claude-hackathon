import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLive } from "@/state/live";
import { useRole } from "@/state/role";

/** WebSocket push (SPEC §14.3): invalidate only the query keys named in `changed`. */
export function useLiveSocket() {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: number | undefined;
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
      ws.onopen = () => useLive.getState().update({ connected: true });
      ws.onclose = () => { useLive.getState().update({ connected: false }); if (!stop) retry = window.setTimeout(open, 3000); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "refresh") {
          useLive.getState().update({ runId: m.run_id, simTime: m.sim_time, lastRefresh: Date.now() });
          const changed: string[] = m.changed ?? [];
          qc.invalidateQueries({ predicate: (q) => changed.length === 0 || changed.includes(String(q.queryKey[0])) || q.queryKey[0] === "status" });
        } else if (m.type === "alert_new") {
          const { role, facilityId } = useRole.getState();
          if (role === "doctor" && facilityId === m.facility_id) useLive.getState().toast("New high-risk alert for one of your patients", "alert");
        } else if (m.type === "sim_tick") {
          useLive.getState().update({ simTime: m.sim_time });
        }
      };
    };
    open();
    return () => { stop = true; window.clearTimeout(retry); ws?.close(); };
  }, [qc]);
}
