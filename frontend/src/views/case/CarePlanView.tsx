import { type ReactNode, useMemo } from "react";
import { Button } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, ClipboardList, FileSearch, History, MessageSquare, Smartphone, UsersRound } from "lucide-react";
import { DetailModal, useDetailModal } from "@/components/ui";
import { date } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { Track } from "@/views/doctor/RiskCard";
import { Dot } from "@/views/doctor/BandMark";
import { type CarePlan, type CareTask, channelLabel, pathwayName, daysBetween, eventLabel, isOpenPlan, PLAN_STATUS, sortPlans, taskStatus } from "@/views/doctor/care";
import { isOpenTask, useTaskActions } from "@/views/doctor/TaskActions";

const RESULT: Record<string, string> = {
  DONE: "Done", NORMAL: "Normal", NEGATIVE: "Negative", POSITIVE: "Positive", SUSPICIOUS: "Suspicious finding", CANCER_FOUND: "Cancer found",
  LOW: "Low", CURATIVE: "Curative plan", PALLIATIVE: "Palliative plan", BSC: "Best supportive care", MISSED: "Missed", DECLINED: "Declined",
};
const resultLabel = (r: string | null | undefined) => (r ? RESULT[r] ?? r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, " ") : null);

/** Status glyph of a care step: done = ink disc with a check, open = ink ring, late = signal dot ring, scheduled = dashed. */
export function StepGlyph({ status, size = 22 }: { status: string; size?: number }) {
  const tone = taskStatus(status).tone;
  const cls = tone === "done" ? "bg-ink text-ink-on" : tone === "late" ? "border-[1.5px] border-signal" : tone === "open" ? "border-[1.5px] border-ink" : "border border-dashed border-faint";
  return (
    <span className={`rounded-full grid place-items-center shrink-0 ${cls}`} style={{ width: size, height: size }} aria-hidden>
      {tone === "done" && <Check size={size * 0.6} strokeWidth={2.6} />}
      {tone === "late" && <span className="w-2 h-2 rounded-full bg-signal" />}
    </span>
  );
}

const ChannelIcon = ({ c, size = 14 }: { c: string; size?: number }) =>
  c === "SMS" ? <MessageSquare size={size} aria-hidden /> : c === "CHW" ? <UsersRound size={size} aria-hidden /> : <Smartphone size={size} aria-hidden />;

function StepRow({ task, simNow, onEvidence, actions }: { task: CareTask; simNow?: string | null; onEvidence?: (date: string, t: CareTask) => void; actions: boolean }) {
  const st = taskStatus(task.status);
  const a = useTaskActions(task, simNow);
  const late = task.due_at && simNow && isOpenTask(task) ? daysBetween(task.due_at, simNow) : null;
  const ev = task.evidence && (task.evidence as any).date ? task.evidence : null;
  const result = resultLabel(task.result);
  const when = task.completed_at && !isOpenTask(task)
    ? `${task.status === "COMPLETED" ? "Done" : st.label} ${date(task.completed_at)}`
    : task.due_at ? `Due ${date(task.due_at)}${late && late > 0 ? `, ${late} day${late === 1 ? "" : "s"} late` : ""}` : st.label;
  return (
    <motion.li variants={itemEnter} className="flex flex-wrap items-center gap-x-3 gap-y-0 py-2.5 border-b border-hairline last:border-0 min-w-0">
      <StepGlyph status={task.status} />
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] leading-5 font-medium truncate ${st.tone === "quiet" && !isOpenTask(task) ? "text-muted" : "text-ink"}`}>{task.title}</div>
        <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-micro font-normal text-muted tabular mt-0.5">
          <span className={st.tone === "late" ? "text-ink inline-flex items-center gap-1.5" : ""}>{st.tone === "late" && <Dot level="high" />}{when}</span>
          {result && task.status === "COMPLETED" && <span>{result}</span>}
          {!!task.escalation_level && isOpenTask(task) && <span>Escalation {task.escalation_level}</span>}
          {ev && onEvidence && (
            <button type="button" onClick={() => onEvidence(String((ev as any).date), task)} className="inline-flex items-center gap-1 text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal rounded">
              <FileSearch size={12} aria-hidden />Evidence {date(String((ev as any).date))}
            </button>
          )}
          {ev && !onEvidence && <span className="inline-flex items-center gap-1"><FileSearch size={12} aria-hidden />EMR evidence {date(String((ev as any).date))}</span>}
        </div>
      </div>
      <span className="text-micro text-muted shrink-0">{st.label}</span>
      {actions && a.menu}
      {actions && a.form}
    </motion.li>
  );
}

/** One care plan: pathway, status, progress, the step checklist (with EMR evidence links) and the messages sent. */
export function PlanBlock({ plan, simNow, onEvidence, actions = true, compactHistory = false }: {
  plan: CarePlan; simNow?: string | null; onEvidence?: (date: string, t: CareTask) => void; actions?: boolean; compactHistory?: boolean;
}) {
  const reduce = useReducedMotion();
  const hist = useDetailModal();
  const steps = plan.tasks.filter((t) => t.type !== "CHW_VISIT" || isOpenTask(t) || t.status === "COMPLETED");
  const done = steps.filter((t) => t.status === "COMPLETED").length;
  const counted = steps.filter((t) => t.status !== "CANCELLED").length || 1;
  const titles = useMemo(() => Object.fromEntries(plan.tasks.map((t) => [t.id, t.title])), [plan.tasks]);
  const notes = plan.events.filter((e) => e.kind === "NOTIFIED").sort((a, b) => b.sim_time.localeCompare(a.sim_time));
  const shownNotes = compactHistory ? notes.slice(0, 3) : notes.slice(0, 6);
  return (
    <section aria-label={`${pathwayName(plan)} plan`} className="min-w-0">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-[15px] leading-5 font-semibold text-ink">{pathwayName(plan)}</h3>
        <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-micro ${plan.status === "ESCALATED" ? "bg-signal-soft text-signal-text" : "bg-tile text-muted"}`}>
          {plan.status === "ESCALATED" && <Dot level="high" />}{PLAN_STATUS[plan.status] ?? plan.status}
        </span>
        <span className="flex-1" />
        <span className="text-micro text-muted tabular">Approved {date(plan.approved_at)}</span>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <div className="flex-1"><Track value={done / counted} height={4} label={`${done} of ${counted} steps done`} tone="sky" /></div>
        <span className="text-micro text-muted tabular shrink-0">{done} of {counted} steps done</span>
      </div>
      <motion.ul className="mt-2" variants={stagger(0.03)} initial={reduce ? false : "hidden"} animate="show" aria-label="Plan steps">
        {steps.sort((a, b) => a.seq - b.seq || (a.occurrence ?? 0) - (b.occurrence ?? 0)).map((t) => (
          <StepRow key={t.id} task={t} simNow={simNow} onEvidence={onEvidence} actions={actions && isOpenPlan(plan)} />
        ))}
      </motion.ul>
      <div className="mt-4 flex items-center gap-2">
        <h4 className="text-label text-muted flex-1">Messages to the patient <span className="tabular">{notes.length}</span></h4>
        <span className="text-micro text-muted">{plan.channels.map(channelLabel).join(", ") || "No channel"}</span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1" aria-label="Notification history">
        {shownNotes.map((e) => (
          <li key={e.id} className="flex items-center gap-2.5 text-[13px] text-ink min-w-0">
            <span className="w-7 h-7 rounded-full bg-tile grid place-items-center text-ink shrink-0"><ChannelIcon c={e.detail?.channel ?? "APP"} size={13} /></span>
            <span className="truncate flex-1">{eventLabel(e, e.task_id ? titles[e.task_id] : undefined)}</span>
            <span className="text-micro text-muted tabular shrink-0">{date(e.sim_time)}</span>
          </li>
        ))}
        {!notes.length && <li className="text-micro text-muted">No messages yet</li>}
      </ul>
      <Button size="sm" radius="full" variant="flat" className="mt-3 h-8 px-3.5 bg-tile text-ink text-[13px] font-medium data-[hover=true]:bg-tile-hover"
              startContent={<History size={13} aria-hidden />} onPress={hist.open}>Full history <span className="text-muted tabular">{plan.events.length}</span></Button>
      <DetailModal {...hist.modalProps} title="Plan history" icon={<History size={18} />} size="2xl" subtitle={pathwayName(plan)}
                   info="Every step the care engine and the care team took, in simulated time. Actor: doctor, patient, system (care engine) or community health worker.">
        <ol className="flex flex-col divide-y divide-hairline" aria-label="Plan events">
          {[...plan.events].sort((a, b) => b.sim_time.localeCompare(a.sim_time) || b.id - a.id).map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5 text-[14px] min-w-0">
              <span className="tabular text-muted w-[104px] shrink-0 text-[13px]">{date(e.sim_time)}</span>
              <span className="flex-1 text-ink min-w-0 truncate">{eventLabel(e, e.task_id ? titles[e.task_id] : undefined)}</span>
              <span className="rounded-full bg-tile px-2.5 py-0.5 text-micro text-muted shrink-0">{e.actor === "chw" ? "Health worker" : e.actor.charAt(0).toUpperCase() + e.actor.slice(1)}</span>
            </li>
          ))}
        </ol>
      </DetailModal>
    </section>
  );
}

/** Every plan of a patient: open plans in full, closed plans listed below. */
export function CarePlanView({ plans, simNow, onEvidence, empty }: { plans: CarePlan[]; simNow?: string | null; onEvidence?: (date: string, t: CareTask) => void; empty?: ReactNode }) {
  const sorted = sortPlans(plans);
  const open = sorted.filter(isOpenPlan);
  const closed = sorted.filter((p) => !isOpenPlan(p));
  if (!plans.length) return <>{empty ?? <EmptyPlans />}</>;
  return (
    <div className="flex flex-col gap-6">
      {open.map((p) => <PlanBlock key={p.id} plan={p} simNow={simNow} onEvidence={onEvidence} />)}
      {closed.length > 0 && (
        <section aria-label="Earlier plans">
          <h4 className="text-label text-muted mb-1">Earlier plans</h4>
          <ul className="flex flex-col divide-y divide-hairline">
            {closed.map((p) => (
              <li key={p.id} className="py-2.5 flex items-center gap-3 text-[14px]">
                <StepGlyph status={p.status === "COMPLETED" ? "COMPLETED" : "CANCELLED"} size={20} />
                <span className="flex-1 min-w-0 truncate text-ink">{pathwayName(p)}</span>
                <span className="text-micro text-muted tabular">{PLAN_STATUS[p.status]} {date(p.closed_sim)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function EmptyPlans() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-label text-muted text-center">
      <span className="w-10 h-10 rounded-full border border-hairline grid place-items-center" aria-hidden><ClipboardList size={17} /></span>
      No care plan yet. Approve an alert, or start a plan from the patient header.
    </div>
  );
}
