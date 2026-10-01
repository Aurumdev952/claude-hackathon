import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, AccordionItem, Button, Input } from "@heroui/react";
import { motion } from "framer-motion";
import { ArrowUpRight, ChevronRight, Dna, Droplet, Gauge, Lightbulb, MessageSquareText, NotebookPen, Sparkles, Target, Weight } from "lucide-react";
import { get, post } from "@/api/client";
import {
  BentoGrid, Card, DetailModal, ErrorNote, FloatingGlassCard, GridItem, Loading, PairCard, RiskScoreBar, SectionHeader, Skeleton, StatusChip,
  useDetailModal, type StatusKind,
} from "@/components/ui";
import { labelOf } from "@/components/three/body/util";
import { date, fmt, signed } from "@/lib/format";
import { STATUS } from "@/lib/viz";
import { itemEnter, stagger } from "@/lib/motion";
import { useRole } from "@/state/role";
import { FacilityPicker } from "./doctor/FacilityPicker";
import { RISK_METHOD, RiskCard } from "./doctor/RiskCard";
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

/** V7b Doctor Case Analysis (ClyHealth layout): the 3D body on the left, the active body system's risk, concerns and care
 * strategy on the right. Explanations sit behind ⓘ, details open in modals. */
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
  if (role !== "doctor" || !facilityId) return <FacilityPicker />;
  if (q.isLoading) return <Loading h={480} label="Aggregating the case" />;
  if (q.error) return <div className="p-4"><ErrorNote error={q.error} /></div>;
  const data = q.data!.data;
  return (
    <div className="grid gap-4 xl:h-[calc(100vh-80px)] min-h-[720px] grid-cols-1 xl:grid-cols-2" data-testid="case-analysis">
      <section className="min-h-0 min-w-0 xl:h-full h-[760px]" aria-label="3D body"><BodyStage data={data} bottomLeft={<CaseInsights data={data} />} /></section>
      <aside className="min-h-0 min-w-0 overflow-auto -mr-1 pr-1 pb-4" aria-label="Case details"><CasePanel data={data} /></aside>
    </div>
  );
}

function CasePanel({ data }: { data: CaseData }) {
  const system = useActiveSystem(data);
  const meta = systemMeta(system);
  const scores = scoresOf(data);
  const risk = useDetailModal();
  const conditions = useDetailModal();
  const organs = organsIn(data, system).filter((o) => (scores[o] ?? 0) > 0).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const Icon = meta.icon;
  return (
    <BentoGrid step={0.06} className="gap-3.5">
      <GridItem span={12}>
        <div className="flex items-center gap-4 min-h-[52px] px-1">
          <motion.div key={system} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="shrink-0">
            <SectionHeader title={`${meta.label} system`} icon={<Icon size={18} />}
                           info={{ about: organs.length ? <>Involved organs: {organs.map((o) => `${labelOf(o)} ${Math.round(100 * (scores[o] ?? 0))}`).join(", ")}.</> : "No involved organ in this system.",
                                   notes: "Pick another system in the rail on the body." }} />
          </motion.div>
          <div className="flex-1 min-w-0 max-w-[340px] ml-auto">
            {data.tumour ? <StageTrack stage={data.tumour.stage_group} /> : (
              <button type="button" onClick={risk.open} aria-label="Risk details" className="w-full text-left rounded-tile px-2 py-1 -mx-2 hover:bg-fg/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                {data.risk ? <RiskScoreBar score={data.risk.ensemble_prob} band={data.risk.risk_band} /> : <RiskScoreBar score={null} label="Risk score · not scored" />}
              </button>
            )}
          </div>
        </div>
      </GridItem>

      <GridItem span={{ md: 7 }}>{data.tumour ? <TumourCard data={data} /> : <MeasurePair data={data} />}</GridItem>
      <GridItem span={{ md: 5 }}><SummaryCard data={data} /></GridItem>

      <GridItem span={12}>
        <Card title="Key areas of concern" icon={<Target size={16} />} iconTone="warning"
              info="The most involved organs of this system (0-100). Hover a card to light the organ on the body; the chevron lists its conditions."
              actions={
                <Button isIconOnly size="sm" radius="full" variant="flat" aria-label="All conditions by organ" onPress={conditions.open}
                        className="min-w-8 w-8 h-8 bg-surface-2 border border-border text-fg-muted data-[hover=true]:text-fg">
                  <ArrowUpRight size={16} aria-hidden />
                </Button>
              }>
          <ConcernCards data={data} system={system} />
        </Card>
      </GridItem>

      <GridItem span={12}><CareStrategy data={data} /></GridItem>

      <DetailModal {...risk.modalProps} title="Risk" icon={<Gauge size={18} />} size="2xl" subtitle={data.header.name} info={RISK_METHOD}>
        <RiskCard risk={data.risk} />
      </DetailModal>
      <DetailModal {...conditions.modalProps} title="Conditions by organ" icon={<Target size={18} />} size="3xl" subtitle={data.header.name}
                   info="Symptoms, diagnoses and abnormal labs grouped by the organ they point to. Hover a row to light it on the body.">
        <ConditionsPanel data={data} />
      </DetailModal>
    </BentoGrid>
  );
}

/** Small bar stack for the pair card (reference "heart age" visual): filled share = measured / reference. */
function BarStack({ ratio, color }: { ratio: number; color: string }) {
  const n = 12, on = Math.round(Math.max(0, Math.min(1, ratio)) * n);
  return (
    <div className="grid grid-cols-3 gap-[3px] w-[42px]" aria-hidden>
      {Array.from({ length: n }).map((_, i) => {
        const filled = n - 1 - i < on;
        return <motion.span key={i} className="h-[5px] rounded-[2px]" style={{ background: filled ? color : "rgb(var(--fg) / 0.12)" }}
                            initial={{ opacity: 0, scaleX: 0.3 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ delay: 0.25 + (n - i) * 0.03 }} />;
      })}
    </div>
  );
}

/** "Haemoglobin vs anaemia threshold" pair (reference "Heart age vs chronological age"); weight when Hb is missing. */
function MeasurePair({ data }: { data: CaseData }) {
  const male = data.header.sex === "M";
  const hbM = data.labs.find((l) => l.concept_id === HB);
  const wM = data.vitals.find((v) => v.concept_id === VITAL.weight);
  if (hbM && typeof hbM.latest === "number") {
    const thr = male ? 13 : 12;
    const low = hbM.latest < thr;
    return (
      <PairCard className="h-full" title="Anaemia check" visual={<BarStack ratio={hbM.latest / thr} color={low ? STATUS.critical : STATUS.good} />} visualCaption={signed(hbM.latest - thr, 1)}
                left={{ label: "Haemoglobin", value: hbM.latest, decimals: 1, unit: "g/dL", marker: low ? STATUS.critical : STATUS.good }}
                right={{ label: "Anaemia threshold", value: thr, decimals: 0, unit: "g/dL" }}
                info={`Latest haemoglobin (${date(hbM.latest_ts)}) against the WHO anaemia threshold for ${male ? "men" : "women"}. Unexplained anaemia is an alarm sign for gastric cancer.`}
                detail={{ title: "Haemoglobin", icon: <Droplet size={18} />, size: "3xl", children: <MiniSeries title="Haemoglobin" unit="g/dL" points={hbM.series} threshold={thr} height={320} /> }} />
    );
  }
  if (wM && typeof wM.latest === "number" && wM.series.length) {
    const first = wM.series[0].value;
    return (
      <PairCard className="h-full" title="Weight check" visual={<BarStack ratio={wM.latest / Math.max(first, wM.latest)} color={STATUS.warning} />} visualCaption={signed(wM.latest - first, 1)}
                left={{ label: "Weight now", value: wM.latest, decimals: 1, unit: "kg", marker: STATUS.warning }}
                right={{ label: "Window start", value: first, decimals: 1, unit: "kg" }}
                info="Latest weight against the first weight in the case window; unexplained weight loss is an alarm sign."
                detail={{ title: "Weight", icon: <Weight size={18} />, size: "3xl", children: <MiniSeries title="Weight" unit="kg" points={wM.series} height={320} /> }} />
    );
  }
  return <Card padding="sm" className="h-full" title="Measurements"><div className="text-label text-fg-muted">No haemoglobin or weight on record</div></Card>;
}

/** One-line case summary (reference "Your heart is aging 4 years faster…") + "Case summary" button → explain & notes modal. */
function SummaryCard({ data }: { data: CaseData }) {
  const m = useDetailModal();
  const open = data.alerts.filter((a) => a.status === "NEW").length;
  const line = data.tumour
    ? <>Diagnosed <b className="text-fg">{date((data.tumour.endo_date as string) ?? (data.header.dx_date as string))}</b>{data.tumour.treatment_intent ? <> · <b className="text-fg">{data.tumour.treatment_intent.toLowerCase()}</b> intent</> : null}</>
    : data.suspected
      ? <>Search zone in the <b className="text-fg capitalize">{data.suspected.region}</b> · involvement <b className="text-fg tabular">{Math.round(100 * data.suspected.score)}</b>/100</>
      : <><b className="text-fg tabular">{open}</b> open alert{open === 1 ? "" : "s"}</>;
  return (
    <>
      <Card padding="sm" className="h-full !p-4" bodyClassName="flex flex-col justify-between gap-3">
        <p className="text-[13.5px] leading-snug text-fg-muted">{line}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" radius="full" onPress={m.open} className="bg-nav text-nav-fg font-medium h-8 px-3.5" endContent={<ChevronRight size={14} aria-hidden />}>Case summary</Button>
          {data.notes.length > 0 && <StatusChip status="neutral" icon={<NotebookPen size={11} aria-hidden />} label={`${data.notes.length} note${data.notes.length === 1 ? "" : "s"}`} />}
        </div>
      </Card>
      <DetailModal {...m.modalProps} title="Case summary" icon={<MessageSquareText size={18} />} size="2xl" subtitle={data.header.name}>
        <ExplainAndNotes data={data} />
      </DetailModal>
    </>
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
    <div className="flex flex-col gap-4">
      <section className="rounded-tile bg-accent-soft/60 border border-accent/15 p-4">
        <div className="flex items-center gap-2 mb-2 text-[13px] font-semibold text-fg"><Sparkles size={15} className="text-accent" aria-hidden /> Explain this case</div>
        {ex.isPending ? <Skeleton variant="text" rows={4} label="Summarising" /> : ex.error ? <ErrorNote error={ex.error} /> : explain ? (
          <>
            <p className="text-[13.5px] leading-relaxed text-fg">{explain.summary}</p>
            <div className="text-micro text-fg-muted mt-2">{explain.disclaimer} · {explain.generated_by}</div>
          </>
        ) : null}
      </section>
      <Accordion variant="splitted" defaultExpandedKeys={["notes"]} className="px-0"
                 itemClasses={{ base: "!shadow-none border border-border !bg-surface-2/60 rounded-tile", title: "text-[13px] font-semibold text-fg", trigger: "py-3" }}>
        <AccordionItem key="notes" aria-label="Case notes" title={`Case notes · ${list.length}`} startContent={<NotebookPen size={15} className="text-fg-muted" aria-hidden />}>
          <ul className="flex flex-col gap-1.5 mb-3">
            {list.map((n: any, i: number) => (
              <li key={n.note_id ?? i} className="rounded-tile bg-surface border border-border p-2.5 text-[13px] text-fg"><div className="text-micro text-fg-muted mb-0.5">{date(n.created_at)}</div>{n.note}</li>
            ))}
            {!list.length && <li className="text-label text-fg-muted">No notes yet</li>}
          </ul>
          <form className="flex gap-2 pb-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate(); }}>
            <Input size="sm" radius="full" value={note} onValueChange={setNote} placeholder="Add a note for the team" aria-label="New case note" maxLength={2000}
                   classNames={{ inputWrapper: "bg-surface border border-border" }} />
            <Button size="sm" radius="full" color="primary" type="submit" isDisabled={!note.trim() || add.isPending}>Save</Button>
          </form>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

type Insight = { key: string; status: StatusKind; title: string; body: string };

/** Short, data-derived insights for this case: new alerts first, then alarm signs and the tumour. */
function useCaseInsights(data: CaseData): Insight[] {
  return useMemo(() => {
    const out: Insight[] = [];
    for (const a of data.alerts.filter((x) => x.status === "NEW")) out.push({ key: a.alert_id, status: a.severity === "HIGH" ? "critical" : "warning", title: triggerLabel(a.trigger), body: a.suggested_action });
    if (data.tumour) out.push({ key: "tumour", status: "critical", title: `Stage ${data.tumour.stage_group ?? "?"} · ${[data.tumour.t_stage, data.tumour.n_stage, data.tumour.m_stage].map((x) => x ?? "?").join(" ")}`, body: `${data.tumour.lesion_location ?? "Site unknown"}${data.tumour.lesion_size_mm ? `, ${data.tumour.lesion_size_mm} mm` : ""}` });
    else if (data.suspected) out.push({ key: "suspected", status: "warning", title: `Suspected region: ${data.suspected.region}`, body: `Stomach involvement ${Math.round(100 * data.suspected.score)}/100, not yet scoped` });
    for (const l of data.labs.filter((x) => x.abnormal).slice(0, 2)) out.push({ key: `lab-${l.concept_id}`, status: "suboptimal", title: `${l.name} ${typeof l.latest === "number" ? fmt(l.latest, l.latest >= 100 ? 0 : 1) : String(l.latest).toLowerCase()}${l.unit ? ` ${l.unit}` : ""}`, body: `Abnormal · ${date(l.latest_ts)}` });
    if (data.medications.ppi_courses_24m >= 3) out.push({ key: "ppi", status: "suboptimal", title: `${data.medications.ppi_courses_24m} PPI courses in 24 months`, body: "Repeated acid suppression without a diagnosis" });
    return out;
  }, [data]);
}

/** Floating "N new insights" glass card on the stage (reference bottom-left) → modal with the insight cards. */
function CaseInsights({ data }: { data: CaseData }) {
  const items = useCaseInsights(data);
  const [open, setOpen] = useState(true);
  const m = useDetailModal();
  if (!items.length) return null;
  return (
    <>
      <FloatingGlassCard open={open} position="none" className="!w-[268px] !p-3.5" role="complementary" ariaLabel="Case insights"
                         count={items.length} title={items.length === 1 ? "New insight" : "New insights"} icon={<Dna size={18} />}
                         body={items[0].title}
                         cta={{ label: "Review insights", onPress: m.open, icon: <Lightbulb size={15} aria-hidden /> }}
                         onDismiss={() => setOpen(false)} />
      <DetailModal {...m.modalProps} title="Case insights" icon={<Sparkles size={18} />} size="2xl" subtitle={data.header.name}
                   info="Derived from this case's alerts, tumour or suspected region, abnormal labs and medicines. Decision support only.">
        <motion.ul className="flex flex-col gap-2.5" variants={stagger(0.05)} initial="hidden" animate="show" aria-label="Insight cards">
          {items.map((c) => (
            <motion.li key={c.key} variants={itemEnter} className="rounded-tile border border-border bg-surface-2/60 p-3.5 flex items-start gap-3">
              <span className="w-[72px] shrink-0 pt-0.5"><StatusChip status={c.status} label={c.status === "critical" ? "Critical" : c.status === "warning" ? "Watch" : "Review"} /></span>
              <div className="min-w-0">
                <h3 className="text-title text-fg leading-snug">{c.title}</h3>
                <p className="text-label text-fg-muted mt-0.5">{c.body}</p>
              </div>
            </motion.li>
          ))}
        </motion.ul>
      </DetailModal>
    </>
  );
}
