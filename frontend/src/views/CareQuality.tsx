import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, qs } from "@/api/client";
import { ErrorNote, Loading, Panel, Seg } from "@/components/ui/Panel";
import { fmt, int, pct } from "@/lib/format";
import { Empty, Key, Stat, pval, usePalette } from "./quality/kit";
import { FunnelPlot, FunnelTable, type TierMode } from "./quality/FunnelPlot";
import { FacilityPanel } from "./quality/FacilityPanel";
import { ChiSquareNote, StageLegend, StageMix, StageTable } from "./quality/StageMix";
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

  return (
    <div className="flex flex-col gap-4 max-w-[1500px]">
      <Header />
      <KpiStrip fac={rows} stage={stage.data?.data ?? []} summary={summary.data?.data ?? []} cox={cox.data?.data ?? []} />

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Panel title="H. pylori testing funnel plot"
          subtitle={rows.length ? <FunnelSubtitle rows={rows} /> : "Testing rate vs volume per facility"}
          method="Each dot is a facility: x = dyspepsia-type patients first seen there since 2019, y = share tested for H. pylori (lab or order) within 90 days. Lines are exact binomial 95% and 99.8% control limits around the national rate; a dot outside 99.8% is very unlikely to be chance. Tier is the facility's recorded testing tier, or (toggle) the tertile of its observed rate (SPEC §12.7)."
          actions={<Seg label="Tier source" value={tierMode} onChange={setTierMode} options={[{ value: "tier", label: "Recorded tier" }, { value: "derived_tier", label: "Observed tertile" }]} />}
          table={rows.length ? <FunnelTable rows={rows} onSelect={setSelected} /> : undefined}>
          {fac.isLoading ? <Loading h={380} /> : fac.error ? <ErrorNote error={fac.error} /> : !rows.length ? <Empty h={380}>No facility data in this run.</Empty> :
            <FunnelPlot rows={rows} tierMode={tierMode} selected={selected} onSelect={setSelected} />}
        </Panel>
        <section className="panel p-4 animate-rise" aria-label="Facility detail">
          {fac.isLoading ? <Loading h={380} /> : <FacilityPanel rows={rows} selected={selected} onSelect={setSelected} tierMode={tierMode} />}
        </section>
      </div>

      <div className="grid gap-4 grid-cols-1 2xl:grid-cols-2">
        <StagePanel q={stage} />
        <Panel title="Eradication vs negative control"
          subtitle="Cox proportional hazards · hazard ratio with 95% CI · log scale"
          method="Cox models on the GI cohort. Eradication: H. pylori-positive patients, time-varying eradication therapy, adjusted for age, sex, atrophy/IM and hotspot residence. Negative control: the same design with HIV status, which should show no effect (CI including 1). A failing negative control is a warning sign for bias in the design."
          actions={<Seg label="Rows" value={covariates ? "all" : "main"} onChange={(x) => setCovariates(x === "all")} options={[{ value: "main", label: "Exposures" }, { value: "all", label: "+ covariates" }]} />}
          table={cox.data?.data?.length ? <CoxTable rows={cox.data.data} /> : undefined}>
          {cox.isLoading ? <Loading h={200} /> : cox.error ? <ErrorNote error={cox.error} /> : <CoxForest rows={cox.data?.data ?? []} covariates={covariates} hivShapRank={hivShapRank} />}
        </Panel>
      </div>

      <SurvivalPanel summary={summary.data?.data ?? []} />
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      <div className="min-w-0">
        <div className="panel-title">V5 · H. pylori & care quality</div>
        <h1 className="text-2xl font-bold tracking-tight">Where we test, we catch it earlier</h1>
        <p className="text-sm text-fog max-w-3xl mt-0.5">Facilities that test dyspepsia patients for H. pylori see fewer stage IV cancers and longer survival — a practice gap that varies within every province, not a geography effect.</p>
      </div>
      <div className="flex-1" />
      <p className="text-[11px] text-fog max-w-[260px] leading-snug border-l border-line/60 pl-3">Facility marts cover all ages; testing since 2019, outcomes since 2015. The period, sex and age filters above don't apply to this view.</p>
    </div>
  );
}

function FunnelSubtitle({ rows }: { rows: FacilityQ[] }) {
  const judged = rows.filter((r) => r.outlier_flag !== "LOW_VOLUME");
  const lo = judged.filter((r) => r.outlier_flag === "LOW_OUTLIER").length;
  const hi = judged.filter((r) => r.outlier_flag === "HIGH_OUTLIER").length;
  return <span className="tabular">{judged.length} facilities · <b className="text-mist">{lo}</b> below and <b className="text-mist">{hi}</b> above the 99.8% limits · click a dot for details</span>;
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
  const pair = (a: number | null, b: number | null, scale = 1) => (
    <span className="inline-flex items-baseline gap-2">
      <span className="inline-flex items-center gap-1"><Key color={S[0]} shape="dot" />{a === null ? "—" : `${fmt(a * scale, 0)}%`}</span>
      <span className="text-fog text-sm font-normal">vs</span>
      <span className="inline-flex items-center gap-1"><Key color={S[2]} shape="dot" />{b === null ? "—" : `${fmt(b * scale, 0)}%`}</span>
    </span>
  );
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
      <Stat label="HP testing rate" value={pct(target, 0, 100)} sub="of dyspepsia patients tested ≤ 90 days, national" />
      <Stat label="Low outliers" value={judged.length ? `${below} / ${judged.length}` : "—"} sub="facilities below the 99.8% control limit" />
      <Stat label="Stage IV · low vs high tier" value={pair(iv("low"), iv("high"))} sub="share of known-stage cancers" />
      <Stat label="1-yr survival · low vs high" value={pair(s1("low"), s1("high"), 100)} sub={lr !== undefined && lr !== null ? `log-rank ${pval(lr)}` : "Kaplan-Meier"} />
      <Stat label="Eradication HR" value={er ? fmt(er.hr, 2) : "—"} sub={er ? `95% CI ${fmt(er.lci, 2)}–${fmt(er.uci, 2)} · later gastric cancer` : "Cox model"} />
    </div>
  );
}

function StagePanel({ q }: { q: ReturnType<typeof useQuery<any>> }) {
  const [unknown, setUnknown] = useState(false);
  const rows: StageTierRow[] = q.data?.data ?? [];
  const chi: ChiSquare = (q.data as any)?.chi_square ?? null;
  return (
    <Panel title="Stage at diagnosis by facility tier"
      subtitle="Tier of the facility where the patient first presented with GI symptoms"
      method="Cases are grouped by the H. pylori testing tier of their first GI-visit facility. Bars show the stage distribution (100% stacked). A chi-square test compares known stages across the three tiers."
      actions={<Seg label="Denominator" value={unknown ? "all" : "known"} onChange={(v) => setUnknown(v === "all")} options={[{ value: "known", label: "Known stage" }, { value: "all", label: "Incl. unknown" }]} />}
      table={rows.length ? <StageTable rows={rows} /> : undefined}>
      {q.isLoading ? <Loading h={240} /> : q.error ? <ErrorNote error={q.error} /> : !rows.length ? <Empty>No staged cases yet.</Empty> : (
        <>
          <StageLegend includeUnknown={unknown} />
          <StageMix rows={rows} includeUnknown={unknown} />
          <ChiSquareNote chi={chi} rows={rows} />
        </>
      )}
    </Panel>
  );
}

function SurvivalPanel({ summary }: { summary: SurvSummary[] }) {
  const [gv, setGv] = useState<GroupVar>("facility_tier");
  const km = useQuery({ queryKey: ["quality", "km", gv], queryFn: () => get<KmRow[]>(`/survival/km${qs({ group_var: gv })}`) });
  const rows = km.data?.data ?? [];
  const sum = summary.filter((s) => s.group_var === gv);
  const p = sum[0]?.logrank_p;
  const total = useMemo(() => sum.reduce((s, r) => s + r.n, 0), [sum]);
  return (
    <Panel title="Survival after diagnosis"
      subtitle={<span className="tabular">Kaplan-Meier · {int(total)} patients · shaded bands are 95% CIs{p !== null && p !== undefined ? <> · log-rank <b className="text-mist">{pval(p)}</b></> : null}</span>}
      method="Kaplan-Meier estimates of overall survival from diagnosis, with Greenwood 95% confidence bands. The log-rank test compares the curves. Patients without a recorded death are censored on the date they were last seen alive; numbers at risk are shown under the axis."
      actions={<Seg label="Group by" value={gv} onChange={setGv} options={(Object.keys(GROUPS) as GroupVar[]).map((g) => ({ value: g, label: GROUPS[g].label }))} />}
      table={rows.length ? <KmTable rows={rows} gv={gv} summary={sum} /> : undefined}>
      {km.isLoading ? <Loading h={380} /> : km.error ? <ErrorNote error={km.error} /> : !rows.length ? <Empty h={300}>No survival data for this grouping.</Empty> : (
        <>
          <KmChart rows={rows} gv={gv} />
          <div className="mt-1"><RiskTable rows={rows} gv={gv} summary={sum} /></div>
        </>
      )}
    </Panel>
  );
}
