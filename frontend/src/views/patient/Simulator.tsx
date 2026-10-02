import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Select, SelectItem } from "@heroui/react";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { BatteryFull, CalendarClock, CheckCircle2, Cpu, FastForward, History, MessageSquare, Smartphone, Stethoscope, UsersRound } from "lucide-react";
import { ApiError, get, post } from "@/api/client";
import { Card, ErrorNote, InfoHint } from "@/components/ui";
import { date } from "@/lib/format";
import { EASE } from "@/lib/motion";
import { useLive } from "@/state/live";
import { useRole } from "@/state/role";
import { Track } from "@/views/doctor/RiskCard";
import { day, type DemoPatient, type MyPlan, type Note, useDemoPatients, useMyPlan, useNotes } from "./api";

/* ------------------------------------------------------------------------------------------------ phone frame */

const PHONE_W = 390, PHONE_H = 844, BEZEL = 12;

/** Scale the frame down to fit the column width and the viewport height (never up). */
function useFit(ref: React.RefObject<HTMLDivElement>) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      const h = window.innerHeight - 236;
      setScale(Math.max(0.55, Math.min(1, w / (PHONE_W + 2 * BEZEL), h / (PHONE_H + 2 * BEZEL))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, [ref]);
  return scale;
}

/** A realistic phone: 390 x 844 screen with radius 48, dynamic-island notch, status bar showing the simulated date,
 * signal and battery, and a home indicator. `shakeKey` changes trigger a short haptic-like shake. */
export function PhoneFrame({ children, simNow, shakeKey }: { children: ReactNode; simNow: string | null; shakeKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const scale = useFit(box);
  const controls = useAnimationControls();
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!shakeKey || reduce) return;
    controls.start({ x: [0, -5, 5, -4, 4, -2, 0], rotate: [0, -0.4, 0.4, -0.3, 0.3, 0], transition: { duration: 0.5, ease: "easeInOut" } });
  }, [shakeKey, controls, reduce]);
  const W = PHONE_W + 2 * BEZEL, H = PHONE_H + 2 * BEZEL;
  return (
    <div ref={box} className="w-full flex justify-center" style={{ height: H * scale }}>
      <motion.div animate={controls} style={{ width: W, height: H, scale, transformOrigin: "top center" }} className="shrink-0">
        <div className="pa-phone relative rounded-[60px]" style={{ width: W, height: H, padding: BEZEL }}
             role="region" aria-label="Simulated phone">
          {/* side buttons */}
          <span className="absolute -left-[3px] top-[160px] w-[3px] h-[32px] rounded-l bg-[#2A2D33]" aria-hidden />
          <span className="absolute -left-[3px] top-[214px] w-[3px] h-[58px] rounded-l bg-[#2A2D33]" aria-hidden />
          <span className="absolute -left-[3px] top-[284px] w-[3px] h-[58px] rounded-l bg-[#2A2D33]" aria-hidden />
          <span className="absolute -right-[3px] top-[236px] w-[3px] h-[92px] rounded-r bg-[#2A2D33]" aria-hidden />
          <div className="relative w-full h-full rounded-[48px] overflow-hidden bg-page" style={{ isolation: "isolate" }}>
            {children}
            <StatusBar simNow={simNow} />
            <span className="absolute left-1/2 -translate-x-1/2 bottom-[8px] w-[134px] h-[5px] rounded-full bg-ink/85 z-[60] pointer-events-none" aria-hidden />
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function StatusBar({ simNow }: { simNow: string | null }) {
  return (
    <div className="absolute inset-x-0 top-0 h-[50px] z-[60] pointer-events-none flex items-center justify-between px-7 text-ink" aria-label={`Simulated date ${day(simNow)}`}>
      <span className="text-[15px] font-semibold tabular w-[96px]">{simNow ? day(simNow, { day: "numeric", month: "short" }) : "9:41"}</span>
      <span className="absolute left-1/2 -translate-x-1/2 top-[11px] w-[124px] h-[36px] rounded-full bg-[#0B0C0E]" aria-hidden />
      <span className="flex items-center gap-1.5 w-[96px] justify-end" aria-hidden>
        <svg width="18" height="12" viewBox="0 0 18 12"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></g></svg>
        <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.2 L5.6 8.6 a3.4 3.4 0 0 1 4.8 0 Z M2.9 5.9 a7.3 7.3 0 0 1 10.2 0 L11.8 7.2 a5.4 5.4 0 0 0 -7.6 0 Z M0.3 3.3 a11 11 0 0 1 15.4 0 L14.4 4.6 a9.2 9.2 0 0 0 -12.8 0 Z" fill="currentColor" /></svg>
        <BatteryFull size={24} strokeWidth={1.6} />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ demo picker */

export function DemoPicker({ compact = false }: { compact?: boolean }) {
  const demo = useDemoPatients();
  const { patientId, setPatient } = useRole();
  const items: DemoPatient[] = demo.data?.data ?? [];
  if (compact) {
    return (
      <Select aria-label="Demo patient" size="sm" radius="full" className="w-[260px] max-sm:w-auto max-sm:flex-1" placeholder="Choose a demo patient" isLoading={demo.isLoading}
              selectedKeys={patientId ? [String(patientId)] : []} disallowEmptySelection
              items={items.map((d) => ({ key: String(d.patient_id), label: d.display_id, d }))}
              onSelectionChange={(k) => { const v = Number(Array.from(k as Set<string>)[0]); const d = items.find((x) => x.patient_id === v); if (d) setPatient(d.patient_id, d.display_id); }}
              classNames={{ trigger: "bg-surface data-[hover=true]:bg-tile shadow-none h-10 min-h-10 px-4 dark:border dark:border-hairline", value: "text-[14px] text-ink tabular", popoverContent: "bg-surface shadow-float rounded-tile" }}>
        {(i) => <SelectItem key={i.key} textValue={i.label} description={`${i.d.plan_count} plan${i.d.plan_count === 1 ? "" : "s"}${i.d.has_notifications ? ", has messages" : ""}`}>{i.label}</SelectItem>}
      </Select>
    );
  }
  return (
    <div className="flex flex-col gap-3 w-full max-w-[520px]">
      <h2 className="text-title text-ink">Choose a demo patient</h2>
      <p className="text-label font-normal text-muted -mt-2">Patients with a care plan approved by a doctor. Synthetic people, shown by display ID.</p>
      {demo.error && <ErrorNote error={demo.error} />}
      <ul className="grid sm:grid-cols-2 gap-2.5" aria-label="Demo patients">
        {items.map((d) => (
          <li key={d.patient_id}>
            <button type="button" onClick={() => setPatient(d.patient_id, d.display_id)}
                    className="w-full text-left rounded-tile bg-surface px-4 py-3.5 flex items-center gap-3 hover:bg-tile transition-colors dark:border dark:border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
              <span className="w-9 h-9 rounded-full bg-tile grid place-items-center text-ink" aria-hidden><Smartphone size={16} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold text-ink tabular">{d.display_id}</span>
                <span className="block text-micro text-muted">{d.plan_count} plan{d.plan_count === 1 ? "" : "s"}{d.has_notifications ? ", has messages" : ""}</span>
              </span>
            </button>
          </li>
        ))}
        {!demo.isLoading && !items.length && <li className="text-label text-muted">No care plans yet. Approve one in the doctor workspace first.</li>}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ event log */

type LogItem = { key: string; at: string; seq: number; who: "doctor" | "system" | "patient" | "chw"; text: string; sub?: string; channel?: string };

const WHO: Record<LogItem["who"], { label: string; icon: ReactNode }> = {
  doctor: { label: "Doctor", icon: <Stethoscope size={14} aria-hidden /> },
  system: { label: "Care engine", icon: <Cpu size={14} aria-hidden /> },
  patient: { label: "Patient", icon: <Smartphone size={14} aria-hidden /> },
  chw: { label: "Health worker", icon: <UsersRound size={14} aria-hidden /> },
};

function logItems(plans: MyPlan[], notes: Note[]): LogItem[] {
  const out: LogItem[] = [];
  for (const p of plans) {
    const title = Object.fromEntries(p.tasks.map((t) => [t.id, t.title]));
    for (const e of p.events) {
      const t = e.task_id ? title[e.task_id] : "";
      const text = ({
        PLAN_CREATED: `Doctor approved a care plan: ${p.pathway_name ?? p.pathway}`,
        TASK_CREATED: `New step in the plan: ${t}`,
        TASK_OPENED: `Step is due now: ${t}`,
        COMPLETED: `The EMR shows this step done: ${t}`,
        OVERDUE: `Step is overdue: ${t}`,
        RESCHEDULED: `Doctor moved the due date: ${t}`,
        PATIENT_CONFIRMED: `Patient tapped “I’ve booked”: ${t}`,
        PATIENT_ACTED: "Patient opened the message",
        CHECKIN: "Patient sent a weekly check-in, written to the EMR",
        DOSE: "Patient recorded a medicine dose, written to the EMR",
        CHW_ASSIGNED: "A community health worker visit was arranged",
        MISSED: `Missed: ${t}`,
        PLAN_COMPLETED: "Every step is done: plan completed",
      } as Record<string, string>)[e.kind];
      if (!text || e.kind === "NOTIFIED") continue;
      out.push({ key: `e${e.id}`, at: e.sim_time, seq: e.id, who: (e.actor as LogItem["who"]) ?? "system", text });
    }
  }
  for (const n of notes) {
    out.push({ key: `n${n.id}`, at: n.created_sim, seq: 1e9, who: "system", channel: n.channel,
               text: `${n.channel === "SMS" ? "SMS" : "App notification"} to the patient: “${n.title}”`, sub: n.body });
    if (n.read_sim) out.push({ key: `r${n.id}`, at: n.read_sim, seq: 1e9 + 1, who: "patient", text: `Patient read “${n.title}”` });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
}

/** Event log beside the phone: what happened in this patient's care loop, in plain words, newest first. New lines are
 * highlighted so a demo audience sees the loop move. */
export function EventLog() {
  const plan = useMyPlan();
  const notes = useNotes();
  const reduce = useReducedMotion();
  const items = useMemo(() => logItems(plan.data?.data?.plans ?? [], notes.data?.data ?? []), [plan.data, notes.data]);
  const seen = useRef<Set<string> | null>(null);
  const fresh = useMemo(() => {
    if (!seen.current) { seen.current = new Set(items.map((i) => i.key)); return new Set<string>(); }
    const f = new Set(items.filter((i) => !seen.current!.has(i.key)).map((i) => i.key));
    for (const i of items) seen.current.add(i.key);
    return f;
  }, [items]);
  const byDay = useMemo(() => {
    const g: [string, LogItem[]][] = [];
    for (const it of items.slice(0, 60)) {
      const d = it.at.slice(0, 10);
      if (!g.length || g[g.length - 1][0] !== d) g.push([d, []]);
      g[g.length - 1][1].push(it);
    }
    return g;
  }, [items]);
  return (
    <Card title="Event log" aria-label="Event log" icon={<History size={16} />} className="h-full" bodyClassName="min-h-0 flex flex-col"
          info="What happened in this patient's care loop, newest first, in simulated time: the doctor's approval, every message the care engine sent, steps the EMR shows done, and what the patient did in the app.">
      <div className="flex-1 min-h-0 overflow-auto -mx-2 px-2 max-h-[640px]" aria-live="polite">
        {!items.length && <div className="text-label text-muted py-8 text-center">Nothing yet</div>}
        {byDay.map(([d, list]) => (
          <section key={d} aria-label={date(d)} className="mb-3">
            <h3 className="text-micro text-muted tabular py-1.5 sticky top-0 bg-surface z-[1]">{date(d)}</h3>
            <ul className="flex flex-col">
              <AnimatePresence initial={false}>
                {list.map((it) => (
                  <motion.li key={it.key} layout={!reduce} initial={reduce ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}
                             className={`relative flex gap-3 py-2 px-2 -mx-2 rounded-tile ${fresh.has(it.key) ? "bg-sky-soft/60" : ""}`}>
                    <span className="w-8 h-8 rounded-full bg-tile grid place-items-center text-ink shrink-0" title={WHO[it.who]?.label}>
                      {it.channel === "SMS" ? <MessageSquare size={14} aria-hidden /> : it.channel ? <Smartphone size={14} aria-hidden /> : it.text.startsWith("The EMR") ? <CheckCircle2 size={14} aria-hidden /> : WHO[it.who]?.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] leading-5 text-ink">{it.text}</div>
                      {it.sub && <div className="text-micro font-normal text-muted line-clamp-2 mt-0.5">{it.sub}</div>}
                    </div>
                    <span className="text-micro text-muted shrink-0 pt-0.5">{WHO[it.who]?.label}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </section>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------ simulate strip */

type Job = { id: string; status: "queued" | "running" | "done" | "failed"; progress: number | null; step: string | null; error: string | null };

/** Simulate strip: advance the shared sim clock through the API job (POST /admin/sim advance, then poll the job), so the
 * whole loop can be shown from this page. The top-bar sim control does the same. */
export function SimStrip() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["status", "sim"], queryFn: () => get<any>("/admin/sim/status"), refetchInterval: 15_000 });
  const [jobId, setJobId] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const job = useQuery({
    queryKey: ["sim-job", jobId], queryFn: () => get<Job>(`/admin/sim/jobs/${jobId}`), enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.data?.status === "done" || q.state.data?.data?.status === "failed" ? false : 800),
  });
  const running = status.data?.data?.running_job?.id as string | undefined;
  useEffect(() => { if (running && !jobId) setJobId(running); }, [running, jobId]);
  const j = job.data?.data;
  useEffect(() => {
    if (!j || (j.status !== "done" && j.status !== "failed")) return;
    if (j.status === "done") {
      useLive.getState().toast(`Simulated ${days ? `${days} day${days === 1 ? "" : "s"}` : "time"}: reminders, EMR evidence and messages are up to date`);
      for (const k of ["me", "care", "status", "alerts", "patients"]) qc.invalidateQueries({ queryKey: [k] });
    }
    const t = window.setTimeout(() => { setJobId(null); setDays(null); }, j.status === "done" ? 1200 : 6000);
    return () => window.clearTimeout(t);
  }, [j?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const adv = useMutation({
    mutationFn: (d: number) => post<{ job_id: string }>("/admin/sim", { action: "advance", days: d }),
    onSuccess: (r, d) => { setJobId(r.data.job_id); setDays(d); },
    onError: (e) => { const id = (e as ApiError).details as { job_id?: string } | undefined; if (id?.job_id) setJobId(id.job_id); },
  });
  const sim = (status.data?.data?.sim_time as string | undefined) ?? (status.data?.meta?.sim_time as string | undefined) ?? null;
  const busy = !!jobId && j?.status !== "done" && j?.status !== "failed";
  return (
    <Card padding="sm" static>
      <div className="flex items-center gap-4 flex-wrap">
        <span className="w-9 h-9 rounded-full border border-hairline grid place-items-center text-ink shrink-0" aria-hidden><CalendarClock size={17} /></span>
        <div className="min-w-0">
          <div className="flex items-center gap-0.5">
            <h2 className="text-title text-ink">Simulate</h2>
            <InfoHint title="Simulate time" label="About simulating time"
                      about="Advancing the clock replays the pre-simulated EMR, runs the care engine (reminders, escalations, EMR evidence that closes steps) and the patient behaviour model, then republishes the analytics. Everyone using this platform shares the clock; the sim control in the top bar does the same." />
          </div>
          <div className="text-label font-normal text-muted tabular" aria-live="polite">Simulated date {date(sim)}</div>
        </div>
        <div className="flex-1 min-w-[160px]">
          <AnimatePresence initial={false}>
            {busy && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-1.5" role="status">
                <Track value={j?.progress ?? 0.03} height={4} tone="sky" label="Simulation progress" delay={0} />
                <span className="text-micro text-muted truncate">{j?.step ? `${String(j.step).charAt(0).toUpperCase()}${String(j.step).slice(1).replace(/_/g, " ")}` : "Starting"}{days ? `, ${days} day${days === 1 ? "" : "s"}` : ""}</span>
              </motion.div>
            )}
          </AnimatePresence>
          {j?.status === "failed" && <span className="text-micro text-signal-text" role="alert">Simulation failed: {j.error}</span>}
        </div>
        <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Advance the clock">
          {[{ d: 1, l: "1 day" }, { d: 7, l: "1 week" }, { d: 30, l: "1 month" }].map((o) => (
            <Button key={o.d} radius="full" variant="flat" isDisabled={busy || adv.isPending} onPress={() => adv.mutate(o.d)}
                    className="h-10 px-4 bg-tile text-ink text-[14px] font-medium data-[hover=true]:bg-tile-hover" startContent={<FastForward size={14} aria-hidden />}>
              {o.l}
            </Button>
          ))}
        </div>
      </div>
      {adv.error && !(adv.error as ApiError).details && <div className="mt-3"><ErrorNote error={adv.error} /></div>}
    </Card>
  );
}
