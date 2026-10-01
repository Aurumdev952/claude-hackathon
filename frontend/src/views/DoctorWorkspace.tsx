import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Input } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity, BellRing, Box, CalendarDays, ChevronLeft, ChevronRight, Droplet, FlaskConical, Gauge, History, Hospital, MapPin, MessageSquareText,
  RefreshCw, Search, Sparkles, UserRound, Users, Weight,
} from "lucide-react";
import { get, post, qs } from "@/api/client";
import type { Alert, PatientRow } from "@/api/types";
import {
  BentoGrid, Card, DetailModal, ErrorNote, GridItem, InfoHint, Loading, PageHeader, PillTabs, RiskScoreBar, Seg, Skeleton, Sparkline, StatTile,
  StatusChip, useDetailModal, type StatusKind,
} from "@/components/ui";
import { BandChip, SeverityChip } from "@/components/ui/Status";
import { useRole } from "@/state/role";
import { date, fmt, signed } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { FacilityPicker } from "./doctor/FacilityPicker";
import { RISK_METHOD, RiskCard } from "./doctor/RiskCard";
import { MiniSeries, Timeline } from "./doctor/Timeline";
import { AlertActions, triggerLabel } from "./doctor/AlertActions";
import { PatientAvatar } from "./doctor/PatientAvatar";

export { AlertActions } from "./doctor/AlertActions";

type Tab = "flagged" | "diagnosed" | "alerts";
const ABOUT = "Patients of this facility ranked by their 12-month gastric-cancer risk, diagnosed cases, and the alerts inbox. Decision support only — synthetic data.";

/** V7 Doctor workspace (MedEx-style bento): patient list on the left, the selected patient's cards on the right. */
export default function DoctorWorkspace() {
  const { facilityId, facilityName, role } = useRole();
  const [tab, setTab] = useState<Tab>("flagged");
  const [selected, setSelected] = useState<number | null>(null);
  const newAlerts = useQuery({ queryKey: ["alerts", "inbox", "NEW", ""], queryFn: () => get<Alert[]>(`/alerts${qs({ status: "NEW" })}`), enabled: role === "doctor" && !!facilityId });
  if (role !== "doctor" || !facilityId) return <FacilityPicker />;
  const nNew = newAlerts.data?.data?.length;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="Doctor workspace" title={facilityName?.replace(" (Synthetic)", "")} icon={<Hospital size={20} />} info={ABOUT}
                  right={
                    <PillTabs ariaLabel="Workspace lists" selectedKey={tab} onSelectionChange={setTab} panelClassName="hidden"
                              items={[
                                { key: "flagged", label: "Risk-ranked patients", icon: <Gauge size={14} aria-hidden /> },
                                { key: "diagnosed", label: "Diagnosed cases", icon: <Activity size={14} aria-hidden /> },
                                { key: "alerts", label: "Alerts inbox", icon: <BellRing size={14} aria-hidden />, count: nNew || undefined },
                              ]} />
                  }
                  actions={
                    <Button size="sm" radius="full" variant="flat" className="bg-surface border border-border text-fg h-9" startContent={<RefreshCw size={14} aria-hidden />}
                            onPress={() => useRole.setState({ facilityId: null, facilityName: null })}>Change facility</Button>
                  } />
      <div className="grid grid-cols-12 gap-4 items-start">
        <div className="col-span-12 lg:col-span-5 xl:col-span-4 lg:sticky lg:top-0 flex flex-col lg:h-[calc(100vh-152px)] min-h-[560px]">
          {tab === "alerts" ? <AlertsInbox onOpen={setSelected} selected={selected} /> : <PatientList status={tab} selected={selected} onSelect={setSelected} />}
        </div>
        <div className="col-span-12 lg:col-span-7 xl:col-span-8 min-w-0">{selected ? <PatientPanel key={selected} patientId={selected} /> : <Empty />}</div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <Card className="min-h-[420px] items-center justify-center text-center" bodyClassName="flex flex-col items-center justify-center gap-3">
      <span className="w-14 h-14 rounded-full bg-accent-soft text-accent grid place-items-center" aria-hidden><UserRound size={24} /></span>
      <div className="text-title text-fg">Select a patient</div>
    </Card>
  );
}

function Pager({ total, page, setPage }: { total: number; page: number; setPage: (f: (p: number) => number) => void }) {
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-label text-fg-muted">
      <span className="inline-flex items-center gap-1.5 tabular"><Users size={13} aria-hidden />{total.toLocaleString()} patients</span>
      <div className="flex items-center gap-1">
        <Button isIconOnly size="sm" radius="full" variant="light" isDisabled={page <= 1} onPress={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={15} /></Button>
        <span className="tabular px-1">{page} / {pages}</span>
        <Button isIconOnly size="sm" radius="full" variant="light" isDisabled={page >= pages} onPress={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={15} /></Button>
      </div>
    </div>
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
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <Input size="sm" radius="full" aria-label="Search patients" placeholder="Name or ID" value={q} onValueChange={setQ}
               startContent={<Search size={14} className="text-fg-muted" aria-hidden />}
               classNames={{ inputWrapper: "bg-surface-2 border border-border shadow-none h-9" }} />
        {status === "flagged" && (
          <Seg label="Risk band" value={band} onChange={setBand}
               options={[{ value: "", label: "All" }, { value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Med" }, { value: "LOW", label: "Low" }]} />
        )}
      </div>
      {error && <div className="p-3"><ErrorNote error={error} /></div>}
      {isLoading ? <div className="p-4"><Skeleton variant="list" rows={8} label="Loading patients" /></div> : (
        <motion.ul className="flex-1 overflow-auto p-2 flex flex-col gap-1" aria-label="Patients" variants={stagger(0.025)} initial={reduce ? false : "hidden"} animate="show">
          {rows.map((p) => {
            const on = selected === p.patient_id;
            return (
              <motion.li key={p.patient_id} variants={itemEnter}>
                <button onClick={() => onSelect(p.patient_id)} aria-current={on ? "true" : undefined}
                        title={status === "flagged" ? (p.top_reasons ?? []).map((r) => r.label).join(" · ") : undefined}
                        className={`relative w-full text-left px-3 py-2.5 rounded-tile flex items-center gap-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
                                    ${on ? "bg-accent-soft" : "hover:bg-surface-2"}`}>
                  {on && <motion.span layoutId="patient-row" className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent" aria-hidden />}
                  <span className="relative">
                    <PatientAvatar name={p.name} id={p.patient_id} size="sm" />
                    {p.open_alerts > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold leading-[17px] text-center ring-2 ring-surface tabular"
                            aria-label={`${p.open_alerts} open alert${p.open_alerts > 1 ? "s" : ""}`}>{p.open_alerts}</span>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <span className={`text-[13.5px] font-semibold truncate ${on ? "text-accent" : "text-fg"}`}>{p.name}</span>
                      <span className="text-micro text-fg-muted shrink-0">{p.sex} · {p.age}</span>
                    </span>
                    <span className="block text-micro text-fg-muted tabular truncate mt-0.5">
                      {p.display_id} · {status === "flagged" ? `seen ${date(p.last_visit)}` : `dx ${date(p.dx_date)}`}
                    </span>
                  </span>
                  {status === "flagged" ? (
                    <span className="w-[112px] shrink-0 flex flex-col gap-1.5">
                      <span className="flex items-center justify-between gap-1">
                        <BandChip band={p.risk_band} />
                        <span className="text-[13px] font-semibold tabular text-fg">{fmt(100 * (p.ensemble_prob ?? 0))}%</span>
                      </span>
                      <RiskScoreBar score={p.ensemble_prob} band={p.risk_band} compact label={`${p.name} risk`} />
                    </span>
                  ) : <StatusChip status="critical" label={String(p.case_status ?? "case").toLowerCase()} className="capitalize" />}
                </button>
              </motion.li>
            );
          })}
          {!rows.length && <li className="p-8 text-center text-label text-fg-muted">No patients match</li>}
        </motion.ul>
      )}
      <Pager total={total} page={page} setPage={setPage} />
    </Card>
  );
}

/** Small "Latest blood test"-style tile (MedEx): label pill, value + unit, sparkline, status; opens a chart modal. */
function MeasureTile({ label, icon, value, unit, decimals = 1, status, statusLabel, spark, onPress }: {
  label: string; icon: React.ReactNode; value: number | null | undefined; unit?: string; decimals?: number; status?: StatusKind | null; statusLabel?: string;
  spark?: number[]; onPress?: () => void;
}) {
  const Tag = onPress ? motion.button : motion.div;
  return (
    <Tag type={onPress ? "button" : undefined} onClick={onPress} variants={itemEnter} whileHover={onPress ? { y: -2 } : undefined} aria-label={onPress ? `${label}: open chart` : undefined}
         className={`text-left rounded-tile bg-surface-2 border border-border/70 p-3 min-w-0 flex flex-col gap-1.5 ${onPress ? "cursor-pointer hover:shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" : ""}`}>
      <span className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent px-2 py-0.5 text-[11px] font-semibold">{icon}{label}</span>
        {status && <StatusChip status={status} label={statusLabel} />}
      </span>
      <span className="flex items-baseline gap-1">
        <span className="text-[22px] leading-7 font-semibold tabular text-fg">{value === null || value === undefined ? "—" : fmt(value, decimals)}</span>
        {unit && <span className="text-micro text-fg-muted">{unit}</span>}
      </span>
      {spark && spark.length > 1 ? <Sparkline values={spark} height={26} /> : <span className="h-[26px]" />}
    </Tag>
  );
}

function PatientPanel({ patientId }: { patientId: number }) {
  const nav = useNavigate();
  const p = useQuery({ queryKey: ["patients", "one", patientId], queryFn: () => get<any>(`/patients/${patientId}`) });
  const tl = useQuery({ queryKey: ["patients", "timeline", patientId], queryFn: () => get<any>(`/patients/${patientId}/timeline`) });
  const alerts = useQuery({ queryKey: ["alerts", "patient", patientId], queryFn: () => get<Alert[]>(`/alerts`) });
  const ex = useMutation({ mutationFn: () => post<any>(`/patients/${patientId}/explain`, {}) });
  const explainModal = useDetailModal();
  const chart = useDetailModal();
  const [chartKey, setChartKey] = useState<"hb" | "weight">("hb");
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
  return (
    <BentoGrid step={0.05}>
      <GridItem span={12}>
        <Card padding="md" className="!p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <PatientAvatar name={h.name} id={h.patient_id} size="lg" className="w-14 h-14 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 min-w-0">
                <h2 className="text-h1 text-fg truncate">{h.name}</h2>
                <InfoHint title={h.name} label="About this patient"
                          about={<>Home facility {homeFacility}. Cohort entry {date(h.entry_date)} ({String(h.entry_reason).toLowerCase().replace(/_/g, " ")}).</>}
                          notes={`Last encounter ${date(h.last_encounter_date)}`} />
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                <span className="text-micro text-fg-muted tabular">{h.display_id}</span>
                {h.is_case ? <StatusChip status="critical" label={`${String(h.case_status).toLowerCase()} gastric cancer · ${date(h.dx_date)}`} />
                           : <BandChip band={h.risk?.risk_band} />}
                {myAlerts.some((a) => a.status === "NEW") && <StatusChip status="info" icon={<BellRing size={11} aria-hidden />} label={`${myAlerts.filter((a) => a.status === "NEW").length} new alerts`} />}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button radius="full" variant="flat" className="bg-surface-2 border border-border text-fg h-10" startContent={<MessageSquareText size={15} aria-hidden />} onPress={explain}>Explain</Button>
              <Button radius="full" className="bg-cta-gradient text-white font-semibold h-10 px-5 shadow-[0_8px_20px_-8px_rgb(var(--accent)/0.7)]"
                      startContent={<Box size={16} aria-hidden />} onPress={() => nav(`/doctor/case/${patientId}`)}>Analyse case in 3D</Button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
            <StatTile label="Age" value={h.age} unit="years" icon={<CalendarDays size={13} />} />
            <StatTile label="Sex" value={h.sex === "F" ? "Female" : "Male"} icon={<UserRound size={13} />} />
            <StatTile label="Weight" value={wLast} unit="kg" decimals={1} icon={<Weight size={13} />} />
            <StatTile label="District" value={h.district_name ?? h.district_code} icon={<MapPin size={13} />} />
          </div>
        </Card>
      </GridItem>

      <GridItem span={{ md: 12, lg: 7 }}>
        <Card title="Risk" icon={<Gauge size={16} />} iconTone="danger" info={{ method: RISK_METHOD }}>
          <RiskCard risk={h.risk} />
        </Card>
      </GridItem>
      <GridItem span={{ md: 12, lg: 5 }}>
        <Card title="Alerts" icon={<BellRing size={16} />} iconTone="warning" info="Open alerts for this patient. Acknowledge, mark as referred, or dismiss with a reason; every action is logged."
              actions={myAlerts.length ? <span className="text-micro text-fg-muted tabular">{myAlerts.length}</span> : undefined}>
          {alerts.isLoading ? <Skeleton variant="list" rows={3} /> : <AlertActions alerts={myAlerts} />}
        </Card>
      </GridItem>

      <GridItem span={{ md: 12, lg: 8 }}>
        <Card title="Timeline" icon={<History size={16} />} info={{ about: "Last 3 years of visits, symptoms, diagnoses, labs, medicines, orders and endoscopy. Dashed rings mark events the models weighed most. Hover a dot for details." }}
              detail={{ title: "Haemoglobin and weight", icon: <Activity size={18} />, size: "3xl",
                        tabs: [{ key: "hb", label: "Haemoglobin", content: <MiniSeries title="Haemoglobin" unit="g/dL" points={hb} threshold={hbThr} height={300} /> },
                               { key: "weight", label: "Weight", content: <MiniSeries title="Weight" unit="kg" points={wt} height={300} /> }] }}
              detailLabel="Open measurement charts">
          {tl.isLoading ? <Loading h={210} /> : <Timeline events={recent} />}
        </Card>
      </GridItem>
      <GridItem span={{ md: 12, lg: 4 }}>
        <Card title="Latest measurements" icon={<FlaskConical size={16} />} iconTone="success" info="Latest values with their trend over the window. Haemoglobin is compared with the WHO anaemia threshold for the patient's sex.">
          <motion.div className="grid grid-cols-2 gap-2" variants={stagger(0.05)} initial="hidden" animate="show">
            <MeasureTile label="Hb" icon={<Droplet size={11} aria-hidden />} value={hbLast} unit="g/dL" spark={hb.map((x) => x.value)}
                         status={hbLast === null ? null : hbLast < hbThr ? "critical" : "optimal"} statusLabel={hbLast !== null && hbLast < hbThr ? "Low" : "Normal"} onPress={() => openChart("hb")} />
            <MeasureTile label="Weight" icon={<Weight size={11} aria-hidden />} value={wLast} unit={wChange === null ? "kg" : `kg · ${signed(wChange, 1, "%")}`} spark={wt.map((x) => x.value)}
                         status={wChange === null ? null : wChange <= -5 ? "critical" : wChange <= -2 ? "suboptimal" : "optimal"} statusLabel={wChange !== null && wChange <= -5 ? "Loss" : undefined} onPress={() => openChart("weight")} />
            <MeasureTile label="Abnormal labs" icon={<FlaskConical size={11} aria-hidden />} value={abnormalLabs} decimals={0} unit="in 3 y"
                         status={abnormalLabs ? "suboptimal" : "optimal"} statusLabel={abnormalLabs ? "Review" : "None"} />
            <MeasureTile label="Visits" icon={<CalendarDays size={11} aria-hidden />} value={visits12} decimals={0} unit="in 12 mo"
                         status={visits12 >= 6 ? "suboptimal" : null} statusLabel="Frequent" />
          </motion.div>
        </Card>
      </GridItem>

      <DetailModal {...chart.modalProps} title={chartKey === "hb" ? "Haemoglobin" : "Weight"} icon={chartKey === "hb" ? <Droplet size={18} /> : <Weight size={18} />} size="3xl"
                   subtitle={h.name} info={chartKey === "hb" ? `Dashed line: anaemia threshold (${hbThr} g/dL for ${h.sex === "M" ? "men" : "women"}).` : undefined}>
        {chartKey === "hb" ? <MiniSeries title="Haemoglobin" unit="g/dL" points={hb} threshold={hbThr} height={320} /> : <MiniSeries title="Weight" unit="kg" points={wt} height={320} />}
      </DetailModal>
      <DetailModal {...explainModal.modalProps} title="Patient summary" icon={<Sparkles size={18} />} size="2xl" subtitle={h.name}>
        {ex.isPending ? <Skeleton variant="text" rows={5} label="Summarising" /> : ex.error ? <ErrorNote error={ex.error} /> : ex.data ? (
          <div className="flex flex-col gap-3">
            <p className="text-[14px] leading-relaxed text-fg">{ex.data.data.summary}</p>
            <div className="text-micro text-fg-muted">{ex.data.data.disclaimer} · {ex.data.data.generated_by}</div>
          </div>
        ) : null}
      </DetailModal>
    </BentoGrid>
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
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
        <Seg label="Alert status" value={status} onChange={setStatus}
             options={[{ value: "NEW", label: "New" }, { value: "ACKNOWLEDGED", label: "Ack." }, { value: "REFERRED", label: "Referred" }, { value: "DISMISSED", label: "Dismissed" }, { value: "", label: "All" }]} />
        <Seg label="Severity" value={sev} onChange={setSev} options={[{ value: "", label: "Any" }, { value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Med" }]} />
      </div>
      {isLoading ? <div className="p-4"><Skeleton variant="list" rows={8} label="Loading alerts" /></div> : (
        <motion.ul className="flex-1 overflow-auto p-2 flex flex-col gap-1" aria-label="Alerts" variants={stagger(0.02)} initial={reduce ? false : "hidden"} animate="show">
          {rows.map((a) => (
            <motion.li key={a.alert_id} variants={itemEnter}>
              <button className={`w-full text-left px-3 py-2.5 rounded-tile flex items-center gap-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${selected === a.patient_id ? "bg-accent-soft" : "hover:bg-surface-2"}`}
                      onClick={() => onOpen(a.patient_id)} title={a.summary}>
                <PatientAvatar name={a.name} id={a.patient_id} size="sm" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-semibold text-fg truncate">{a.name}</span>
                  <span className="block text-micro text-fg-muted truncate">{triggerLabel(a.trigger)} · {date(a.created_at)}</span>
                </span>
                <SeverityChip severity={a.severity} />
              </button>
            </motion.li>
          ))}
          {!rows.length && <li className="p-8 text-center text-label text-fg-muted">Inbox empty</li>}
        </motion.ul>
      )}
    </Card>
  );
}
