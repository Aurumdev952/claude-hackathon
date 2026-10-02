import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@heroui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { BellOff, Check, ClipboardCheck, Send, X } from "lucide-react";
import { patch } from "@/api/client";
import type { Alert } from "@/api/types";
import { InfoHint } from "@/components/ui";
import { date } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { BandMark } from "./BandMark";
import { ApprovePlanModal, type ApproveTarget } from "./ApprovePlanModal";

const TRIGGER: Record<string, string> = {
  RISK_BAND_HIGH: "High risk band", ALARM_NO_SCOPE_90D: "Alarm sign, no scope in 90 days", HB_DROP: "Haemoglobin drop", HP_POS_UNTREATED: "H. pylori untreated",
  CARE_OVERDUE: "Care plan step overdue",
};
/** Alert triggers that map to a care pathway (CARE_OVERDUE is about an existing plan, so it has none). */
export const PLANNABLE = new Set(["RISK_BAND_HIGH", "ALARM_NO_SCOPE_90D", "HB_DROP", "HP_POS_UNTREATED"]);
export const triggerLabel = (t: string) => TRIGGER[t] ?? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, " ");

const statusLabel = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** Severity as a dot + text (HIGH solid dot, MEDIUM ring). */
export function SeverityMark({ severity }: { severity: string }) {
  return <BandMark level={severity === "HIGH" ? "high" : "medium"} />;
}

const btn = "h-8 min-w-0 px-3 gap-1.5 text-[13px] font-medium text-ink bg-transparent data-[hover=true]:bg-tile-hover";

/** Alerts with the doctor's actions (Acknowledge / Mark referred / Dismiss with a reason). `variant` rows = plain rows
 * split by hairlines (a card body); tiles = grey nested tiles (a two-column grid, `columns` = 2). Summary and notes live
 * behind ⓘ; the suggested action stays as one muted line. */
export function AlertActions({ alerts, columns = 1, variant, isCase }: { alerts: Alert[]; columns?: 1 | 2; variant?: "rows" | "tiles"; isCase?: boolean }) {
  const qc = useQueryClient();
  const [planFor, setPlanFor] = useState<ApproveTarget | null>(null);
  const reduce = useReducedMotion();
  const look = variant ?? (columns === 2 ? "tiles" : "rows");
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason?: string }) => patch(`/alerts/${id}`, { status, reason, note: reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alerts"] }); qc.invalidateQueries({ queryKey: ["patients"] }); setDismissing(null); setReason(""); },
  });
  if (!alerts.length) return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-label text-muted">
      <span className="w-10 h-10 rounded-full border border-hairline text-muted grid place-items-center" aria-hidden><BellOff size={17} /></span>
      No alerts for this patient
    </div>
  );
  const approve = (a: Alert) => setPlanFor({ patientId: a.patient_id, alertId: a.alert_id, trigger: a.trigger, isCase,
                                             label: <>{a.name} <span className="tabular">{a.display_id}</span><span className="ml-3">{triggerLabel(a.trigger)}</span></> });
  const listCls = look === "tiles" ? `grid gap-2.5 ${columns === 2 ? "sm:grid-cols-2" : "grid-cols-1"}` : "flex flex-col divide-y divide-hairline -my-1";
  const itemCls = look === "tiles" ? "rounded-tile bg-tile p-4 min-w-0" : "py-4 first:pt-1 last:pb-1 min-w-0";
  return (
    <>
    <motion.ul className={listCls} variants={stagger(0.05)} initial={reduce ? false : "hidden"} animate="show">
      {alerts.map((a) => {
        const open = a.status !== "DISMISSED" && a.status !== "REFERRED";
        const label = triggerLabel(a.trigger);
        return (
          <motion.li key={a.alert_id} variants={itemEnter} layout="position" className={itemCls}>
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex items-center gap-0.5 min-w-0 flex-1">
                <h3 className="text-[15px] leading-5 font-semibold text-ink truncate">{label}</h3>
                <InfoHint mode="popover" size={13} title={label} label={`About ${label}`} className="!w-6 !h-6 !min-w-6"
                          about={<>{a.summary}<span className="block mt-1.5 font-medium">{a.suggested_action}</span></>}
                          notes={<>Raised {date(a.created_at)}{a.note ? <span className="block">Note: {a.note}</span> : null}</>} />
              </div>
              <SeverityMark severity={a.severity} />
            </div>
            <p className="text-label font-normal text-muted mt-0.5 line-clamp-1" title={a.suggested_action}>{a.suggested_action}</p>
            <div className="flex items-center gap-1 mt-2.5 min-h-8">
              {open && (
                <div className={`flex flex-wrap items-center gap-1 ${PLANNABLE.has(a.trigger) ? "" : "-ml-3"}`}>
                  {PLANNABLE.has(a.trigger) && (
                    <Button size="sm" radius="full" className="h-8 min-w-0 px-3.5 gap-1.5 text-[13px] font-semibold bg-ink text-ink-on mr-1"
                            startContent={<ClipboardCheck size={14} aria-hidden />} onPress={() => approve(a)}>Approve & plan</Button>
                  )}
                  {a.status === "NEW" && <Button size="sm" radius="full" variant="light" className={btn} startContent={<Check size={14} aria-hidden />}
                                                 isDisabled={m.isPending} onPress={() => m.mutate({ id: a.alert_id, status: "ACKNOWLEDGED" })}>Acknowledge</Button>}
                  <Button size="sm" radius="full" variant="light" className={btn} startContent={<Send size={13} aria-hidden />}
                          isDisabled={m.isPending} onPress={() => m.mutate({ id: a.alert_id, status: "REFERRED" })}>Mark referred</Button>
                  <Button size="sm" radius="full" variant="light" className={`${btn} !text-muted`} startContent={<X size={14} aria-hidden />}
                          onPress={() => setDismissing(dismissing === a.alert_id ? null : a.alert_id)}>Dismiss</Button>
                </div>
              )}
              <span className="flex-1" />
              <span className="text-micro text-muted">{statusLabel(a.status)}</span>
            </div>
            <AnimatePresence initial={false}>
              {dismissing === a.alert_id && (
                <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                             className="flex gap-2 mt-2 overflow-hidden p-0.5" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) m.mutate({ id: a.alert_id, status: "DISMISSED", reason }); }}>
                  <Input size="sm" radius="full" aria-label="Dismiss reason" placeholder="Reason (required)" value={reason} onValueChange={setReason} autoFocus
                         classNames={{ inputWrapper: `${look === "tiles" ? "bg-surface data-[hover=true]:bg-surface group-data-[focus=true]:bg-surface" : "bg-tile data-[hover=true]:bg-tile-hover group-data-[focus=true]:bg-tile"} shadow-none h-9 min-h-9` }} />
                  <Button size="sm" radius="full" type="submit" className="h-9 px-4 text-[13px] font-semibold bg-ink text-ink-on" isDisabled={!reason.trim()}>Confirm</Button>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.li>
        );
      })}
    </motion.ul>
    <ApprovePlanModal target={planFor} isOpen={!!planFor} onOpenChange={(o) => { if (!o) setPlanFor(null); }} />
    </>
  );
}
