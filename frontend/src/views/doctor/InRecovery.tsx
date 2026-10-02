import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { Box, HeartHandshake, Route } from "lucide-react";
import { get } from "@/api/client";
import type { PatientRow } from "@/api/types";
import { Card, ErrorNote, Seg, Skeleton } from "@/components/ui";
import { date } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { JourneyView } from "@/views/case/JourneyView";
import { CarePlanView } from "@/views/case/CarePlanView";
import { Dot } from "./BandMark";
import { daysBetween, useJourney, usePatientCare } from "./care";
import { PatientAvatar } from "./PatientAvatar";

type JourneyFields = {
  phase: string | null; phase_status: string | null; phase_start: string | null; intent: string | null; gastrectomy: boolean | null;
  missed_visits: number | null; next_visit: string | null; recurrence: string | null; chemo_done: number | null; chemo_planned: number | null;
};
type RecRow = PatientRow & { journey?: JourneyFields };

/** Phase order for grouping (treatment first: those patients need the most coordination). */
const ORDER = ["Treatment", "Recovery", "Surveillance", "Survivorship", "Palliative", "Staging", "Diagnosis", "Endoscopy", "Deceased"];
const rank = (p: string | null | undefined) => { const i = ORDER.indexOf(p ?? ""); return i < 0 ? ORDER.length - 1 : i; };

/** In recovery (plan §3): diagnosed patients grouped by journey phase, missed visits flagged; the selected patient's
 * journey (phase track, recovery tiles) and care plan on the right. */
export function InRecovery({ onOpenPatient }: { onOpenPatient: (id: number) => void }) {
  const reduce = useReducedMotion();
  const [show, setShow] = useState<"living" | "all">("living");
  const q = useQuery({ queryKey: ["patients", "diagnosed", "recovery"], queryFn: () => get<RecRow[]>("/patients?status=diagnosed&page_size=100") });
  const simNow = (q.data?.meta?.sim_time as string | undefined) ?? null;
  const groups = useMemo(() => {
    const rows = (q.data?.data ?? []).filter((r) => show === "all" || r.journey?.phase !== "Deceased");
    const by = new Map<string, RecRow[]>();
    for (const r of [...rows].sort((a, b) => (b.journey?.missed_visits ?? 0) - (a.journey?.missed_visits ?? 0))) {
      const k = r.journey?.phase ?? "Diagnosis";
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [q.data, show]);
  const flat = groups.flatMap(([, r]) => r);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => { if (flat.length && (!sel || !flat.some((r) => r.patient_id === sel))) setSel(flat[0].patient_id); }, [flat, sel]);
  const current = flat.find((r) => r.patient_id === sel) ?? null;
  const missed = flat.filter((r) => (r.journey?.missed_visits ?? 0) > 0).length;
  return (
    <div className="grid grid-cols-12 gap-5 items-start">
      <Card className="col-span-12 lg:col-span-5 xl:col-span-4" padding="none" title="In recovery" icon={<HeartHandshake size={16} />}
            info={{ about: "Patients diagnosed with gastric cancer at this facility, grouped by where they are in their journey: treatment, recovery and surveillance after curative surgery, or palliative care.", notes: `${missed} patient${missed === 1 ? "" : "s"} missed at least one visit in the last 12 months.` }}
            actions={<Seg label="Show" value={show} onChange={setShow} variant="glass" options={[{ value: "living", label: "Living" }, { value: "all", label: "All" }]} />}>
        {q.error && <div className="px-6 pb-4"><ErrorNote error={q.error} /></div>}
        {q.isLoading ? <div className="px-6 pb-6"><Skeleton variant="list" rows={8} label="Loading patients" /></div> : (
          <div className="px-2 pb-3 flex flex-col gap-3 lg:max-h-[calc(100vh-260px)] overflow-auto">
            {groups.map(([phase, rows]) => (
              <section key={phase} aria-label={`${phase} phase`}>
                <h3 className="px-4 py-1 text-micro text-muted">{phase} <span className="tabular">{rows.length}</span></h3>
                <motion.ul className="flex flex-col" variants={stagger(0.02)} initial={reduce ? false : "hidden"} animate="show" aria-label={`${phase} patients`}>
                  {rows.map((r) => {
                    const on = r.patient_id === sel;
                    const j = r.journey;
                    const late = j?.next_visit && simNow ? daysBetween(j.next_visit, simNow) : null;
                    return (
                      <motion.li key={r.patient_id} variants={itemEnter}>
                        <button type="button" onClick={() => setSel(r.patient_id)} aria-current={on ? "true" : undefined}
                                className={`w-full min-h-[60px] text-left px-3 py-2.5 rounded-tile flex items-center gap-3 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal ${on ? "bg-tile" : "hover:bg-tile/70"}`}>
                          <PatientAvatar name={r.name} size="sm" className={on ? "!bg-surface" : ""} />
                          <span className="flex-1 min-w-0">
                            <span className="block text-[14px] leading-5 font-semibold text-ink truncate">{r.name}</span>
                            <span className="flex items-center gap-3 text-micro font-normal text-muted tabular mt-0.5 whitespace-nowrap overflow-hidden">
                              <span>{r.display_id}</span>
                              <span className="truncate">{j?.phase_start ? `Since ${date(j.phase_start)}` : `Diagnosed ${date(r.dx_date)}`}</span>
                            </span>
                          </span>
                          <span className="shrink-0 text-right text-micro tabular">
                            {(j?.missed_visits ?? 0) > 0 ? <span className="inline-flex items-center gap-1.5 text-ink"><Dot level="high" />{j!.missed_visits} missed</span>
                              : late !== null && late > 0 && late <= 180 && j?.phase !== "Deceased" ? <span className="inline-flex items-center gap-1.5 text-ink"><Dot level="medium" />Visit {late} days late</span>
                              : late !== null && late > 180 && j?.phase !== "Deceased" ? <span className="text-muted">No visit booked</span>
                              : j?.gastrectomy ? <span className="text-muted">After surgery</span> : <span className="text-muted">{j?.intent ?? ""}</span>}
                          </span>
                        </button>
                      </motion.li>
                    );
                  })}
                </motion.ul>
              </section>
            ))}
            {!flat.length && <div className="p-8 text-center text-label text-muted">No diagnosed patients at this facility</div>}
          </div>
        )}
      </Card>
      <div className="col-span-12 lg:col-span-7 xl:col-span-8 min-w-0">{current && <JourneyPanel row={current} simNow={simNow} onOpenPatient={onOpenPatient} />}</div>
    </div>
  );
}

function JourneyPanel({ row, simNow, onOpenPatient }: { row: RecRow; simNow: string | null; onOpenPatient: (id: number) => void }) {
  const nav = useNavigate();
  const j = useJourney(row.patient_id);
  const care = usePatientCare(row.patient_id);
  return (
    <Card padding="md" title="Journey" icon={<Route size={16} />} key={row.patient_id}
          actions={
            <div className="flex gap-1.5">
              <Button size="sm" radius="full" variant="flat" className="h-9 px-4 bg-tile text-ink text-[13px] font-medium" onPress={() => onOpenPatient(row.patient_id)}>Open patient</Button>
              <Button size="sm" radius="full" variant="flat" className="h-9 px-4 bg-tile text-ink text-[13px] font-medium" startContent={<Box size={14} aria-hidden />} onPress={() => nav(`/doctor/case/${row.patient_id}`)}>Case in 3D</Button>
            </div>
          }>
      <div className="flex items-center gap-3 mb-5 -mt-1">
        <PatientAvatar name={row.name} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-ink truncate">{row.name}</div>
          <div className="text-micro text-muted tabular">{row.display_id}, {row.age} years, diagnosed {date(row.dx_date)}</div>
        </div>
      </div>
      {j.isLoading ? <Skeleton variant="card" h={320} label="Loading journey" /> : j.error ? <ErrorNote error={j.error} />
        : j.data ? <JourneyView journey={j.data.data} simNow={simNow} sex={row.sex} /> : null}
      {(care.data?.data?.plans ?? []).length > 0 && (
        <section className="mt-6 pt-5 border-t border-hairline" aria-label="Care plan">
          <h3 className="text-label text-muted mb-3">Care plan</h3>
          <CarePlanView plans={care.data!.data.plans} simNow={simNow} />
        </section>
      )}
    </Card>
  );
}
