import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Input } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarClock, Check, MoreHorizontal, X } from "lucide-react";
import { patch } from "@/api/client";
import { ErrorNote, usePortalContainer } from "@/components/ui";
import { useLive } from "@/state/live";
import type { CareTask } from "./care";

const OPEN = new Set(["SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED"]);
export const isOpenTask = (t: Pick<CareTask, "status">) => OPEN.has(t.status);

/** Doctor actions on one care task (PATCH /care/tasks/{id}): mark done, reschedule (new due date) or decline with a
 * reason. `form` renders the inline reschedule / decline form; put it under the row (it spans the full width). */
export function useTaskActions(task: Pick<CareTask, "id" | "title" | "status" | "due_at">, simNow?: string | null) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<null | "reschedule" | "decline">(null);
  const [reason, setReason] = useState("");
  const [due, setDue] = useState("");
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/care/tasks/${task.id}`, body),
    onSuccess: (_r, body) => {
      const verb = body.action === "complete" ? "Marked done" : body.action === "decline" ? "Declined" : "Rescheduled";
      useLive.getState().toast(`${verb}: ${task.title}`);
      qc.invalidateQueries({ queryKey: ["care"] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      setMode(null); setReason(""); setDue("");
    },
  });
  const portal = usePortalContainer();
  const minDue = simNow ? new Date(Date.parse(simNow) + 86400_000).toISOString().slice(0, 10) : undefined;
  const menu = isOpenTask(task) ? (
    <Dropdown placement="bottom-end" portalContainer={portal} classNames={{ content: "bg-surface shadow-float rounded-tile p-1.5 min-w-[200px] dark:border dark:border-hairline" }}>
      <DropdownTrigger>
        <Button isIconOnly size="sm" radius="full" variant="light" aria-label={`Actions for ${task.title}`} isLoading={m.isPending}
                className="min-w-8 w-8 h-8 text-ink data-[hover=true]:bg-tile-hover"><MoreHorizontal size={16} aria-hidden /></Button>
      </DropdownTrigger>
      <DropdownMenu aria-label={`Actions for ${task.title}`} onAction={(k) => {
        if (k === "complete") m.mutate({ action: "complete" });
        else setMode(k as "reschedule" | "decline");
      }}>
        <DropdownItem key="complete" startContent={<Check size={15} aria-hidden />} description="Done outside the EMR record">Mark done</DropdownItem>
        <DropdownItem key="reschedule" startContent={<CalendarClock size={15} aria-hidden />}>Reschedule</DropdownItem>
        <DropdownItem key="decline" startContent={<X size={15} aria-hidden />} description="Needs a reason">Decline</DropdownItem>
      </DropdownMenu>
    </Dropdown>
  ) : null;
  const form = (
    <AnimatePresence initial={false}>
      {mode && (
        <motion.form key={mode} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                     className="basis-full overflow-hidden" aria-label={mode === "decline" ? "Decline step" : "Reschedule step"}
                     onSubmit={(e) => {
                       e.preventDefault();
                       if (mode === "decline" && reason.trim()) m.mutate({ action: "decline", reason: reason.trim() });
                       if (mode === "reschedule" && due) m.mutate({ action: "reschedule", due_at: `${due}T23:59:59`, reason: reason.trim() || undefined });
                     }}>
          <div className="flex flex-wrap gap-2 pt-2 p-0.5">
            {mode === "reschedule" && (
              <input type="date" aria-label="New due date" value={due} min={minDue} onChange={(e) => setDue(e.target.value)} autoFocus
                     className="h-9 rounded-full bg-surface px-3.5 text-[13px] text-ink tabular outline-none border border-hairline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" />
            )}
            <Input size="sm" radius="full" aria-label={mode === "decline" ? "Reason for declining" : "Reason (optional)"} value={reason} onValueChange={setReason}
                   placeholder={mode === "decline" ? "Reason (required)" : "Reason (optional)"} autoFocus={mode === "decline"} className="flex-1 min-w-[160px]"
                   classNames={{ inputWrapper: "bg-surface data-[hover=true]:bg-surface group-data-[focus=true]:bg-surface shadow-none h-9 min-h-9 border border-hairline" }} />
            <Button size="sm" radius="full" type="submit" className="h-9 px-4 text-[13px] font-semibold bg-ink text-ink-on"
                    isDisabled={mode === "decline" ? !reason.trim() : !due} isLoading={m.isPending}>{mode === "decline" ? "Decline" : "Save date"}</Button>
            <Button size="sm" radius="full" variant="light" className="h-9 px-3 text-[13px] text-muted" onPress={() => setMode(null)}>Cancel</Button>
          </div>
          {m.error && <div className="pt-2"><ErrorNote error={m.error} /></div>}
        </motion.form>
      )}
    </AnimatePresence>
  );
  return { menu, form, pending: m.isPending, complete: () => m.mutate({ action: "complete" }) };
}
