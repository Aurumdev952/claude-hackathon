import { type ReactNode, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Activity, CalendarCheck, ChevronRight, ClipboardList, HeartPulse, Microscope, Pill, Scissors, Stethoscope } from "lucide-react";
import { DetailModal, InfoHint, Sparkline, useDetailModal } from "@/components/ui";
import { date, fmt, signed } from "@/lib/format";
import { EASE, itemEnter, stagger } from "@/lib/motion";
import { Dot } from "@/views/doctor/BandMark";
import { MiniSeries } from "@/views/doctor/Timeline";
import { daysBetween, type Journey, type JourneyPhase, type Point } from "@/views/doctor/care";

export const SURVIVORSHIP_NOTE = (
  <>
    <span className="block">After curative surgery, follow-up visits every 3 to 6 months in years 1 to 3, then every 6 to 12 months in years 3 to 5;
      no routine surveillance after 5 years. Endoscopy and CT only when indicated (CT for advanced disease).</span>
    <span className="block mt-2">After a gastrectomy, check vitamin B12, iron and vitamin D (with calcium) and give B12 injections for life after a total
      gastrectomy. Watch weight and dumping symptoms.</span>
    <span className="block mt-2 text-muted">Sources: NCCN, JGCA and CSCO post-gastrectomy follow-up (PMC12699063); ESMO 2022 gastric cancer guideline;
      nutrition after gastrectomy (PMC12989006).</span>
  </>
);

const KIND_ICON: Record<string, ReactNode> = {
  procedure: <Microscope size={14} aria-hidden />, diagnosis: <Activity size={14} aria-hidden />, treatment: <Scissors size={14} aria-hidden />,
  visit: <Stethoscope size={14} aria-hidden />, plan: <ClipboardList size={14} aria-hidden />, notification: <CalendarCheck size={14} aria-hidden />,
  alert: <HeartPulse size={14} aria-hidden />, task: <CalendarCheck size={14} aria-hidden />, drug: <Pill size={14} aria-hidden />,
};

/** Horizontal phase track: done phases in ink, the current phase in signal (the one accent), upcoming phases dashed. */
export function PhaseTrack({ phases, labelOf = (p) => p.phase }: { phases: JourneyPhase[]; labelOf?: (p: JourneyPhase) => string }) {
  const reduce = useReducedMotion();
  if (!phases.length) return <div className="text-label text-muted">No journey recorded yet</div>;
  return (
    <ol className="flex overflow-x-auto scrollbar-none -mx-1 px-1 pb-1" aria-label="Journey phases">
      {phases.map((p, i) => {
        const cur = p.status === "current";
        const done = p.status === "done";
        const next = phases[i + 1];
        const lineDone = done && next && next.status !== "upcoming";
        return (
          <li key={`${p.phase}-${i}`} className="relative flex-1 min-w-[92px] pr-2" aria-current={cur ? "step" : undefined}>
            <div className="flex items-center h-5">
              <motion.span initial={reduce ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: reduce ? 0 : 0.05 * i, duration: 0.3, ease: EASE }}
                           className={`relative z-[1] rounded-full shrink-0 ${cur ? "w-4 h-4 bg-brand ring-4 ring-brand/20" : done ? "w-3 h-3 bg-ink" : p.status === "missed" ? "w-3 h-3 border-[1.5px] border-signal" : "w-3 h-3 border border-dashed border-faint bg-surface"}`} aria-hidden />
              {next && <span className={`flex-1 ml-1 ${lineDone ? "h-[2px] bg-ink" : "border-t border-dashed border-faint"}`} aria-hidden />}
            </div>
            <div className={`mt-2 text-[13px] leading-[18px] ${cur ? "font-semibold text-ink" : done ? "text-ink" : "text-muted"}`}>{labelOf(p)}</div>
            <div className="text-micro font-normal text-muted tabular">{p.start ? date(p.start) : p.status === "upcoming" ? "Upcoming" : "—"}</div>
            <span className="sr-only">{cur ? "current phase" : p.status}</span>
          </li>
        );
      })}
    </ol>
  );
}

type TileProps = { label: string; value: ReactNode; unit?: string; note?: ReactNode; flag?: boolean; series?: Point[]; onOpen?: () => void; children?: ReactNode };

function Tile({ label, value, unit, note, flag, series, onOpen, children }: TileProps) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-label text-muted"><span className="truncate">{label}</span>{onOpen && <ChevronRight size={14} className="text-faint shrink-0" aria-hidden />}</span>
      <span className="flex items-baseline gap-1 min-w-0 mt-1">
        <span className="text-[24px] leading-8 font-medium tracking-[-0.01em] tabular text-ink">{value}</span>
        {unit && <span className="text-label font-normal text-muted truncate">{unit}</span>}
      </span>
      <span className="flex items-end justify-between gap-3 min-h-[22px] mt-1">
        <span className={`inline-flex items-center gap-1.5 text-micro ${flag ? "text-ink" : "text-muted"} min-w-0`}>{flag && <Dot level="high" />}<span className="truncate">{note}</span></span>
        {series && series.length > 1 && <span className="w-[64px] shrink-0"><Sparkline values={series.map((x) => x.value)} height={22} area={false} /></span>}
      </span>
      {children}
    </>
  );
  const cls = "text-left rounded-tile bg-tile px-4 py-3.5 min-w-0 flex flex-col";
  if (!onOpen) return <motion.div variants={itemEnter} className={cls}>{body}</motion.div>;
  return (
    <motion.button type="button" variants={itemEnter} onClick={onOpen} aria-label={`${label}: open chart`}
                   className={`${cls} transition-colors hover:bg-tile-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand`}>{body}</motion.button>
  );
}

/** Chemotherapy cycles as small segments (done = ink, remaining = track). */
function Cycles({ done, planned }: { done: number; planned: number }) {
  return (
    <span className="flex gap-1 mt-2" role="img" aria-label={`${done} of ${planned} cycles done`}>
      {Array.from({ length: planned }, (_, i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${i < done ? "bg-ink" : "bg-hairline"}`} />)}
    </span>
  );
}

const last = (s: Point[] | undefined) => (s && s.length ? s[s.length - 1].value : null);
const SERIES_META = {
  weight: { title: "Weight", unit: "kg" }, b12: { title: "Vitamin B12", unit: "pg/mL" }, hb: { title: "Haemoglobin", unit: "g/dL" },
  albumin: { title: "Albumin", unit: "g/dL" }, ecog: { title: "ECOG performance status", unit: "" },
} as const;

/** Recovery journey (plan §3): phase track, milestones, recovery tiles with thin trends, and the survivorship schedule. */
export function JourneyView({ journey, simNow, sex, compact = false }: { journey: Journey; simNow?: string | null; sex?: string; compact?: boolean }) {
  const reduce = useReducedMotion();
  const chart = useDetailModal();
  const all = useDetailModal();
  const [key, setKey] = useState<keyof typeof SERIES_META>("weight");
  const rec = journey.recovery;
  const s = rec?.summary ?? {};
  const series = rec?.series ?? { weight: [], hb: [], b12: [], albumin: [], ecog: [] };
  const open = (k: keyof typeof SERIES_META) => { setKey(k); chart.open(); };
  const milestones = journey.phases.flatMap((p) => p.milestones.map((m) => ({ ...m, phase: p.phase }))).sort((a, b) => b.date.localeCompare(a.date));
  const shown = milestones.slice(0, compact ? 4 : 6);
  const hbThr = sex === "M" ? 13 : 12;
  const hb = s.hb_last ?? last(series.hb);
  const b12 = s.b12_last ?? last(series.b12);
  const alb = s.albumin_last ?? last(series.albumin);
  const ecog = s.ecog_last ?? last(series.ecog);
  const wpct = s.weight_change_pct ?? null;
  const nextIn = rec?.next_visit && simNow ? daysBetween(simNow, rec.next_visit) : null;
  const sinceLabel = s.gastrectomy ? "Weight since surgery" : "Weight since diagnosis";
  return (
    <div className="flex flex-col gap-6 min-w-0">
      <PhaseTrack phases={journey.phases} />

      {rec && (
        <section aria-label="Recovery">
          <div className="flex items-center gap-1 mb-2.5">
            <h3 className="text-label text-muted flex-1">Recovery{s.intent ? `, ${String(s.intent).toLowerCase()} intent` : ""}{s.gastrectomy ? ", after gastrectomy" : ""}</h3>
            <span className="text-micro text-muted">Survivorship schedule</span>
            <InfoHint title="Survivorship schedule" label="About the survivorship schedule" size={14} className="!w-6 !h-6 !min-w-6" about={SURVIVORSHIP_NOTE} />
          </div>
          <motion.div className={`grid gap-2.5 ${compact ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-3"}`} variants={stagger(0.03)} initial={reduce ? false : "hidden"} animate="show">
            <Tile label={sinceLabel} value={wpct === null ? "—" : signed(wpct, 1)} unit="%" series={series.weight} onOpen={series.weight.length ? () => open("weight") : undefined}
                  flag={wpct !== null && wpct <= -5} note={s.weight_last ? `${fmt(s.weight_last, 1)} kg now` : "Not weighed"} />
            <Tile label="Vitamin B12" value={b12 === null ? "—" : fmt(b12, 0)} unit="pg/mL" series={series.b12} onOpen={series.b12.length ? () => open("b12") : undefined}
                  flag={b12 !== null && b12 < 200} note={b12 === null ? (s.gastrectomy ? "Not checked yet, due after gastrectomy" : "Not checked") : b12 < 200 ? "Below 200 to 900" : "Normal 200 to 900"} />
            <Tile label="Haemoglobin" value={hb === null ? "—" : fmt(hb, 1)} unit="g/dL" series={series.hb} onOpen={series.hb.length ? () => open("hb") : undefined}
                  flag={hb !== null && hb < hbThr} note={hb === null ? "Not measured" : hb < hbThr ? `Below ${hbThr}` : "Normal"} />
            <Tile label="Albumin" value={alb === null ? "—" : fmt(alb, 1)} unit="g/dL" series={series.albumin} onOpen={series.albumin.length ? () => open("albumin") : undefined}
                  flag={alb !== null && alb < 3.5} note={alb === null ? "Not measured" : alb < 3.5 ? "Below 3.5, check nutrition" : "Normal 3.5 to 5"} />
            <Tile label="ECOG" value={ecog === null ? "—" : fmt(ecog, 0)} unit="of 4" series={series.ecog} onOpen={series.ecog.length ? () => open("ecog") : undefined}
                  flag={ecog !== null && ecog >= 3} note={ecog === null ? "Not scored" : ["Fully active", "Light work only", "Self-care, no work", "Limited self-care", "Bed-bound"][Math.round(ecog)] ?? ""} />
            <Tile label="Chemotherapy" value={rec.chemo.planned ? `${rec.chemo.done ?? 0}` : "—"} unit={rec.chemo.planned ? `of ${rec.chemo.planned} cycles` : undefined}
                  note={rec.chemo.planned ? ((rec.chemo.done ?? 0) >= rec.chemo.planned ? "Course complete" : "Course ongoing") : "No chemotherapy planned"}>
              {!!rec.chemo.planned && <Cycles done={rec.chemo.done ?? 0} planned={rec.chemo.planned} />}
            </Tile>
            <Tile label="Next visit" value={rec.next_visit ? date(rec.next_visit) : "—"} flag={nextIn !== null && nextIn < 0}
                  note={nextIn === null ? "None booked" : nextIn < 0 ? `${-nextIn} days overdue` : nextIn === 0 ? "Today" : `In ${nextIn} days`} />
            <Tile label="Missed visits" value={rec.missed_visits ?? 0} unit="in 12 months" flag={(rec.missed_visits ?? 0) > 0}
                  note={(rec.missed_visits ?? 0) > 0 ? "Follow up with the patient" : "None missed"} />
            <Tile label="Recurrence" value={rec.recurrence ? "Yes" : "None"} flag={!!rec.recurrence} note={rec.recurrence ?? "None recorded"} />
          </motion.div>
        </section>
      )}

      <section aria-label="Milestones">
        <div className="flex items-center mb-1.5">
          <h3 className="text-label text-muted flex-1">Milestones <span className="tabular">{milestones.length}</span></h3>
          {milestones.length > shown.length && (
            <button type="button" onClick={all.open} className="text-micro text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand rounded">All milestones</button>
          )}
        </div>
        <MilestoneList items={shown} />
      </section>

      <DetailModal {...chart.modalProps} title={SERIES_META[key].title} size="3xl" info={key === "b12" ? "Normal range about 200 to 900 pg/mL. After a gastrectomy, B12 falls over months to years; injections replace it." : key === "hb" ? `Dashed line: anaemia threshold (${hbThr} g/dL).` : undefined}>
        <MiniSeries title={SERIES_META[key].title} unit={SERIES_META[key].unit} points={(series[key] ?? []).map((p) => ({ ts: p.date, value: p.value }))} threshold={key === "hb" ? hbThr : undefined} height={320} />
      </DetailModal>
      <DetailModal {...all.modalProps} title="Milestones" size="2xl">
        <MilestoneList items={milestones} />
      </DetailModal>
    </div>
  );
}

function MilestoneList({ items }: { items: { date: string; label: string; kind: string }[] }) {
  if (!items.length) return <div className="text-micro text-muted py-2">No milestones yet</div>;
  return (
    <ol className="flex flex-col divide-y divide-hairline">
      {items.map((m, i) => (
        <li key={`${m.date}-${i}`} className="flex items-center gap-3 py-2 text-[14px] min-w-0">
          <span className="w-7 h-7 rounded-full bg-tile text-ink grid place-items-center shrink-0">{/chemo|cycle|b12/i.test(m.label) ? KIND_ICON.drug : KIND_ICON[m.kind] ?? <CalendarCheck size={14} aria-hidden />}</span>
          <span className="flex-1 min-w-0 truncate text-ink">{m.label}</span>
          <span className="text-micro text-muted tabular shrink-0">{date(m.date)}</span>
        </li>
      ))}
    </ol>
  );
}
