import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@heroui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { BellOff, Check, Send, X } from "lucide-react";
import { patch } from "@/api/client";
import type { Alert } from "@/api/types";
import { InfoHint, StatusChip } from "@/components/ui";
import { SeverityChip } from "@/components/ui/Status";
import { date } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";

const TRIGGER: Record<string, string> = {
  RISK_BAND_HIGH: "High risk band", ALARM_NO_SCOPE_90D: "Alarm sign, no scope in 90 days", HB_DROP: "Haemoglobin drop", HP_POS_UNTREATED: "H. pylori untreated",
};
export const triggerLabel = (t: string) => TRIGGER[t] ?? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, " ");

const STATUS_KIND = { NEW: "info", ACKNOWLEDGED: "neutral", REFERRED: "good", DISMISSED: "neutral" } as const;
const statusLabel = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

const btn = "h-8 min-w-0 px-3 text-xs font-medium bg-surface border border-border text-fg data-[hover=true]:bg-surface-2";

/** Alert cards with the doctor's actions (Acknowledge / Mark referred / Dismiss with a reason). Summary + action text live
 * behind ⓘ; the suggested action stays as one line. `columns` = 2 lays the cards out in two columns. */
export function AlertActions({ alerts, columns = 1 }: { alerts: Alert[]; columns?: 1 | 2 }) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason?: string }) => patch(`/alerts/${id}`, { status, reason, note: reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alerts"] }); qc.invalidateQueries({ queryKey: ["patients"] }); setDismissing(null); setReason(""); },
  });
  if (!alerts.length) return (
    <div className="flex flex-col items-center justify-center gap-2 py-6 text-label text-fg-muted">
      <span className="w-10 h-10 rounded-full bg-success/10 text-tone-success grid place-items-center" aria-hidden><BellOff size={17} /></span>
      No alerts for this patient
    </div>
  );
  return (
    <motion.ul className={`grid gap-2.5 ${columns === 2 ? "sm:grid-cols-2" : "grid-cols-1"}`} variants={stagger(0.05)} initial={reduce ? false : "hidden"} animate="show">
      {alerts.map((a) => {
        const open = a.status !== "DISMISSED" && a.status !== "REFERRED";
        return (
          <motion.li key={a.alert_id} variants={itemEnter} layout className="rounded-tile border border-border bg-surface-2/70 p-3 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <SeverityChip severity={a.severity} />
              <span className="text-[13px] font-semibold text-fg truncate">{triggerLabel(a.trigger)}</span>
              <InfoHint mode="popover" size={13} title={triggerLabel(a.trigger)} label={`About ${triggerLabel(a.trigger)}`}
                        about={<>{a.summary}<span className="block mt-1.5 font-medium text-tone-warning">{a.suggested_action}</span></>}
                        notes={`Raised ${date(a.created_at)}${a.note ? ` · note: ${a.note}` : ""}`} />
              <span className="flex-1" />
              <StatusChip status={STATUS_KIND[a.status as keyof typeof STATUS_KIND] ?? "neutral"} label={statusLabel(a.status)} icon={false} />
            </div>
            <p className="text-micro text-tone-warning mt-1 line-clamp-1" title={a.suggested_action}>{a.suggested_action}</p>
            {open && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {a.status === "NEW" && <Button size="sm" radius="full" variant="flat" className={btn} startContent={<Check size={13} aria-hidden />}
                                               isDisabled={m.isPending} onPress={() => m.mutate({ id: a.alert_id, status: "ACKNOWLEDGED" })}>Acknowledge</Button>}
                <Button size="sm" radius="full" variant="flat" className={btn} startContent={<Send size={13} aria-hidden />}
                        isDisabled={m.isPending} onPress={() => m.mutate({ id: a.alert_id, status: "REFERRED" })}>Mark referred</Button>
                <Button size="sm" radius="full" variant="flat" className={btn} startContent={<X size={13} aria-hidden />}
                        onPress={() => setDismissing(dismissing === a.alert_id ? null : a.alert_id)}>Dismiss</Button>
              </div>
            )}
            <AnimatePresence initial={false}>
              {dismissing === a.alert_id && (
                <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                             className="flex gap-1.5 mt-2 overflow-hidden" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) m.mutate({ id: a.alert_id, status: "DISMISSED", reason }); }}>
                  <Input size="sm" radius="full" aria-label="Dismiss reason" placeholder="Reason (required)" value={reason} onValueChange={setReason} autoFocus
                         classNames={{ inputWrapper: "bg-surface border border-border h-8 min-h-8" }} />
                  <Button size="sm" radius="full" color="primary" type="submit" className="h-8 px-3 text-xs" isDisabled={!reason.trim()}>Confirm</Button>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}
