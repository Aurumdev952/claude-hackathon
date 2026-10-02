import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, CalendarCheck, Check, ChevronRight, MapPin, Navigation, Phone, Pill } from "lucide-react";
import { post } from "@/api/client";
import { EASE } from "@/lib/motion";
import { COURSES, day, type Dose, facilityShort, type Me, type MyPlan, type Note, OPEN, relDays, sameDay, useDoses, weekday } from "./api";
import { PCard, pBtn, Screen, SectionTitle, Sheet } from "./kit";

type Step = { task: MyPlan["tasks"][number]; plan: MyPlan };

/** Home (plan §6): greeting, the next step with "I've booked", directions and call, reminders, the medicines course
 * tracker and the latest message. */
export function Home({ me, plans, notes, simNow, onInbox, onTab }: {
  me: Me | undefined; plans: MyPlan[]; notes: Note[]; simNow: string | null; onInbox: () => void; onTab: (t: "plan" | "checkin") => void;
}) {
  const unread = notes.filter((n) => n.channel === "APP" && !n.read_sim).length;
  const steps: Step[] = useMemo(() => plans.flatMap((plan) => plan.tasks.filter((t) => OPEN.has(t.status) && t.patient_facing !== false).map((task) => ({ task, plan })))
    .sort((a, b) => (a.task.due_at ?? "").localeCompare(b.task.due_at ?? "")), [plans]);
  const next = steps.find((s) => s.task.status !== "SCHEDULED") ?? steps[0] ?? null;
  const later = steps.filter((s) => s !== next).slice(0, 4);
  const course = useMemo(() => {
    for (const p of plans) for (const t of p.tasks) if (COURSES[t.type] && t.status !== "CANCELLED" && t.status !== "DECLINED") return { ...COURSES[t.type], task: t };
    return null;
  }, [plans]);
  const latest = notes.filter((n) => n.channel === "APP")[0];
  const first = me?.given_name?.split(/\s+/)[0];
  return (
    <Screen label="Home" sub={weekday(simNow)} title={first ? `Hi ${first}` : "Hello"}
            trailing={
              <button type="button" onClick={onInbox} aria-label={unread ? `Messages, ${unread} unread` : "Messages"}
                      className="relative w-12 h-12 rounded-full bg-surface grid place-items-center text-ink dark:border dark:border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                <Bell size={20} aria-hidden />
                {unread > 0 && <span className="absolute top-2.5 right-3 w-2.5 h-2.5 rounded-full bg-signal ring-2 ring-surface" aria-hidden />}
              </button>
            }>
      {next ? <NextStep step={next} notes={notes} me={me} simNow={simNow} /> : <AllSet />}

      {later.length > 0 && (
        <>
          <SectionTitle right={<button type="button" onClick={() => onTab("plan")} className="text-[14px] text-muted hover:text-ink">See plan</button>}>Coming up</SectionTitle>
          <div className="flex gap-3 overflow-x-auto pa-scroll -mx-5 px-5 pb-1" role="list" aria-label="Reminders">
            {later.map(({ task }) => {
              const d = relDays(simNow, task.due_at);
              return (
                <div key={task.id} role="listitem" className="shrink-0 w-[200px] rounded-[20px] bg-surface p-4 dark:border dark:border-hairline">
                  <CalendarCheck size={18} className="text-ink" aria-hidden />
                  <div className="text-[15px] leading-5 font-semibold text-ink mt-3 line-clamp-2 min-h-[40px]">{task.title}</div>
                  <div className="text-[13px] text-muted mt-1 tabular">{task.status === "SCHEDULED" ? `From ${day(task.opens_at)}` : d !== null && d < 0 ? `${-d} days late` : `By ${day(task.due_at)}`}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {course && <Medicines course={course} simNow={simNow} />}

      <button type="button" onClick={() => onTab("checkin")}
              className="text-left rounded-[24px] bg-surface p-5 flex items-center gap-4 dark:border dark:border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        <span className="w-11 h-11 rounded-full bg-tile grid place-items-center text-ink shrink-0" aria-hidden><Check size={20} /></span>
        <span className="flex-1 min-w-0">
          <span className="block text-[16px] font-semibold text-ink">Weekly check-in</span>
          <span className="block text-[14px] text-muted">Two minutes: appetite, pain, energy, weight</span>
        </span>
        <ChevronRight size={20} className="text-faint" aria-hidden />
      </button>

      {latest && (
        <button type="button" onClick={onInbox}
                className="text-left rounded-[24px] bg-surface p-5 dark:border dark:border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          <span className="flex items-center gap-2 text-[13px] text-muted">
            {!latest.read_sim && <span className="w-2 h-2 rounded-full bg-signal" aria-hidden />}
            <span className="flex-1">Latest from your care team</span><span className="tabular">{day(latest.created_sim)}</span>
          </span>
          <span className="block text-[16px] leading-6 font-semibold text-ink mt-1.5">{latest.title}</span>
          <span className="block text-[14px] leading-5 text-muted mt-0.5 line-clamp-2">{latest.body}</span>
        </button>
      )}
    </Screen>
  );
}

/** "Please visit {facility} for a check-up before {date}", worded for the kind of step. */
function StepCopy({ type, facility, due, late }: { type: string; facility: string; due: string; late: boolean }) {
  const F = <span className="text-ink font-medium">{facility}</span>;
  const D = <span className="text-ink font-medium tabular">{due}</span>;
  if (type === "CHW_VISIT") return <>Your community health worker will visit you at home {late ? <>soon. It was planned for {D}</> : <>before {D}</>}.</>;
  const what = type === "HP_TREATMENT" || type === "IRON_COURSE" ? "to collect your medicine" : type === "B12_INJECTION" ? "for your vitamin B12 injection"
    : type === "CHEMO_CYCLE" || type === "TREATMENT_CYCLE" ? "for your next treatment" : "for a check-up";
  return late ? <>Please visit {F} {what} as soon as you can. It was due on {D}.</> : <>Please visit {F} {what} before {D}.</>;
}

function AllSet() {
  return (
    <PCard className="flex items-center gap-4" label="Next step">
      <span className="w-12 h-12 rounded-full bg-ink text-ink-on grid place-items-center shrink-0" aria-hidden><Check size={22} /></span>
      <div>
        <div className="text-[18px] leading-6 font-semibold text-ink">Nothing to do right now</div>
        <div className="text-[14px] text-muted mt-0.5">We will send you a message when your next step is due.</div>
      </div>
    </PCard>
  );
}

function NextStep({ step, notes, me, simNow }: { step: Step; notes: Note[]; me: Me | undefined; simNow: string | null }) {
  const qc = useQueryClient();
  const { task, plan } = step;
  const [sheet, setSheet] = useState<null | "map" | "call">(null);
  const facility = facilityShort(plan.target_facility_name ?? me?.facility.name) || "your clinic";
  const booked = plan.events.some((e) => e.kind === "PATIENT_CONFIRMED" && e.task_id === task.id);
  const d = relDays(simNow, task.due_at);
  const confirm = useMutation({
    mutationFn: () => post(`/me/tasks/${task.id}/confirm`, { text: `Booked a visit at ${facility}` }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const sent = notes.some((n) => n.task_id === task.id);
  return (
    <PCard className="!p-6 !rounded-[28px]" label="Next step">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span className="flex-1">Your next step</span>
        <span className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[12.5px] font-medium tabular ${d !== null && d < 0 ? "bg-signal-soft text-signal-text" : "bg-tile text-ink"}`}>
          {d === null ? "No date" : d < 0 ? `${-d} days late` : d === 0 ? "Due today" : `${d} days left`}
        </span>
      </div>
      <h2 className="text-[24px] leading-[30px] font-semibold tracking-[-0.01em] text-ink mt-3">{task.title}</h2>
      <p className="text-[16px] leading-6 text-ink/80 mt-2"><StepCopy type={task.type} facility={facility} due={day(task.due_at)} late={d !== null && d < 0} /></p>
      {!sent && <p className="text-[13px] text-muted mt-1">Your doctor asked for this as part of your care plan.</p>}
      <div className="mt-5 flex flex-col gap-2.5">
        <AnimatePresence mode="wait" initial={false}>
          {booked || confirm.isSuccess ? (
            <motion.div key="booked" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25, ease: EASE }}
                        className="h-12 rounded-full bg-tile flex items-center justify-center gap-2 text-[15px] font-semibold text-ink" role="status">
              <span className="w-6 h-6 rounded-full bg-ink text-ink-on grid place-items-center" aria-hidden><Check size={14} /></span>Booked. Thank you
            </motion.div>
          ) : (
            <motion.button key="book" type="button" className={pBtn.primary} onClick={() => confirm.mutate()} disabled={confirm.isPending}
                           initial={false} exit={{ opacity: 0 }}>I&apos;ve booked</motion.button>
          )}
        </AnimatePresence>
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" className={`${pBtn.soft} inline-flex items-center justify-center gap-2`} onClick={() => setSheet("map")}><Navigation size={17} aria-hidden />Directions</button>
          <button type="button" className={`${pBtn.soft} inline-flex items-center justify-center gap-2`} onClick={() => setSheet("call")}><Phone size={17} aria-hidden />Call</button>
        </div>
        {(booked || confirm.isSuccess) && <p className="text-[13px] text-muted text-center">We will tick this off when your visit is in your health record.</p>}
      </div>
      <PortalSheet open={sheet === "map"} onClose={() => setSheet(null)} title="Directions">
        <StaticMap name={facility} />
        <p className="text-[14px] text-muted mt-3">{facility}. Show this message at reception.</p>
      </PortalSheet>
      <PortalSheet open={sheet === "call"} onClose={() => setSheet(null)} title="Call">
        <div className="flex flex-col gap-2.5">
          <CallRow who={facility} what="Reception" phone="+250 7xx xxx xxx" />
          {me?.chw && <CallRow who={me.chw.name.replace(" (Synthetic)", "")} what="Your community health worker" phone={me.chw.phone} />}
          <p className="text-[13px] text-muted">Calls are not placed in this demo. Numbers are synthetic.</p>
        </div>
      </PortalSheet>
    </PCard>
  );
}

const PortalSheet = Sheet;

function CallRow({ who, what, phone }: { who: string; what: string; phone: string }) {
  return (
    <div className="rounded-[20px] bg-tile p-4 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-semibold text-ink truncate">{who}</div>
        <div className="text-[13px] text-muted">{what}, {phone}</div>
      </div>
      <span className="w-11 h-11 rounded-full bg-ink text-ink-on grid place-items-center" aria-hidden><Phone size={18} /></span>
    </div>
  );
}

/** A static, stylised map with one pin (no tiles, no network). */
function StaticMap({ name }: { name: string }) {
  return (
    <div className="relative h-[180px] rounded-[20px] overflow-hidden bg-tile" role="img" aria-label={`Map pin for ${name}`}>
      <svg viewBox="0 0 350 180" className="absolute inset-0 w-full h-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <g stroke="rgb(var(--hairline))" strokeWidth="10" fill="none" strokeLinecap="round">
          <path d="M-10 120 C 80 100, 140 140, 230 96 S 330 70, 360 84" />
          <path d="M120 -10 C 130 60, 150 110, 140 190" />
          <path d="M250 -10 L 236 190" />
        </g>
        <g stroke="rgb(var(--surface))" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".9">
          <path d="M-10 120 C 80 100, 140 140, 230 96 S 330 70, 360 84" />
        </g>
        <path d="M30 30 h50 v40 h-50z M290 120 h40 v40 h-40z M170 20 h50 v30 h-50z" fill="rgb(var(--hairline))" opacity=".7" />
      </svg>
      <div className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-full flex flex-col items-center">
        <span className="rounded-full bg-surface px-3 py-1 text-[12.5px] font-semibold text-ink mb-1 whitespace-nowrap shadow-float">{name}</span>
        <MapPin size={34} className="text-brand fill-brand/20" aria-hidden />
      </div>
    </div>
  );
}

function Medicines({ course, simNow }: { course: (typeof COURSES)[string] & { task: MyPlan["tasks"][number] }; simNow: string | null }) {
  const qc = useQueryClient();
  const doses = useDoses();
  const mine: Dose[] = (doses.data?.data ?? []).filter((d) => d.course === course.id).sort((a, b) => a.created_sim.localeCompare(b.created_sim));
  const today = mine.find((d) => sameDay(d.created_sim, simNow));
  const taken = mine.filter((d) => d.taken).length;
  const m = useMutation({
    mutationFn: (t: boolean) => post("/me/doses", { course: course.id, taken: t }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const cells = Array.from({ length: course.days }, (_, i) => mine[i] ?? null);
  return (
    <PCard label="Medicines">
      <div className="flex items-center gap-3">
        <span className="w-11 h-11 rounded-full bg-tile grid place-items-center text-ink shrink-0" aria-hidden><Pill size={20} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[16px] font-semibold text-ink">{course.name}</div>
          <div className="text-[13px] text-muted tabular">{taken} of {course.days} days taken</div>
        </div>
      </div>
      <div className="grid gap-1.5 mt-4" style={{ gridTemplateColumns: `repeat(${Math.min(course.days, 14)}, minmax(0, 1fr))` }} role="img"
           aria-label={`${taken} doses taken, ${mine.length - taken} missed, ${course.days - mine.length} to go`}>
        {cells.map((c, i) => (
          <span key={i} className={`h-3 rounded-full ${c ? (c.taken ? "bg-sky" : "border-[1.5px] border-signal") : "bg-hairline"}`} />
        ))}
      </div>
      <p className="text-[13px] text-muted mt-3">{course.how}</p>
      {today ? (
        <div className="mt-4 h-12 rounded-full bg-tile flex items-center justify-center gap-2 text-[15px] font-medium text-ink" role="status">
          <Check size={16} aria-hidden />Today recorded as {today.taken ? "taken" : "missed"}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-[2fr_1fr] gap-2.5">
          <button type="button" className={pBtn.ink} disabled={m.isPending} onClick={() => m.mutate(true)}>Taken today</button>
          <button type="button" className={pBtn.soft} disabled={m.isPending} onClick={() => m.mutate(false)}>Missed</button>
        </div>
      )}
    </PCard>
  );
}
