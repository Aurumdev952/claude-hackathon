import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@heroui/react";
import { motion } from "framer-motion";
import { Dna, Droplet, Gauge, Lightbulb, MessageSquareText, NotebookPen, Sparkles, Target, Weight } from "lucide-react";
import { get, post } from "@/api/client";
import {
  AnimatedNumber, BentoGrid, Card, DetailModal, ErrorNote, FloatingGlassCard, GradientRangeBar, GridItem, Loading, SectionHeader, Skeleton,
  useDetailModal, type StatusKind,
} from "@/components/ui";
import { labelOf } from "@/components/three/body/util";
import { date, fmt, signed } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { BandMark, type MarkLevel } from "./doctor/BandMark";
import { useRole } from "@/state/role";
import { FacilityPicker } from "./doctor/FacilityPicker";
import { RISK_METHOD, RiskCard, Track } from "./doctor/RiskCard";
import { MiniSeries } from "./doctor/Timeline";
import { triggerLabel } from "./doctor/AlertActions";
import { BodyStage } from "./case/BodyStage";
import { CareStrategy } from "./case/CareStrategy";
import { ConcernCards } from "./case/ConcernCards";
import { ConditionsPanel } from "./case/ConditionsPanel";
import { StageTrack, TumourCard } from "./case/TumourCard";
import { organsIn, scoresOf, systemMeta, useActiveSystem } from "./case/SystemRail";
import { HB, VITAL } from "./case/bodyState";
import { useCaseUI } from "./case/store";
import type { CaseData } from "./case/types";
import { VideoButton } from "@/components/video";
import { gastrectomyDate, useJourney } from "./doctor/care";

/** Doctor case analysis (design v3): the 3D body is the page's hero on the left; the active body system's risk, concerns
 * and care strategy sit on the right. Explanations sit behind ⓘ, details open in modals. */
export default function CaseAnalysis() {
  const { patientId } = useParams();
  const { role, facilityId } = useRole();
  const reset = useCaseUI((s) => s.reset);
  useEffect(() => { reset(); return () => reset(); }, [patientId, reset]);
  const q = useQuery({
    queryKey: ["patients", "case", Number(patientId), facilityId],
    queryFn: () => get<CaseData>(`/patients/${patientId}/case`),
    enabled: role === "doctor" && !!facilityId && !!patientId,
  });
  // v3: the journey carries the gastrectomy date for the post-gastrectomy body (diagnosed patients only)
  const isCase = !!q.data?.data?.header?.is_case;
  const j = useJourney(Number(patientId), isCase && role === "doctor" && !!facilityId);
  const surgeryAt = gastrectomyDate(j.data?.data);
  const merged = useMemo(() => (q.data ? { ...q.data.data, surgery: surgeryAt ? { date: surgeryAt, kind: "gastrectomy" as const } : null } : null), [q.data, surgeryAt]);
  if (role !== "doctor" || !facilityId) return <FacilityPicker />;
  if (q.isLoading) return <Loading h={480} label="Aggregating the case" />;
  if (q.error) return <div className="p-4"><ErrorNote error={q.error} /></div>;
  const data = merged!;
  return (
    <div className="grid gap-5 xl:h-full min-h-[720px] grid-cols-1 xl:grid-cols-2" data-testid="case-analysis">
      <section className="min-h-0 min-w-0 xl:h-full h-[760px]" aria-label="3D body"><BodyStage data={data} aside={<CaseInsights data={data} />} /></section>
      <aside className="min-h-0 min-w-0 overflow-auto -mr-1 pr-1 pb-4 rounded-card" aria-label="Case details"><CasePanel data={data} /></aside>
    </div>
  );
}

/** Section-header risk readout: label, value, band as dot + text, and a thin track (signal only for HIGH). */
function RiskReadout({ data, onOpen }: { data: CaseData; onOpen: () => void }) {
  const r = data.risk;
  const band = r?.risk_band ?? null;
  const level: MarkLevel = band === "HIGH" ? "high" : band === "MEDIUM" ? "medium" : band === "LOW" ? "low" : "none";
  return (
    <button type="button" onClick={onOpen} aria-label="Risk details"
            className="w-full text-left rounded-tile px-3 py-2 -mx-3 hover:bg-surface/70 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-label font-normal text-muted">Risk score</span>
        <span className="inline-flex items-center gap-3">
          <BandMark level={level} label={band ? `${band.charAt(0)}${band.slice(1).toLowerCase()}` : "Not scored"} />
          {r && <span className="text-[14px] font-semibold text-ink tabular">{fmt(100 * r.ensemble_prob)}%</span>}
        </span>
      </div>
      <Track value={r?.ensemble_prob ?? 0} tone={band === "HIGH" ? "signal" : "sky"} delay={0.2} />
    </button>
  );
}

function CasePanel({ data }: { data: CaseData }) {
  const system = useActiveSystem(data);
  const meta = systemMeta(system);
  const scores = scoresOf(data);
  const risk = useDetailModal();
  const organs = organsIn(data, system).filter((o) => (scores[o] ?? 0) > 0).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const Icon = meta.icon;
  return (
    <BentoGrid step={0.04}>
      <GridItem span={12}>
        <div className="flex items-center gap-6 min-h-[64px] pl-1 pr-1 flex-wrap">
          <motion.div key={system} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="shrink-0">
            <SectionHeader title={`${meta.label} system`} icon={<Icon size={18} />}
                           info={{ about: organs.length ? <>Involved organs: {organs.map((o) => `${labelOf(o)} ${Math.round(100 * (scores[o] ?? 0))}`).join(", ")}.</> : "No involved organ in this system.",
                                   notes: "Pick another system in the rail on the body." }} />
          </motion.div>
          <div className="flex-1 min-w-[220px] max-w-[320px] ml-auto">
            {data.tumour ? <StageTrack stage={data.tumour.stage_group} /> : <RiskReadout data={data} onOpen={risk.open} />}
          </div>
          <VideoButton kind="patient" params={{ patient_id: data.header.patient_id }} className="h-10 px-4 bg-surface"
                       title={<>Case summary video <span className="text-muted font-normal tabular">{data.header.display_id}</span></>} />
        </div>
      </GridItem>

      <GridItem span={{ md: 6 }}>{data.tumour ? <TumourCard data={data} /> : <MeasureCard data={data} />}</GridItem>
      <GridItem span={{ md: 6 }}><SummaryCard data={data} /></GridItem>

      <GridItem span={12}>
        <Card title="Key areas of concern" icon={<Target size={16} />} detailLabel="All conditions by organ"
              detail={{ title: "Conditions by organ", icon: <Target size={18} />, size: "3xl", subtitle: data.header.name,
                        info: "The most involved organs of this system (0 to 100). Hover a tile to light the organ on the body; its arrow lists the conditions. Below: symptoms, diagnoses and abnormal labs grouped by the organ they point to.",
                        children: <ConditionsPanel data={data} /> }}>
          <ConcernCards data={data} system={system} />
        </Card>
      </GridItem>

      <GridItem span={12}><CareStrategy data={data} /></GridItem>

      <DetailModal {...risk.modalProps} title="Risk" icon={<Gauge size={18} />} size="2xl" subtitle={data.header.name} info={RISK_METHOD}>
        <RiskCard risk={data.risk} />
      </DetailModal>
    </BentoGrid>
  );
}

/** "Anaemia check" (reference "Activity 2.780 Cal"): the latest haemoglobin as a big number, one helper line and a thin
 * track with an ink tick at the anaemia threshold; weight when Hb is missing. The arrow opens the series. */
function MeasureCard({ data }: { data: CaseData }) {
  const male = data.header.sex === "M";
  const hbM = data.labs.find((l) => l.concept_id === HB);
  const wM = data.vitals.find((v) => v.concept_id === VITAL.weight);
  if (hbM && typeof hbM.latest === "number") {
    const thr = male ? 13 : 12;
    const low = hbM.latest < thr;
    return (
      <Card className="h-full" title="Anaemia check" icon={<Droplet size={16} />} detailLabel="Haemoglobin over time"
            detail={{ title: "Haemoglobin", icon: <Droplet size={18} />, size: "3xl", info: `Latest haemoglobin (${date(hbM.latest_ts)}) against the WHO anaemia threshold for ${male ? "men" : "women"}. Unexplained anaemia is an alarm sign for gastric cancer.`,
                      children: <MiniSeries title="Haemoglobin" unit="g/dL" points={hbM.series} threshold={thr} height={320} /> }}>
        <div className="flex items-baseline gap-1.5">
          <AnimatedNumber value={hbM.latest} decimals={1} className="text-display text-ink" />
          <span className="text-[15px] text-muted">g/dL</span>
        </div>
        <div className="flex items-center gap-1.5 text-label font-normal text-muted mt-1">
          {low && <span className="w-1.5 h-1.5 rounded-full bg-signal shrink-0" aria-hidden />}
          <span>{low ? `${fmt(thr - hbM.latest, 1)} g/dL below` : `${fmt(hbM.latest - thr, 1)} g/dL above`} the {thr} g/dL threshold</span>
        </div>
        <GradientRangeBar className="mt-4" value={hbM.latest} min={6} max={18} reverse tone={low ? "signal" : "sky"} showMinMax={false}
                          markers={[{ value: thr, label: `Anaemia threshold ${thr} g/dL` }]} label="Haemoglobin against the anaemia threshold" format={(n) => `${fmt(n, 1)} g/dL`} />
      </Card>
    );
  }
  if (wM && typeof wM.latest === "number" && wM.series.length) {
    const first = wM.series[0].value;
    const pct = first ? (100 * (wM.latest - first)) / first : 0;
    return (
      <Card className="h-full" title="Weight check" icon={<Weight size={16} />} detailLabel="Weight over time"
            detail={{ title: "Weight", icon: <Weight size={18} />, size: "3xl", info: "Latest weight against the first weight in the case window; unexplained weight loss is an alarm sign.",
                      children: <MiniSeries title="Weight" unit="kg" points={wM.series} height={320} /> }}>
        <div className="flex items-baseline gap-1.5">
          <AnimatedNumber value={wM.latest} decimals={1} className="text-display text-ink" />
          <span className="text-[15px] text-muted">kg</span>
        </div>
        <div className="flex items-center gap-1.5 text-label font-normal text-muted mt-1">
          {pct <= -5 && <span className="w-1.5 h-1.5 rounded-full bg-signal shrink-0" aria-hidden />}
          <span>{signed(wM.latest - first, 1)} kg since the start of the window ({fmt(first, 1)} kg)</span>
        </div>
      </Card>
    );
  }
  return <Card className="h-full" title="Measurements" icon={<Droplet size={16} />}><div className="text-label text-muted">No haemoglobin or weight on record</div></Card>;
}

/** Case summary (reference "Sleep" card): what this case is about in one big word, a muted line, and the arrow that opens
 * the explanation and the team's notes. */
function SummaryCard({ data }: { data: CaseData }) {
  const open = data.alerts.filter((a) => a.status === "NEW").length;
  const notes = data.notes.length;
  const [label, value, line] = data.tumour
    ? ["Diagnosed", date((data.tumour.endo_date as string) ?? (data.header.dx_date as string)), data.tumour.treatment_intent ? `${data.tumour.treatment_intent.charAt(0)}${data.tumour.treatment_intent.slice(1).toLowerCase()} intent` : "Intent not recorded"]
    : data.suspected
      ? ["Search zone", data.suspected.region.charAt(0).toUpperCase() + data.suspected.region.slice(1), `Stomach involvement ${Math.round(100 * data.suspected.score)} of 100`]
      : ["Open alerts", String(open), open ? "Waiting for review" : "Nothing waiting"];
  return (
    <Card className="h-full" title="Case summary" icon={<MessageSquareText size={16} />} detailLabel="Open case summary"
          detail={{ title: "Case summary", icon: <MessageSquareText size={18} />, size: "2xl", subtitle: data.header.name, children: <ExplainAndNotes data={data} /> }}>
      <div className="text-label font-normal text-muted">{label}</div>
      <div className="text-h1 text-ink mt-0.5 truncate">{value}</div>
      <div className="flex items-center gap-4 text-label font-normal text-muted mt-1">
        <span className="truncate">{line}</span>
        {notes > 0 && <span className="inline-flex items-center gap-1 shrink-0"><NotebookPen size={13} aria-hidden />{notes} note{notes === 1 ? "" : "s"}</span>}
      </div>
    </Card>
  );
}

function ExplainAndNotes({ data }: { data: CaseData }) {
  const id = data.header.patient_id;
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const ex = useMutation({ mutationFn: () => post<any>(`/patients/${id}/explain`, {}) });
  useEffect(() => { if (!ex.data && !ex.isPending) ex.mutate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const add = useMutation({
    mutationFn: () => post(`/patients/${id}/notes`, { note }),
    onSuccess: () => { setNote(""); qc.invalidateQueries({ queryKey: ["patients", "case", id] }); },
  });
  const notes = useQuery({ queryKey: ["patients", "notes", id, add.data], queryFn: () => get<any[]>(`/patients/${id}/notes`) });
  const list = notes.data?.data ?? data.notes;
  const explain = ex.data?.data;
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-tile bg-tile p-5">
        <div className="flex items-center gap-2 mb-2 text-[14px] font-semibold text-ink"><Sparkles size={15} aria-hidden /> Explain this case</div>
        {ex.isPending ? <Skeleton variant="text" rows={4} label="Summarising" /> : ex.error ? <ErrorNote error={ex.error} /> : explain ? (
          <>
            <p className="text-[14px] leading-[22px] text-ink">{explain.summary}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted mt-3"><span>{explain.disclaimer}</span><span>Source: {explain.generated_by}</span></div>
          </>
        ) : null}
      </section>
      <section aria-label="Case notes">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink mb-3"><NotebookPen size={15} aria-hidden />Case notes <span className="text-muted font-normal tabular">{list.length}</span></h3>
        <ul className="flex flex-col divide-y divide-hairline mb-4">
          {list.map((n: any, i: number) => (
            <li key={n.note_id ?? i} className="py-3 text-[14px] text-ink first:pt-0"><div className="text-micro text-muted mb-1">{date(n.created_at)}</div>{n.note}</li>
          ))}
          {!list.length && <li className="text-label text-muted pb-1">No notes yet</li>}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate(); }}>
          <Input radius="full" value={note} onValueChange={setNote} placeholder="Add a note for the team" aria-label="New case note" maxLength={2000}
                 classNames={{ inputWrapper: "bg-tile data-[hover=true]:bg-tile-hover group-data-[focus=true]:bg-tile shadow-none h-10", input: "text-[14px]" }} />
          <Button radius="full" type="submit" className="h-10 px-5 bg-ink text-ink-on font-semibold text-[14px]" isDisabled={!note.trim() || add.isPending}>Save note</Button>
        </form>
      </section>
    </div>
  );
}

type Insight = { key: string; status: StatusKind; title: string; body: string };

/** Short, data-derived insights for this case: new alerts first, then alarm signs and the tumour. */
function useCaseInsights(data: CaseData): Insight[] {
  return useMemo(() => {
    const out: Insight[] = [];
    for (const a of data.alerts.filter((x) => x.status === "NEW")) out.push({ key: a.alert_id, status: a.severity === "HIGH" ? "critical" : "warning", title: triggerLabel(a.trigger), body: a.suggested_action });
    if (data.tumour) out.push({ key: "tumour", status: "critical", title: `Stage ${data.tumour.stage_group ?? "?"}, ${[data.tumour.t_stage, data.tumour.n_stage, data.tumour.m_stage].map((x) => x ?? "?").join(" ")}`, body: `${data.tumour.lesion_location ?? "Site unknown"}${data.tumour.lesion_size_mm ? `, ${data.tumour.lesion_size_mm} mm` : ""}` });
    else if (data.suspected) out.push({ key: "suspected", status: "warning", title: `Suspected region: ${data.suspected.region}`, body: `Stomach involvement ${Math.round(100 * data.suspected.score)}/100, not yet scoped` });
    for (const l of data.labs.filter((x) => x.abnormal).slice(0, 2)) out.push({ key: `lab-${l.concept_id}`, status: "suboptimal", title: `${l.name} ${typeof l.latest === "number" ? fmt(l.latest, l.latest >= 100 ? 0 : 1) : String(l.latest).toLowerCase()}${l.unit ? ` ${l.unit}` : ""}`, body: `Abnormal on ${date(l.latest_ts)}` });
    if (data.medications.ppi_courses_24m >= 3) out.push({ key: "ppi", status: "suboptimal", title: `${data.medications.ppi_courses_24m} PPI courses in 24 months`, body: "Repeated acid suppression without a diagnosis" });
    return out;
  }, [data]);
}

/** Floating "N new insights" card on the stage (top right, under the layer bar); its button opens the insight cards. */
function CaseInsights({ data }: { data: CaseData }) {
  const items = useCaseInsights(data);
  const [open, setOpen] = useState(true);
  const m = useDetailModal();
  if (!items.length) return null;
  return (
    <>
      <FloatingGlassCard open={open} position="none" className="!w-[288px] !shadow-none border border-hairline" role="complementary" ariaLabel="Case insights"
                         count={items.length} title={items.length === 1 ? "new insight" : "new insights"} icon={<Dna size={18} />}
                         body={items[0].title}
                         cta={{ label: "Review insights", onPress: m.open, icon: <Lightbulb size={15} aria-hidden /> }}
                         onDismiss={() => setOpen(false)} />
      <DetailModal {...m.modalProps} title="Case insights" icon={<Sparkles size={18} />} size="2xl" subtitle={data.header.name}
                   info="Derived from this case's alerts, tumour or suspected region, abnormal labs and medicines. Decision support only.">
        <motion.ul className="flex flex-col gap-2.5" variants={stagger(0.05)} initial="hidden" animate="show" aria-label="Insight cards">
          {items.map((c) => (
            <motion.li key={c.key} variants={itemEnter} className="rounded-tile bg-tile px-5 py-4 flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] leading-5 font-semibold text-ink">{c.title}</h3>
                <p className="text-label font-normal text-muted mt-1">{c.body}</p>
              </div>
              <BandMark className="pt-0.5" level={c.status === "critical" ? "high" : c.status === "warning" ? "medium" : "none"} label={c.status === "critical" ? "Critical" : c.status === "warning" ? "Watch" : "Review"} />
            </motion.li>
          ))}
        </motion.ul>
      </DetailModal>
    </>
  );
}
