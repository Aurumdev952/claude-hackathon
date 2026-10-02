import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { Box, ClipboardCheck, ListTodo, UserRound } from "lucide-react";
import { get } from "@/api/client";
import { Card, ErrorNote, InfoHint, Seg, Skeleton } from "@/components/ui";
import { date } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { PlanBlock } from "@/views/case/CarePlanView";
import { Dot } from "./BandMark";
import { ESCALATION, PATHWAY_NAME, usePatientCare, type WorkItem } from "./care";
import { PatientAvatar } from "./PatientAvatar";
import { SuggestionsCard } from "./SuggestedNext";
import { useTaskActions } from "./TaskActions";

export const ADHERENCE_NOTE = (
  <>
    <span className="block">The chance this patient completes the step, from the adherence model trained on earlier care-plan outcomes at
      this kind of facility: pathway, channels, distance to the facility, sex, age band and risk at approval.</span>
    <span className="block mt-2">Each day overdue and each escalation step already used lowers it. Until 50 outcomes exist, a prior is used
      (further away and older patients are less likely to attend; a community health worker helps).</span>
    <span className="block mt-2 text-muted">Rows are sorted by priority: overdue first, then the least likely to attend.</span>
  </>
);

const fullName = (p: WorkItem["patient"]) => [p.given_name, p.family_name].filter(Boolean).join(" ") || p.display_id;

/** Follow-ups (plan §3): the facility's open care steps, overdue first, sorted by the risk of not attending; the selected
 * step's plan sits on the right. Doctors can mark a step done, reschedule it or decline it with a reason. */
export function FollowUps({ onOpenPatient }: { onOpenPatient: (id: number) => void }) {
  const reduce = useReducedMotion();
  const [view, setView] = useState<"all" | "overdue">("all");
  const q = useQuery({ queryKey: ["care", "worklist"], queryFn: () => get<WorkItem[]>("/care/worklist") });
  const simNow = (q.data?.meta?.sim_time as string | undefined) ?? null;
  const rows = useMemo(() => {
    const all = q.data?.data ?? [];
    const late = (w: WorkItem) => w.task.overdue_days > 0 || w.task.status === "OVERDUE" || w.task.status === "ESCALATED";
    return [...all].filter((w) => view === "all" || late(w)).sort((a, b) => Number(late(b)) - Number(late(a)) || b.priority - a.priority);
  }, [q.data, view]);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (rows.length && (!sel || !rows.some((r) => r.task.id === sel))) setSel(rows[0].task.id); }, [rows, sel]);
  const current = rows.find((r) => r.task.id === sel) ?? null;
  const nLate = (q.data?.data ?? []).filter((w) => w.task.overdue_days > 0).length;
  return (
    <div className="grid grid-cols-12 gap-5 items-start">
      <SuggestionsCard className="col-span-12" />
      <Card className="col-span-12 xl:col-span-7" padding="none" title="Follow-ups" icon={<ListTodo size={16} />}
            info={{ about: "Open care-plan steps at this facility (approved here or referred here). Overdue steps come first, then the patients least likely to attend.", method: ADHERENCE_NOTE }}
            actions={<Seg label="Follow-up filter" value={view} onChange={setView} variant="glass"
                          options={[{ value: "all", label: `All ${q.data?.data?.length ?? ""}`.trim() }, { value: "overdue", label: `Overdue ${nLate}` }]} />}>
        {q.error && <div className="px-6 pb-4"><ErrorNote error={q.error} /></div>}
        {q.isLoading ? <div className="px-6 pb-6"><Skeleton variant="list" rows={6} label="Loading follow-ups" /></div> : (
          <>
            <div className="hidden md:grid grid-cols-[minmax(0,1fr)_128px_112px_32px] gap-3 px-7 pb-2 text-micro text-muted">
              <span>Patient and step</span><span>Due</span>
              <span className="flex items-center gap-0.5 -my-1">Likely to attend<InfoHint title="Likely to attend" label="About likely to attend" size={13} className="!w-6 !h-6 !min-w-6" about={ADHERENCE_NOTE} /></span>
              <span />
            </div>
            <motion.ul className="px-3 pb-3 flex flex-col" aria-label="Follow-ups" variants={stagger(0.02)} initial={reduce ? false : "hidden"} animate="show">
              {rows.map((w) => <WorkRow key={w.task.id} w={w} on={w.task.id === sel} onSelect={() => setSel(w.task.id)} simNow={simNow} />)}
              {!rows.length && <li className="p-8 text-center text-label text-muted">{view === "overdue" ? "Nothing overdue" : "No open follow-ups. Approve an alert to start a care plan."}</li>}
            </motion.ul>
          </>
        )}
      </Card>
      <div className="col-span-12 xl:col-span-5 min-w-0 xl:sticky xl:top-0">
        {current ? <PlanPanel w={current} simNow={simNow} onOpenPatient={onOpenPatient} /> : !q.isLoading && (
          <Card className="min-h-[320px]" bodyClassName="flex flex-col items-center justify-center gap-3 text-center">
            <span className="w-12 h-12 rounded-full border border-hairline grid place-items-center" aria-hidden><ClipboardCheck size={20} /></span>
            <div className="text-label font-normal text-muted">Pick a follow-up to see its plan</div>
          </Card>
        )}
      </div>
    </div>
  );
}

function WorkRow({ w, on, onSelect, simNow }: { w: WorkItem; on: boolean; onSelect: () => void; simNow: string | null }) {
  const a = useTaskActions(w.task, simNow);
  const late = w.task.overdue_days > 0;
  const pct = Math.round(100 * w.p_adhere);
  return (
    <motion.li variants={itemEnter} className={`rounded-tile px-4 py-2.5 transition-colors ${on ? "bg-tile" : "hover:bg-tile/70"}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_128px_112px_32px] gap-x-3 gap-y-1 items-center">
        <button type="button" onClick={onSelect} aria-current={on ? "true" : undefined}
                className="min-w-0 flex items-center gap-3 text-left focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand rounded-tile">
          <PatientAvatar name={fullName(w.patient)} size="sm" className={on ? "!bg-surface" : ""} />
          <span className="min-w-0">
            <span className="block text-[14px] leading-5 font-semibold text-ink truncate">{fullName(w.patient)}</span>
            <span className="flex gap-3 text-micro font-normal text-muted min-w-0 whitespace-nowrap overflow-hidden"><span className="truncate text-ink/80">{w.task.title}</span><span className="shrink-0 max-sm:hidden">{PATHWAY_NAME[w.plan.pathway] ?? w.plan.pathway}</span></span>
          </span>
        </button>
        <span className="text-micro tabular md:order-none order-last col-span-2 md:col-span-1 flex flex-wrap items-center gap-x-3 pl-11 md:pl-0">
          <span className={`inline-flex items-center gap-1.5 ${late ? "text-ink" : "text-muted"}`}>{late && <Dot level="high" />}{late ? `${w.task.overdue_days} days overdue` : `Due ${date(w.task.due_at)}`}</span>
          {!!w.task.escalation_level && <span className="md:block text-muted">{ESCALATION[w.task.escalation_level] ?? `Level ${w.task.escalation_level}`}</span>}
        </span>
        <span className="hidden md:flex items-center gap-2 min-w-0" title={`Likely to attend ${pct}%`}>
          <span className="text-[14px] font-medium tabular text-ink w-9">{pct}%</span>
          <span className="flex-1 h-1 rounded-full bg-hairline overflow-hidden" aria-hidden><span className="block h-full rounded-full bg-sky" style={{ width: `${pct}%` }} /></span>
        </span>
        <span className="flex justify-end">{a.menu}</span>
      </div>
      <span className="md:hidden block text-micro text-muted pl-11 mt-0.5">Likely to attend {pct}%</span>
      {a.form}
    </motion.li>
  );
}

function PlanPanel({ w, simNow, onOpenPatient }: { w: WorkItem; simNow: string | null; onOpenPatient: (id: number) => void }) {
  const nav = useNavigate();
  const care = usePatientCare(w.patient.patient_id);
  const plan = (care.data?.data?.plans ?? []).find((p) => p.id === w.plan.id);
  return (
    <Card padding="md">
      <div className="flex items-center gap-4 flex-wrap mb-5">
        <PatientAvatar name={fullName(w.patient)} />
        <div className="min-w-0 flex-1">
          <h2 className="text-title text-ink truncate">{fullName(w.patient)}</h2>
          <div className="text-micro text-muted tabular">{w.patient.display_id}{w.patient.age ? `, ${w.patient.age} years` : ""}</div>
        </div>
        <div className="flex gap-1.5">
          <Button isIconOnly size="sm" radius="full" variant="flat" aria-label="Open patient" className="w-9 h-9 min-w-9 bg-tile text-ink" onPress={() => onOpenPatient(w.patient.patient_id)}><UserRound size={15} /></Button>
          <Button isIconOnly size="sm" radius="full" variant="flat" aria-label="Analyse case in 3D" className="w-9 h-9 min-w-9 bg-tile text-ink" onPress={() => nav(`/doctor/case/${w.patient.patient_id}`)}><Box size={15} /></Button>
        </div>
      </div>
      {care.isLoading ? <Skeleton variant="list" rows={4} label="Loading plan" /> : care.error ? <ErrorNote error={care.error} />
        : plan ? <PlanBlock plan={plan} simNow={simNow} compactHistory /> : <div className="text-label text-muted">Plan not found</div>}
    </Card>
  );
}
