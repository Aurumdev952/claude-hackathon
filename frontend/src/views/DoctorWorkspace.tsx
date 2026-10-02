import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Input } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity, BellRing, Box, ChevronLeft, ChevronRight, ClipboardCheck, ClipboardList, Droplet, FlaskConical, Gauge, HeartHandshake, History, Hospital, ListChecks,
  ListTodo, MessageSquareText, RefreshCw, Search, Sparkles, UserRound, Weight,
} from "lucide-react";
import { get, post, qs } from "@/api/client";
import type { Alert, PatientRow } from "@/api/types";
import {
  BentoGrid, Card, DetailModal, ErrorNote, GridItem, InfoHint, Loading, PageHeader, PillTabs, Seg, Skeleton, Sparkline, useDetailModal,
} from "@/components/ui";
import { useRole } from "@/state/role";
import { date, fmt, signed } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { FacilityPicker } from "./doctor/FacilityPicker";
import { RISK_METHOD, ReasonBars, RiskSummary, SHAP_NOTE, TIERS_NOTE, Track } from "./doctor/RiskCard";
import { MiniSeries, Timeline } from "./doctor/Timeline";
import { AlertActions, PLANNABLE, SeverityMark, triggerLabel } from "./doctor/AlertActions";
import { ApprovePlanModal, type ApproveTarget } from "./doctor/ApprovePlanModal";
import { FollowUps } from "./doctor/FollowUps";
import { InRecovery } from "./doctor/InRecovery";
import { type WorkItem, isOpenPlan, nextTask, pathwayName, PLAN_STATUS, sortPlans, usePatientCare } from "./doctor/care";
import { CarePlanView, StepGlyph } from "./case/CarePlanView";
import { SuggestionLink } from "./doctor/SuggestedNext";
import { PatientAvatar } from "./doctor/PatientAvatar";
import { BandMark, Dot } from "./doctor/BandMark";

export { AlertActions } from "./doctor/AlertActions";

type Tab = "flagged" | "diagnosed" | "followups" | "recovery" | "alerts";
const ABOUT = "Patients of this facility ranked by their 12-month gastric-cancer risk, diagnosed cases, care-plan follow-ups, patients in recovery and the alerts inbox. Decision support only, synthetic data.";
const cap = (s: unknown) => { const t = String(s ?? "").toLowerCase().replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Doctor workspace (design v3): a plain patient list on the left (span 4), the selected patient's cards on the right. */
export default function DoctorWorkspace() {
  const { facilityId, facilityName, role } = useRole();
  const [tab, setTab] = useState<Tab>("flagged");
  const [selected, setSelected] = useState<number | null>(null);
  const newAlerts = useQuery({ queryKey: ["alerts", "inbox", "NEW", ""], queryFn: () => get<Alert[]>(`/alerts${qs({ status: "NEW" })}`), enabled: role === "doctor" && !!facilityId });
  const work = useQuery({ queryKey: ["care", "worklist"], queryFn: () => get<WorkItem[]>("/care/worklist"), enabled: role === "doctor" && !!facilityId });
  if (role !== "doctor" || !facilityId) return <FacilityPicker />;
  const nNew = newAlerts.data?.data?.length;
  const nLate = (work.data?.data ?? []).filter((w) => w.task.overdue_days > 0).length;
  const openPatient = (id: number) => { setSelected(id); setTab("flagged"); };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Doctor workspace" title={facilityName?.replace(" (Synthetic)", "")} icon={<Hospital size={18} />} info={ABOUT}
                  right={
                    <PillTabs ariaLabel="Workspace lists" selectedKey={tab} onSelectionChange={setTab} panelClassName="hidden" variant="surface"
                              items={[
                                { key: "flagged", label: "Risk-ranked patients", icon: <Gauge size={15} aria-hidden /> },
                                { key: "diagnosed", label: "Diagnosed cases", icon: <Activity size={15} aria-hidden /> },
                                { key: "followups", label: "Follow-ups", icon: <ListTodo size={15} aria-hidden />, count: nLate || undefined },
                                { key: "recovery", label: "In recovery", icon: <HeartHandshake size={15} aria-hidden /> },
                                { key: "alerts", label: "Alerts inbox", icon: <BellRing size={15} aria-hidden />, count: nNew || undefined },
                              ]} />
                  }
                  actions={
                    <Button radius="full" variant="flat" className="bg-surface text-ink h-10 px-4 text-[14px] font-medium data-[hover=true]:bg-tile dark:border dark:border-hairline"
                            startContent={<RefreshCw size={14} aria-hidden />}
                            onPress={() => useRole.setState({ facilityId: null, facilityName: null })}>Change facility</Button>
                  } />
      {tab === "followups" ? <FollowUps onOpenPatient={openPatient} /> : tab === "recovery" ? <InRecovery onOpenPatient={openPatient} /> : (
      <div className="grid grid-cols-12 gap-5 items-start">
        <div className="col-span-12 lg:col-span-5 xl:col-span-4 lg:sticky lg:top-0 flex flex-col lg:h-[calc(100vh-180px)] min-h-[560px]">
          {tab === "alerts" ? <AlertsInbox onOpen={setSelected} selected={selected} /> : <PatientList status={tab} selected={selected} onSelect={setSelected} />}
        </div>
        <div className="col-span-12 lg:col-span-7 xl:col-span-8 min-w-0">{selected ? <PatientPanel key={selected} patientId={selected} /> : <Empty />}</div>
      </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <Card className="min-h-[420px]" bodyClassName="flex flex-col items-center justify-center gap-3 text-center">
      <span className="w-12 h-12 rounded-full border border-hairline text-ink grid place-items-center" aria-hidden><UserRound size={20} /></span>
      <div className="text-title text-ink">Select a patient</div>
      <div className="text-label font-normal text-muted">Pick someone from the list to see their risk, alerts and timeline.</div>
    </Card>
  );
}

function Pager({ total, page, setPage }: { total: number; page: number; setPage: (f: (p: number) => number) => void }) {
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="flex items-center justify-between px-6 py-3 border-t border-hairline text-label text-muted">
      <span className="tabular"><span className="text-ink font-semibold">{total.toLocaleString()}</span> patients</span>
      <div className="flex items-center gap-1">
        <Button isIconOnly size="sm" radius="full" variant="light" className="text-ink" isDisabled={page <= 1} onPress={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={16} /></Button>
        <span className="tabular px-1">{page} of {pages}</span>
        <Button isIconOnly size="sm" radius="full" variant="light" className="text-ink" isDisabled={page >= pages} onPress={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={16} /></Button>
      </div>
    </div>
  );
}

/** Search field for the list cards: grey fill, no border (reference header search). */
function ListSearch({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <Input size="sm" radius="full" aria-label={label} placeholder={placeholder} value={value} onValueChange={onChange}
           startContent={<Search size={15} className="text-muted shrink-0" aria-hidden />}
           classNames={{ base: "flex-1 min-w-[140px]", inputWrapper: "bg-tile data-[hover=true]:bg-tile-hover group-data-[focus=true]:bg-tile shadow-none h-10 px-4", input: "text-[14px] placeholder:text-muted" }} />
  );
}

/** A 56px+ list row: avatar, name, muted second line, right block. Selected = grey tile fill. */
function Row({ on, onPress, title, avatar, name, sub, right }: {
  on: boolean; onPress: () => void; title?: string; avatar: ReactNode; name: ReactNode; sub: ReactNode; right: ReactNode;
}) {
  return (
    <button onClick={onPress} aria-current={on ? "true" : undefined} title={title}
            className={`w-full min-h-[60px] text-left px-3 py-2.5 rounded-tile flex items-center gap-3 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal
                        ${on ? "bg-tile" : "hover:bg-tile/70"}`}>
      {avatar}
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] leading-5 font-semibold text-ink truncate">{name}</span>
        <span className="flex items-center gap-3 text-micro font-normal text-muted tabular mt-0.5 min-w-0 whitespace-nowrap overflow-hidden">{sub}</span>
      </span>
      {right}
    </button>
  );
}

function PatientList({ status, selected, onSelect }: { status: "flagged" | "diagnosed"; selected: number | null; onSelect: (id: number) => void }) {
  const reduce = useReducedMotion();
  const [page, setPage] = useState(1);
  const [band, setBand] = useState<string>("");
  const [q, setQ] = useState("");
  const [qDebounced, setQd] = useState("");
  useEffect(() => { const t = setTimeout(() => setQd(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(1), [status, band, qDebounced]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["patients", status, band, qDebounced, page],
    queryFn: () => get<PatientRow[]>(`/patients${qs({ status, risk_band: band || undefined, q: qDebounced || undefined, page, page_size: 25 })}`),
  });
  const rows = data?.data ?? [];
  const total = Number((data as any)?.total ?? 0);
  useEffect(() => { if (!selected && rows.length) onSelect(rows[0].patient_id); }, [rows, selected, onSelect]);
  return (
    <Card padding="none" className="flex-1 min-h-0 overflow-hidden" bodyClassName="flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
        <ListSearch value={q} onChange={setQ} label="Search patients" placeholder="Name or ID" />
        {status === "flagged" && (
          <Seg label="Risk band" value={band} onChange={setBand} variant="glass"
               options={[{ value: "", label: "All" }, { value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }]} />
        )}
      </div>
      {error && <div className="px-4 pb-3"><ErrorNote error={error} /></div>}
      {isLoading ? <div className="p-4"><Skeleton variant="list" rows={8} label="Loading patients" /></div> : (
        <motion.ul className="flex-1 overflow-auto px-2 pb-2 flex flex-col" aria-label="Patients" variants={stagger(0.02)} initial={reduce ? false : "hidden"} animate="show">
          {rows.map((p) => {
            const on = selected === p.patient_id;
            const prob = p.ensemble_prob ?? 0;
            return (
              <motion.li key={p.patient_id} variants={itemEnter}>
                <Row on={on} onPress={() => onSelect(p.patient_id)}
                     title={status === "flagged" ? (p.top_reasons ?? []).map((r) => r.label).join("; ") : undefined}
                     avatar={<PatientAvatar name={p.name} size="sm" className={on ? "!bg-surface" : ""} />}
                     name={<span className="flex items-center gap-2 min-w-0"><span className="truncate">{p.name}</span>
                       {p.open_alerts > 0 && (
                         <span className="shrink-0 inline-flex items-center gap-0.5 text-micro text-muted tabular" aria-label={`${p.open_alerts} open alert${p.open_alerts > 1 ? "s" : ""}`} title="Open alerts">
                           <BellRing size={12} aria-hidden />{p.open_alerts}
                         </span>
                       )}</span>}
                     sub={<><span>{p.display_id}</span><span className="truncate">{status === "flagged" ? `Seen ${date(p.last_visit)}` : `Diagnosed ${date(p.dx_date)}`}</span></>}
                     right={status === "flagged" ? (
                       <span className="w-[76px] sm:w-[118px] shrink-0 flex flex-col gap-2">
                         <span className="flex items-center justify-between gap-1">
                           <BandMark band={p.risk_band} labelClassName="max-sm:sr-only" />
                           <span className="text-[14px] leading-5 font-semibold tabular text-ink">{fmt(100 * prob)}%</span>
                         </span>
                         <Track value={prob} height={4} label={`${p.name} risk`} delay={0} />
                       </span>
                     ) : (
                       <span className="shrink-0 rounded-full bg-tile px-2.5 py-1 text-micro text-muted">{cap(p.case_status ?? "case")}</span>
                     )} />
              </motion.li>
            );
          })}
          {!rows.length && <li className="p-8 text-center text-label text-muted">No patients match</li>}
        </motion.ul>
      )}
      <Pager total={total} page={page} setPage={setPage} />
    </Card>
  );
}

/** Measurement tile (reference "Prady Lhambel 89%" tile): grey fill, muted label, medium number + unit, one muted line or
 * a dot + text status, sky sparkline. Opens a chart modal when it has a series. */
function MeasureTile({ label, value, unit, decimals = 1, note, alert, spark, onPress }: {
  label: string; value: number | null | undefined; unit?: string; decimals?: number; note?: ReactNode; alert?: boolean;
  spark?: number[]; onPress?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-label text-muted">
        <span className="truncate">{label}</span>
        {onPress && <ChevronRight size={14} className="text-faint shrink-0" aria-hidden />}
      </span>
      <span className="flex items-baseline gap-1 min-w-0 mt-1">
        <span className="text-[26px] leading-8 font-medium tracking-[-0.01em] tabular text-ink">{value === null || value === undefined ? "—" : fmt(value, decimals)}</span>
        {unit && <span className="text-label font-normal text-muted truncate">{unit}</span>}
      </span>
      <span className="flex items-end justify-between gap-3 min-h-[24px] mt-1.5">
        <span className={`inline-flex items-center gap-1.5 text-micro ${alert ? "text-ink" : "text-muted"} whitespace-nowrap`}>{alert && <Dot level="high" />}{note}</span>
        {spark && spark.length > 1 && <span className="w-[72px] shrink-0"><Sparkline values={spark} height={24} area={false} /></span>}
      </span>
    </>
  );
  const cls = "text-left rounded-tile bg-tile px-4 py-3.5 min-w-0 flex flex-col";
  if (!onPress) return <motion.div variants={itemEnter} className={cls}>{body}</motion.div>;
  return (
    <motion.button type="button" onClick={onPress} variants={itemEnter} aria-label={`${label}: open chart`}
                   className={`${cls} cursor-pointer transition-colors hover:bg-tile-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal`}>{body}</motion.button>
  );
}

/** Quiet pill for the patient header chips row. */
const Chip = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span title={title} className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-tile text-label text-ink whitespace-nowrap">{children}</span>
);

function PatientPanel({ patientId }: { patientId: number }) {
  const nav = useNavigate();
  const p = useQuery({ queryKey: ["patients", "one", patientId], queryFn: () => get<any>(`/patients/${patientId}`) });
  const tl = useQuery({ queryKey: ["patients", "timeline", patientId], queryFn: () => get<any>(`/patients/${patientId}/timeline`) });
  const alerts = useQuery({ queryKey: ["alerts", "patient", patientId], queryFn: () => get<Alert[]>(`/alerts`) });
  const ex = useMutation({ mutationFn: () => post<any>(`/patients/${patientId}/explain`, {}) });
  const explainModal = useDetailModal();
  const chart = useDetailModal();
  const [chartKey, setChartKey] = useState<"hb" | "weight">("hb");
  const [planFor, setPlanFor] = useState<ApproveTarget | null>(null);
  const h = p.data?.data;
  const events: any[] = tl.data?.data?.events ?? [];
  const recent = useMemo(() => {
    if (!h) return [];
    const cutoff = Math.min(Date.now() - 3 * 365 * 86400000, Date.parse(h.last_encounter_date ?? new Date().toISOString()) - 3 * 365 * 86400000);
    return events.filter((e) => Date.parse(e.ts) >= cutoff);
  }, [events, h]);
  if (p.isLoading) return <Skeleton variant="card" h={520} label="Loading patient" />;
  if (p.error) return <ErrorNote error={p.error} />;
  const myAlerts = (alerts.data?.data ?? []).filter((a) => a.patient_id === patientId);
  const hb: { ts: string; value: number }[] = tl.data?.data?.series?.hb ?? [];
  const wt: { ts: string; value: number }[] = tl.data?.data?.series?.weight ?? [];
  const hbThr = h.sex === "M" ? 13 : 12;
  const hbLast = hb.length ? hb[hb.length - 1].value : null;
  const wLast = wt.length ? wt[wt.length - 1].value : null;
  const wChange = wt.length > 1 && wt[0].value ? (100 * (wt[wt.length - 1].value - wt[0].value)) / wt[0].value : null;
  const abnormalLabs = recent.filter((e) => e.event_type === "LAB" && e.is_abnormal).length;
  const visits12 = events.filter((e) => e.event_type === "VISIT" && Date.parse(e.ts) >= Date.parse(h.last_encounter_date ?? new Date().toISOString()) - 365 * 86400000).length;
  const openChart = (k: "hb" | "weight") => { setChartKey(k); chart.open(); };
  const explain = () => { explainModal.open(); if (!ex.data && !ex.isPending) ex.mutate(); };
  const homeFacility = String(h.home_facility_name ?? "").replace(" (Synthetic)", "");
  const risk = h.risk;
  const band = risk?.risk_band as string | undefined;
  const nNew = myAlerts.filter((a) => a.status === "NEW").length;
  // "Start care plan" when no open alert can be approved into a plan (e.g. a diagnosed patient starting treatment support)
  const canApprove = myAlerts.some((a) => PLANNABLE.has(a.trigger) && a.status !== "DISMISSED" && a.status !== "REFERRED");
  return (
    <BentoGrid step={0.04}>
      <GridItem span={12}>
        <Card padding="md">
          <div className="flex items-center gap-5 flex-wrap">
            <PatientAvatar name={h.name} size="lg" />
            <div className="min-w-0 flex-1 basis-[260px]">
              <div className="flex items-center gap-0.5 min-w-0">
                <h2 className="text-h1 text-ink truncate">{h.name}</h2>
                <InfoHint title={h.name} label="About this patient"
                          about={<>Home facility {homeFacility}. Cohort entry {date(h.entry_date)} ({String(h.entry_reason).toLowerCase().replace(/_/g, " ")}).</>}
                          notes={`Last encounter ${date(h.last_encounter_date)}`} />
              </div>
              <div className="text-label font-normal text-muted tabular mt-0.5">{h.display_id}</div>
            </div>
            <div className="flex items-center gap-2 max-sm:w-full flex-wrap">
              <Button radius="full" variant="flat" className="bg-tile text-ink h-11 px-5 text-[14px] font-medium data-[hover=true]:bg-tile-hover max-sm:flex-1"
                      startContent={<MessageSquareText size={16} aria-hidden />} onPress={explain}>Explain</Button>
              {!canApprove && (
                <Button radius="full" variant="flat" className="bg-tile text-ink h-11 px-5 text-[14px] font-medium data-[hover=true]:bg-tile-hover max-sm:flex-1"
                        startContent={<ClipboardCheck size={16} aria-hidden />}
                        onPress={() => setPlanFor({ patientId, isCase: !!h.is_case, label: <>{h.name} <span className="tabular">{h.display_id}</span></> })}>Start care plan</Button>
              )}
              <Button radius="full" className="bg-signal-strong text-signal-on font-semibold h-11 px-5 text-[14px] data-[hover=true]:bg-signal-text max-sm:flex-[2]"
                      startContent={<Box size={16} aria-hidden />} onPress={() => nav(`/doctor/case/${patientId}`)}>Analyse case in 3D</Button>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-5">
            <Chip>{h.sex === "F" ? "Female" : "Male"}</Chip>
            <Chip>{h.age} years</Chip>
            <Chip title="District">{h.district_name ?? h.district_code}</Chip>
            {h.is_case && <Chip><Dot level="high" />{cap(h.case_status)} gastric cancer</Chip>}
            {h.is_case && <Chip>Diagnosed {date(h.dx_date)}</Chip>}
            {nNew > 0 && <Chip><BellRing size={13} className="text-muted" aria-hidden />{nNew} new alert{nNew === 1 ? "" : "s"}</Chip>}
          </div>
        </Card>
      </GridItem>

      {risk ? (
        <>
          <GridItem span={{ md: 6 }}>
            <Card title="Risk" icon={<Gauge size={16} />} info={{ method: RISK_METHOD, notes: TIERS_NOTE }}
                  actions={band === "HIGH" ? <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-signal-strong text-signal-on text-micro font-semibold"><span className="w-1.5 h-1.5 rounded-full bg-signal-on" aria-hidden />High</span>
                         : band ? <span className="inline-flex items-center h-7 px-3 rounded-full bg-tile text-micro text-muted">{cap(band)}</span> : undefined}>
              <RiskSummary risk={risk} showBand={false} />
            </Card>
          </GridItem>
          <GridItem span={{ md: 6 }}>
            <Card title="Why flagged" icon={<ListChecks size={16} />} info={SHAP_NOTE}>
              <ReasonBars reasons={risk.top_reasons ?? []} />
            </Card>
          </GridItem>
        </>
      ) : (
        <GridItem span={12}>
          <Card title="Risk" icon={<Gauge size={16} />} info={{ method: RISK_METHOD }}>
            <RiskSummary risk={null} />
          </Card>
        </GridItem>
      )}

      <GridItem span={{ md: 6 }}>
        <Card title="Alerts" icon={<BellRing size={16} />} info="Open alerts for this patient. Acknowledge, mark as referred, or dismiss with a reason; every action is logged.">
          {alerts.isLoading ? <Skeleton variant="list" rows={3} /> : <AlertActions alerts={myAlerts} variant="rows" isCase={!!h.is_case} />}
        </Card>
      </GridItem>
      <GridItem span={{ md: 6 }}>
        <CarePlanCard patientId={patientId} subtitle={h.name} onStart={(pathway) => setPlanFor({ patientId, isCase: !!h.is_case, pathway, label: <>{h.name} <span className="tabular">{h.display_id}</span></> })} />
      </GridItem>
      <GridItem span={12}>
        <Card title="Latest measurements" icon={<FlaskConical size={16} />} info="Latest values with their trend over the window. Haemoglobin is compared with the WHO anaemia threshold for the patient's sex.">
          <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-2.5" variants={stagger(0.04)} initial="hidden" animate="show">
            <MeasureTile label="Haemoglobin" value={hbLast} unit="g/dL" spark={hb.map((x) => x.value)} onPress={() => openChart("hb")}
                         alert={hbLast !== null && hbLast < hbThr} note={hbLast === null ? "Not measured" : hbLast < hbThr ? `Below ${hbThr}` : "Normal"} />
            <MeasureTile label="Weight" value={wLast} unit="kg" spark={wt.map((x) => x.value)} onPress={() => openChart("weight")}
                         alert={wChange !== null && wChange <= -5} note={wChange === null ? "No trend" : `${signed(wChange, 1, "%")} in window`} />
            <MeasureTile label="Abnormal labs" value={abnormalLabs} decimals={0} unit="in 3 years" note={abnormalLabs ? "Review results" : "None"} />
            <MeasureTile label="Visits" value={visits12} decimals={0} unit="in 12 months" note={visits12 >= 6 ? "Frequent" : "Usual"} />
          </motion.div>
        </Card>
      </GridItem>

      <GridItem span={12}>
        <Card title="Timeline" icon={<History size={16} />}
              info={{ about: "Last 3 years of visits, symptoms, diagnoses, labs, medicines, orders and endoscopy. Dashed rings mark events the models weighed most. Hover a dot for details." }}>
          {tl.isLoading ? <Loading h={224} /> : <Timeline events={recent} height={224} />}
        </Card>
      </GridItem>

      <DetailModal {...chart.modalProps} title={chartKey === "hb" ? "Haemoglobin" : "Weight"} icon={chartKey === "hb" ? <Droplet size={18} /> : <Weight size={18} />} size="3xl"
                   subtitle={h.name} info={chartKey === "hb" ? `Dashed line: anaemia threshold (${hbThr} g/dL for ${h.sex === "M" ? "men" : "women"}).` : undefined}>
        {chartKey === "hb" ? <MiniSeries title="Haemoglobin" unit="g/dL" points={hb} threshold={hbThr} height={320} /> : <MiniSeries title="Weight" unit="kg" points={wt} height={320} />}
      </DetailModal>
      <DetailModal {...explainModal.modalProps} title="Patient summary" icon={<Sparkles size={18} />} size="2xl" subtitle={h.name}>
        {ex.isPending ? <Skeleton variant="text" rows={5} label="Summarising" /> : ex.error ? <ErrorNote error={ex.error} /> : ex.data ? (
          <div className="flex flex-col gap-4">
            <p className="text-[15px] leading-[24px] text-ink max-w-[640px]">{ex.data.data.summary}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted">
              <span>{ex.data.data.disclaimer}</span>
              <span>Source: {ex.data.data.generated_by}</span>
            </div>
          </div>
        ) : null}
      </DetailModal>
      <ApprovePlanModal target={planFor} isOpen={!!planFor} onOpenChange={(o) => { if (!o) setPlanFor(null); }} />
    </BentoGrid>
  );
}

/** Compact care plan card for the patient panel: the active plan, its next step and a status chip; the arrow opens every
 * plan with its steps and messages. */
function CarePlanCard({ patientId, subtitle, onStart }: { patientId: number; subtitle?: ReactNode; onStart: (pathway?: string) => void }) {
  const care = usePatientCare(patientId);
  const suggested = care.data?.data?.suggested_next;
  const plans = sortPlans(care.data?.data?.plans ?? []);
  const simNow = (care.data?.meta?.sim_time as string | undefined) ?? null;
  const plan = plans.find(isOpenPlan) ?? plans[0] ?? null;
  const next = plan ? nextTask(plan) : null;
  const done = plan ? plan.tasks.filter((t) => t.status === "COMPLETED").length : 0;
  const sent = plan ? plan.events.filter((e) => e.kind === "NOTIFIED").length : 0;
  return (
    <Card className="h-full" title="Care plan" icon={<ClipboardList size={16} />} detailLabel="Open care plans"
          info="The care plan approved for this patient: its steps close automatically when the EMR shows them done (an endoscopy, a test, a visit). Reminders go out by app, SMS and community health worker."
          detail={plans.length ? { title: "Care plans", icon: <ClipboardList size={18} />, size: "3xl", subtitle, children: <CarePlanView plans={plans} simNow={simNow} /> } : undefined}
          actions={plan ? <span className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-micro ${plan.status === "ESCALATED" ? "bg-signal-soft text-signal-text" : "bg-tile text-muted"}`}>
            {plan.status === "ESCALATED" && <Dot level="high" />}{PLAN_STATUS[plan.status] ?? plan.status}</span> : undefined}>
      {care.isLoading ? <Skeleton variant="list" rows={2} /> : !plan ? (
        <div className="flex flex-col items-center justify-center gap-3 py-5 text-label text-muted text-center">
          No care plan yet
          <Button size="sm" radius="full" className="h-9 px-4 bg-ink text-ink-on text-[13px] font-semibold" startContent={<ClipboardCheck size={14} aria-hidden />} onPress={() => onStart()}>Start care plan</Button>
          <SuggestionLink suggestions={suggested} onStart={(sg) => onStart(sg.pathway)} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-label font-normal text-muted">{pathwayName(plan)}</div>
            <div className="text-[13px] text-muted tabular mt-0.5">{done} of {plan.tasks.length} steps done, {sent} message{sent === 1 ? "" : "s"} sent</div>
          </div>
          {next ? (
            <div className="rounded-tile bg-tile px-4 py-3 flex items-center gap-3">
              <StepGlyph status={next.status} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink truncate">{next.title}</div>
                <div className="text-micro text-muted tabular">Next step, due {date(next.due_at)}</div>
              </div>
            </div>
          ) : <div className="text-label text-muted">All steps closed {plan.closed_sim ? date(plan.closed_sim) : ""}</div>}
          <SuggestionLink suggestions={suggested} onStart={(sg) => onStart(sg.pathway)} />
        </div>
      )}
    </Card>
  );
}

function AlertsInbox({ onOpen, selected }: { onOpen: (id: number) => void; selected: number | null }) {
  const reduce = useReducedMotion();
  const [status, setStatus] = useState("NEW");
  const [sev, setSev] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["alerts", "inbox", status, sev], queryFn: () => get<Alert[]>(`/alerts${qs({ status: status || undefined, severity: sev || undefined })}`) });
  const rows = data?.data ?? [];
  return (
    <Card padding="none" className="flex-1 min-h-0 overflow-hidden" bodyClassName="flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
        <Seg label="Alert status" value={status} onChange={setStatus} variant="glass"
             options={[{ value: "NEW", label: "New" }, { value: "ACKNOWLEDGED", label: "Seen", title: "Acknowledged" }, { value: "REFERRED", label: "Referred" }, { value: "DISMISSED", label: "Dismissed" }, { value: "", label: "All" }]} />
        <Seg label="Severity" value={sev} onChange={setSev} variant="glass" options={[{ value: "", label: "Any" }, { value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }]} />
      </div>
      {isLoading ? <div className="p-4"><Skeleton variant="list" rows={8} label="Loading alerts" /></div> : (
        <motion.ul className="flex-1 overflow-auto px-2 pb-2 flex flex-col" aria-label="Alerts" variants={stagger(0.02)} initial={reduce ? false : "hidden"} animate="show">
          {rows.map((a) => (
            <motion.li key={a.alert_id} variants={itemEnter}>
              <Row on={selected === a.patient_id} onPress={() => onOpen(a.patient_id)} title={a.summary}
                   avatar={<PatientAvatar name={a.name} size="sm" className={selected === a.patient_id ? "!bg-surface" : ""} />}
                   name={a.name}
                   sub={<><span className="truncate">{triggerLabel(a.trigger)}</span><span className="shrink-0">{date(a.created_at)}</span></>}
                   right={<span className="shrink-0 w-[64px] flex justify-end"><SeverityMark severity={a.severity} /></span>} />
            </motion.li>
          ))}
          {!rows.length && <li className="p-8 text-center text-label text-muted">No alerts here</li>}
        </motion.ul>
      )}
    </Card>
  );
}
