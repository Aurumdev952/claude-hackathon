import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, qs } from "@/api/client";
import { Accordion, AccordionItem } from "@heroui/react";
import { AlertOctagon, BarChartHorizontal, Building2, FlaskConical, HeartPulse, ScatterChart, ShieldCheck } from "lucide-react";
import { BentoGrid, Card, chartDetailTabs, GridItem, Loading, MetricCard, PageHeader, PairCard, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int } from "@/lib/format";
import { Empty, pval, usePalette } from "./quality/kit";
import { FunnelPlot, FunnelTable, type TierMode } from "./quality/FunnelPlot";
import { FacilityPanel } from "./quality/FacilityPanel";
import { ChiSquareChips, ChiSquareNote, StageLegend, StageMix, StageTable } from "./quality/StageMix";
import { GROUPS, KmChart, KmTable, RiskTable, type GroupVar } from "./quality/Survival";
import { CoxForest, CoxTable } from "./quality/CoxForest";
import type { ChiSquare, CoxRow, FacilityQ, KmRow, StageTierRow, SurvSummary } from "./quality/types";

/** V5 - H. pylori & Care Quality (SPEC §16.3, §12.7, INS-4, INS-8). */
export default function CareQuality() {
  const fac = useQuery({ queryKey: ["quality", "facilities"], queryFn: () => get<FacilityQ[]>("/facilities/quality") });
  const stage = useQuery({ queryKey: ["quality", "stage-tier"], queryFn: () => get<StageTierRow[]>(`/stage-mix${qs({ by: "tier" })}`) });
  const summary = useQuery({ queryKey: ["quality", "surv-summary"], queryFn: () => get<SurvSummary[]>("/survival/summary") });
  const cox = useQuery({ queryKey: ["quality", "cox"], queryFn: () => get<CoxRow[]>("/survival/cox") });
  const models = useQuery({ queryKey: ["models", "list"], queryFn: () => get<any[]>("/models"), retry: false });
  const hivShapRank: number | null = (models.data as any)?.thresholds?.hiv_shap_rank ?? null;

  const [tierMode, setTierMode] = useState<TierMode>("tier");
  const [selected, setSelected] = useState<number | null>(null);
  const [covariates, setCovariates] = useState(false);
  const rows = fac.data?.data ?? [];
  useEffect(() => {
    if (selected === null && rows.length) {
      const z = (f: FacilityQ) => (f.n_dyspepsia >= 10 && f.hp_test_rate !== null ? (f.hp_test_rate - f.target_rate) / Math.sqrt((f.target_rate * (1 - f.target_rate)) / f.n_dyspepsia) : 0);
      setSelected([...rows].sort((a, b) => z(a) - z(b))[0].location_id);
    }
  }, [rows, selected]);

  const funnelMethod = "Each dot is a facility: x = dyspepsia-type patients first seen there since 2019, y = share tested for H. pylori (lab or order) within 90 days. Lines are exact binomial 95% and 99.8% control limits around the national rate; a dot outside 99.8% is very unlikely to be chance. Tier is the facility's recorded testing tier, or (toggle) the tertile of its observed rate (SPEC §12.7).";
  const coxMethod = "Cox models on the GI cohort. Eradication: H. pylori-positive patients, time-varying eradication therapy, adjusted for age, sex, atrophy/IM and hotspot residence. Negative control: the same design with HIV status, which should show no effect (CI including 1). A failing negative control is a warning sign for bias in the design.";
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <PageHeader icon={<FlaskConical size={18} />} title="Where we test, we catch it earlier"
        info={{ about: "Facilities that test dyspepsia patients for H. pylori see fewer stage IV cancers and longer survival — a practice gap that varies within every province, not a geography effect.",
                notes: "Facility marts cover all ages; testing since 2019, outcomes since 2015. The period, sex and age filters don't apply to this view." }}
        right={<StatusChip status="neutral" size="md" label="All ages · testing 2019→" title="Facility marts cover all ages; testing since 2019, outcomes since 2015. Global filters don't apply here." />} />
      <KpiStrip fac={rows} stage={stage.data?.data ?? []} summary={summary.data?.data ?? []} cox={cox.data?.data ?? []} />

      <BentoGrid>
        <GridItem span={{ xl: 8 }}>
          <Card title="H. pylori testing funnel plot" icon={<ScatterChart size={16} />}
            info={{ about: "Testing rate vs volume per facility. Click a dot for details.", method: funnelMethod }}
            actions={<Seg label="Tier source" value={tierMode} onChange={setTierMode} options={[{ value: "tier", label: "Recorded tier" }, { value: "derived_tier", label: "Observed tertile" }]} />}
            detail={rows.length ? { tabs: chartDetailTabs({ table: <FunnelTable rows={rows} onSelect={setSelected} />, method: funnelMethod }), defaultTab: "table", size: "5xl" } : undefined}
            detailLabel="View as table">
            {rows.length > 0 && <FunnelChips rows={rows} />}
            {fac.isLoading ? <Loading h={380} /> : fac.error ? <ErrorNote error={fac.error} /> : !rows.length ? <Empty h={380}>No facility data in this run.</Empty> :
              <FunnelPlot rows={rows} tierMode={tierMode} selected={selected} onSelect={setSelected} height={410} />}
          </Card>
        </GridItem>
        <GridItem span={{ xl: 4 }}>
          <Card title="Facility" icon={<Building2 size={16} />} aria-label="Facility detail"
                info={{ about: "Click any dot on the funnel plot, or choose a facility, to see its testing and outcomes.", notes: "Synthetic data. Fewer than 20 cancers first presenting at a facility make its stage and interval figures imprecise." }}>
            {fac.isLoading ? <Loading h={380} /> : <FacilityPanel rows={rows} selected={selected} onSelect={setSelected} tierMode={tierMode} />}
          </Card>
        </GridItem>

        <GridItem span={{ xl: 6 }}><StagePanel q={stage} /></GridItem>
        <GridItem span={{ xl: 6 }}>
          <Card title="Eradication vs negative control" icon={<ShieldCheck size={16} />}
            info={{ about: "Cox proportional hazards · hazard ratio with 95% CI · log scale.", method: coxMethod }}
            actions={<Seg label="Rows" value={covariates ? "all" : "main"} onChange={(x) => setCovariates(x === "all")} options={[{ value: "main", label: "Exposures" }, { value: "all", label: "+ covariates" }]} />}
            detail={cox.data?.data?.length ? { tabs: chartDetailTabs({ table: <CoxTable rows={cox.data.data} />, method: coxMethod }), defaultTab: "table" } : undefined}
            detailLabel="View as table">
            {cox.isLoading ? <Loading h={200} /> : cox.error ? <ErrorNote error={cox.error} /> : <CoxForest rows={cox.data?.data ?? []} covariates={covariates} hivShapRank={hivShapRank} />}
          </Card>
        </GridItem>

        <GridItem span={12}><SurvivalPanel summary={summary.data?.data ?? []} /></GridItem>
      </BentoGrid>
    </div>
  );
}

function FunnelChips({ rows }: { rows: FacilityQ[] }) {
  const judged = rows.filter((r) => r.outlier_flag !== "LOW_VOLUME");
  const lo = judged.filter((r) => r.outlier_flag === "LOW_OUTLIER").length;
  const hi = judged.filter((r) => r.outlier_flag === "HIGH_OUTLIER").length;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      <StatusChip status="neutral" icon={false} label={<span className="tabular">{judged.length} facilities</span>} />
      <StatusChip status="critical" label={<span className="tabular">{lo} below 99.8%</span>} />
      <StatusChip status="good" label={<span className="tabular">{hi} above 99.8%</span>} />
    </div>
  );
}

function KpiStrip({ fac, stage, summary, cox }: { fac: FacilityQ[]; stage: StageTierRow[]; summary: SurvSummary[]; cox: CoxRow[] }) {
  const { series: S } = usePalette();
  const target = fac[0]?.target_rate ?? null;
  const judged = fac.filter((r) => r.outlier_flag !== "LOW_VOLUME");
  const below = judged.filter((r) => r.outlier_flag === "LOW_OUTLIER").length;
  const iv = (t: string) => stage.find((r) => r.facility_tier === t && r.stage_group === "IV")?.pct_known ?? null;
  const s1 = (t: string) => summary.find((r) => r.group_var === "facility_tier" && r.group_value === t)?.surv_1y ?? null;
  const lr = summary.find((r) => r.group_var === "facility_tier")?.logrank_p;
  const er = cox.find((r) => r.model_id === "eradication_ins4" && r.term === "eradicated");
  const pctV = (v: number | null, scale = 1) => (v === null ? "—" : `${fmt(v * scale, 0)}`);
  return (
    <BentoGrid>
      <GridItem span={{ sm: 6, lg: 4, xl: 2 }}>
        <MetricCard label="HP testing rate" icon={<FlaskConical size={15} />} value={target === null ? "—" : fmt(100 * target, 0)} unit="%"
          info="Share of dyspepsia patients tested for H. pylori within 90 days, national."
          range={target === null ? undefined : { value: 100 * target, min: 0, max: 100, reverse: true, label: "National testing rate, 0 to 100%", format: (n) => `${Math.round(n)}%` }} />
      </GridItem>
      <GridItem span={{ sm: 6, lg: 4, xl: 2 }}>
        <MetricCard label="Low outliers" icon={<AlertOctagon size={15} />} iconTone="danger" value={judged.length ? below : "—"} unit={judged.length ? `of ${judged.length}` : undefined}
          status={judged.length ? { status: below ? "critical" : "good", label: "below 99.8%" } : null}
          info="Facilities below the 99.8% control limit of the funnel plot (facilities with fewer than 10 dyspepsia patients are not judged)." />
      </GridItem>
      <GridItem span={{ sm: 6, lg: 4, xl: 3 }}>
        <PairCard title="Stage IV · by tier" info="Share of known-stage cancers that were stage IV, by the H. pylori testing tier of the first-GI facility (low vs high)."
          left={{ label: "Low tier", value: pctV(iv("low")), unit: "%", marker: S[0] }} right={{ label: "High tier", value: pctV(iv("high")), unit: "%", marker: S[2] }} />
      </GridItem>
      <GridItem span={{ sm: 6, lg: 6, xl: 3 }}>
        <PairCard title="1-yr survival · by tier" info={`Kaplan-Meier 1-year survival by testing tier${lr !== undefined && lr !== null ? `; log-rank ${pval(lr)}` : ""}.`}
          left={{ label: "Low tier", value: pctV(s1("low"), 100), unit: "%", marker: S[0] }} right={{ label: "High tier", value: pctV(s1("high"), 100), unit: "%", marker: S[2] }} />
      </GridItem>
      <GridItem span={{ sm: 12, lg: 6, xl: 2 }}>
        <MetricCard label="Eradication HR" icon={<ShieldCheck size={15} />} iconTone="success" value={er ? fmt(er.hr, 2) : "—"}
          status={er ? (er.uci < 1 ? { status: "good", label: "Protective" } : er.lci > 1 ? { status: "critical", label: "Harmful" } : { status: "neutral", label: "CI includes 1" }) : null}
          info={er ? `Hazard ratio for later gastric cancer after eradication therapy; 95% CI ${fmt(er.lci, 2)}–${fmt(er.uci, 2)} (Cox model).` : "Cox model"}
          range={er ? { value: er.hr, min: 0, max: 2, thresholds: [1], markers: [{ value: er.lci, label: "95% CI lower" }, { value: er.uci, label: "95% CI upper" }], label: "Hazard ratio, 0 to 2 (1 = no effect)", format: (n) => fmt(n, 1) } : undefined} />
      </GridItem>
    </BentoGrid>
  );
}

function StagePanel({ q }: { q: ReturnType<typeof useQuery<any>> }) {
  const [unknown, setUnknown] = useState(false);
  const rows: StageTierRow[] = q.data?.data ?? [];
  const chi: ChiSquare = (q.data as any)?.chi_square ?? null;
  const method = "Cases are grouped by the H. pylori testing tier of their first GI-visit facility. Bars show the stage distribution (100% stacked). A chi-square test compares known stages across the three tiers; patients with no prior GI visit are shown for completeness but excluded from the test.";
  return (
    <Card title="Stage at diagnosis by tier" icon={<BarChartHorizontal size={16} />}
      info={{ about: "Tier of the facility where the patient first presented with GI symptoms.", method, notes: rows.length ? <ChiSquareNote chi={chi} rows={rows} /> : undefined }}
      actions={<Seg label="Denominator" value={unknown ? "all" : "known"} onChange={(v) => setUnknown(v === "all")} options={[{ value: "known", label: "Known stage" }, { value: "all", label: "Incl. unknown" }]} />}
      detail={rows.length ? { tabs: chartDetailTabs({ table: <StageTable rows={rows} />, method }), defaultTab: "table" } : undefined} detailLabel="View as table">
      {q.isLoading ? <Loading h={240} /> : q.error ? <ErrorNote error={q.error} /> : !rows.length ? <Empty>No staged cases yet.</Empty> : (
        <>
          <StageLegend includeUnknown={unknown} />
          <StageMix rows={rows} includeUnknown={unknown} />
          <ChiSquareChips chi={chi} rows={rows} />
        </>
      )}
    </Card>
  );
}

function SurvivalPanel({ summary }: { summary: SurvSummary[] }) {
  const [gv, setGv] = useState<GroupVar>("facility_tier");
  const km = useQuery({ queryKey: ["quality", "km", gv], queryFn: () => get<KmRow[]>(`/survival/km${qs({ group_var: gv })}`) });
  const rows = km.data?.data ?? [];
  const sum = summary.filter((s) => s.group_var === gv);
  const p = sum[0]?.logrank_p;
  const total = useMemo(() => sum.reduce((s, r) => s + r.n, 0), [sum]);
  const method = "Kaplan-Meier estimates of overall survival from diagnosis, with Greenwood 95% confidence bands. The log-rank test compares the curves. Patients without a recorded death are censored on the date they were last seen alive.";
  return (
    <Card title="Survival after diagnosis" icon={<HeartPulse size={16} />}
      info={{ about: "Kaplan-Meier curves; shaded bands are 95% CIs.", method }}
      actions={<>
        <StatusChip status="neutral" icon={false} size="md" label={<span className="tabular">{int(total)} patients</span>} />
        {p !== null && p !== undefined && <StatusChip status={p < 0.05 ? "info" : "neutral"} size="md" label={<span className="tabular">log-rank {pval(p)}</span>} />}
        <Seg label="Group by" value={gv} onChange={setGv} options={(Object.keys(GROUPS) as GroupVar[]).map((g) => ({ value: g, label: GROUPS[g].label }))} />
      </>}
      detail={rows.length ? { tabs: chartDetailTabs({ table: <KmTable rows={rows} gv={gv} summary={sum} />, method }), defaultTab: "table" } : undefined} detailLabel="View as table">
      {km.isLoading ? <Loading h={380} /> : km.error ? <ErrorNote error={km.error} /> : !rows.length ? <Empty h={300}>No survival data for this grouping.</Empty> : (
        <>
          <KmChart rows={rows} gv={gv} />
          <Accordion isCompact className="px-0 mt-1" itemClasses={{ title: "!text-label font-medium !text-fg-muted", trigger: "py-1.5", content: "pt-0 pb-1", indicator: "text-fg-muted" }}>
            <AccordionItem key="risk" aria-label="Numbers at risk" title="Numbers at risk · 1-yr · median">
              <RiskTable rows={rows} gv={gv} summary={sum} />
            </AccordionItem>
          </Accordion>
        </>
      )}
    </Card>
  );
}
