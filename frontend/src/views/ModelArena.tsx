import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Activity, Brain, Hourglass, Scale, Sparkles, Target, Users } from "lucide-react";
import { ApiError, get } from "@/api/client";
import { BentoGrid, Card, chartDetailTabs, DataTable, GridItem, Loading, PageHeader, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { date, fmt } from "@/lib/format";
import { Empty } from "./quality/kit";
import { ModelCards } from "./models/ModelCards";
import { CurveChart, CurveLegend, CurveTable, withCumulative, type Kind, type ModelCurves } from "./models/Curves";
import { ImportanceBars, ImportanceTable } from "./models/Importance";
import { SubgroupTable } from "./models/Subgroups";
import { TIER_META, type Curves, type Importance, type Metrics, type RegistryModel, type Subgroup, type Thresholds } from "./models/types";

/** V6 - Model Arena (SPEC §16.3, §13): three tiers compared on the same temporal test set. */
export default function ModelArena() {
  const reg = useQuery({
    queryKey: ["models", "list"], queryFn: () => get<RegistryModel[]>("/models"), retry: false,
    refetchInterval: (q) => ((q.state.error as ApiError | null)?.code === "NO_MODELS" ? 30_000 : false),
  });
  const models = useMemo(() => [...(reg.data?.data ?? [])].sort((a, b) => a.tier - b.tier), [reg.data]);
  const ensemble = (reg.data as any)?.ensemble as Partial<Record<"val" | "test", Metrics>> | undefined;
  const thresholds = ((reg.data as any)?.thresholds ?? null) as Thresholds;
  const ids = useMemo(() => [...models.map((m) => ({ model_id: m.model_id, tier: m.tier })), ...(ensemble?.test ? [{ model_id: "ensemble", tier: 0 }] : [])], [models, ensemble]);
  const curveQs = useQueries({
    queries: ids.map((m) => ({ queryKey: ["models", "curves", m.model_id], queryFn: () => get<Curves>(`/models/${encodeURIComponent(m.model_id)}/curves`), retry: false })),
  });
  const t2 = models.find((m) => m.tier === 2);
  const imp = useQuery({ queryKey: ["models", "importance", t2?.model_id], queryFn: () => get<Importance[]>(`/models/${encodeURIComponent(t2!.model_id)}/importance?limit=30`), enabled: !!t2 });
  const [leadMode, setLeadMode] = useState<"lead_cum" | "lead_time">("lead_cum");
  const sub = useQuery({ queryKey: ["models", "subgroups"], queryFn: () => get<Subgroup[]>("/models/subgroups"), enabled: models.length > 0 });

  const noModels = (reg.error as ApiError | null)?.code === "NO_MODELS" || (reg.isSuccess && !models.length);
  if (reg.isLoading) return <Loading h={480} label="Loading the model registry" />;
  if (noModels) return <Training />;
  if (reg.error) return <div className="p-4"><ErrorNote error={reg.error} /></div>;

  const pctEver = (id: string) => (id === "ensemble" ? ensemble?.test?.pct_flagged_ever : models.find((m) => m.model_id === id)?.metrics.test?.pct_flagged_ever) ?? null;
  const curves: ModelCurves[] = ids.map((m, i) => withCumulative({ ...m, curves: curveQs[i]?.data?.data ?? {} }, pctEver(m.model_id))).filter((m) => Object.keys(m.curves).length);
  // put the ensemble last so slot order (and legend order) is Points, XGBoost, Sequence, Ensemble
  curves.sort((a, b) => (a.tier || 9) - (b.tier || 9));
  const curvesLoading = curveQs.some((q) => q.isLoading);
  const test = models[0]?.metrics.test;
  const prevalence = test ? test.n_pos / (test.n_pos + test.n_neg) : null;
  const overall = Object.fromEntries([...models.map((m) => [m.model_id, m.metrics.test?.auroc]), ["ensemble", ensemble?.test?.auroc]]);
  const hiv = (imp.data as any)?.negative_control ?? null;
  const m0 = models[0];

  const chart = (kind: Kind, h = 280, extra?: { label: string; color: string; shape?: "line" | "dash" }[]) => {
    const ms = curves.filter((c) => (c.curves[kind] ?? []).length);
    if (curvesLoading) return <Loading h={h} />;
    if (!ms.length) return <Empty h={h}>No {kind.replace("_", " ")} data for these models.</Empty>;
    return <><CurveLegend models={ms} extra={extra} /><CurveChart kind={kind} models={ms} prevalence={prevalence} height={h} /></>;
  };

  const card = (title: string, icon: React.ReactNode, about: string, method: string, kind: Kind | null, body: React.ReactNode, actions?: React.ReactNode) => (
    <Card title={title} icon={icon} info={{ about, method }} actions={actions}
          detail={kind && curves.length ? { tabs: chartDetailTabs({ table: <CurveTable kind={kind} models={curves} />, method }), defaultTab: "table" } : undefined} detailLabel="View as table">
      {body}
    </Card>
  );
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <PageHeader icon={<Brain size={18} />} title="Three ways to find cancer before diagnosis"
        info={<>Each model answers the same question at every monthly landmark — <i>will this GI-cohort patient be diagnosed with gastric cancer in the next 12 months?</i> — and is scored on a later, held-out time period.</>}
        right={m0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusChip status="neutral" icon={false} size="md" label={<span className="tabular">Trained {date(m0.trained_at)}</span>} title={`Train window ${m0.train_window}`} />
            {test && <StatusChip status="info" size="md" label={<span className="tabular">{test.n_pos.toLocaleString()} test cases · {fmt(100 * (prevalence ?? 0), 2)}% base rate</span>} title={`Train window ${m0.train_window}`} />}
          </div>
        ) : undefined} />

      <ModelCards models={models} ensemble={ensemble} thresholds={thresholds} />

      <BentoGrid>
        <GridItem span={{ lg: 6, xl: 4 }}>
          {card("ROC curves", <Activity size={16} />, "Ranking: sensitivity against false-positive rate.",
            "Receiver operating characteristic on the temporal test set. The area under it (AUROC) is the chance a random future case is ranked above a random non-case. Dashed diagonal = chance.",
            "roc", chart("roc", 280, [{ label: "Chance", color: "rgb(var(--fg-muted))", shape: "dash" }]))}
        </GridItem>
        <GridItem span={{ lg: 6, xl: 4 }}>
          {card("Precision–recall", <Target size={16} />, "The honest view for a rare outcome.",
            "Precision (PPV) against recall (sensitivity). With cancer this rare, AUPRC is the most honest single number: the dashed line is the base rate a random list would achieve.",
            "pr", chart("pr", 280, [{ label: "Base rate", color: "rgb(var(--fg-muted))", shape: "dash" }]))}
        </GridItem>
        <GridItem span={{ lg: 12, xl: 4 }}>
          {card("Calibration", <Scale size={16} />, "Do predicted risks match what happened?",
            "Test landmarks binned into predicted-risk deciles; each dot is the mean predicted risk vs the observed 12-month cancer rate in that decile. Dots on the dashed diagonal are perfectly calibrated. The points score is not a probability and is omitted.",
            "calibration", chart("calibration", 280, [{ label: "Perfect", color: "rgb(var(--fg-muted))", shape: "dash" }]))}
        </GridItem>
        <GridItem span={{ lg: 6 }}>
          {card("Lead time", <Hourglass size={16} />, leadMode === "lead_cum" ? "Share of test-period cases flagged HIGH at least this long before diagnosis." : "When each test-period case was first flagged HIGH.",
            "For each test-period case, the earliest monthly landmark (up to 24 months before diagnosis) at which the model's score crossed its HIGH threshold (top 2%). Cumulative view: share of all test-period cases flagged at least m months ahead (the curve at 3 months is the '% flagged ≥ 3 months' metric). Distribution view: cases by month of first flag.",
            leadMode, chart(leadMode, 330),
            <Seg label="Lead-time view" value={leadMode} onChange={setLeadMode} options={[{ value: "lead_cum", label: "Cumulative" }, { value: "lead_time", label: "Distribution" }]} />)}
        </GridItem>
        <GridItem span={{ lg: 6 }}>
          <Card title="What drives XGBoost" icon={<Sparkles size={16} />}
            info={{ about: "Mean |SHAP| on test landmarks.", method: "Mean absolute SHAP value (contribution to the log-odds) of each feature over a sample of 5,000 test landmarks. HIV is included as a negative control: it has no effect in the data, so it should rank below 30." }}
            actions={hiv?.rank ? <StatusChip status={hiv.rank > 30 ? "good" : "warning"} size="md" label={<span className="tabular">HIV control #{hiv.rank}</span>} title={hiv.rank > 30 ? "Negative control ranks below 30, as expected" : "Negative control expected to rank below 30"} /> : undefined}
            detail={imp.data?.data?.length ? { tabs: chartDetailTabs({ table: <ImportanceTable rows={imp.data.data} /> }) } : undefined} detailLabel="View as table">
            {imp.isLoading ? <Loading h={340} /> : imp.error ? <ErrorNote error={imp.error} /> : !imp.data?.data?.length ? <Empty h={340}>No feature importance for this run.</Empty> :
              <ImportanceBars rows={imp.data.data} hiv={hiv} top={13} />}
          </Card>
        </GridItem>
        <GridItem span={12}>
          <Card title="Subgroup performance" icon={<Users size={16} />}
            info={{ about: "Is the model equally good for everyone?", method: "AUROC and sensitivity at the HIGH threshold within each subgroup of the test set. Subgroups with fewer than 20 cases are marked; their estimates are noisy. Vertical tick = overall AUROC." }}
            detail={sub.data?.data?.length ? { tabs: chartDetailTabs({ table: <DataTable rows={sub.data.data} columns={[{ key: "model_id", label: "Model" }, { key: "subgroup_var", label: "Variable" }, { key: "subgroup_value", label: "Subgroup" },
              { key: "auroc", label: "AUROC", num: true, fmt: (v) => fmt(v, 3) }, { key: "sens", label: "Sensitivity", num: true, fmt: (v) => `${fmt(100 * v, 1)}%` }, { key: "ppv", label: "PPV", num: true, fmt: (v) => (v === null ? "—" : `${fmt(100 * v, 1)}%`) },
              { key: "n_pos", label: "Cases", num: true }, { key: "n", label: "n", num: true }]} /> }) } : undefined} detailLabel="View as table">
            {sub.isLoading ? <Loading h={340} /> : sub.error ? <ErrorNote error={sub.error} /> :
              <SubgroupTable rows={sub.data?.data ?? []} models={ids} overall={overall} />}
          </Card>
        </GridItem>
      </BentoGrid>
    </div>
  );
}

function Training() {
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <PageHeader icon={<Brain size={18} />} title="Three ways to find cancer before diagnosis" />
      <Card title="Models are not trained for this run yet" icon={<Hourglass size={16} className="animate-pulse" />} iconTone="warning"
            info={<>Run <code>make train</code> (or <code>python -m ml.train</code>) and re-publish. This page checks again every 30 seconds and will fill in on its own. When ready: AUROC, AUPRC, Brier, sensitivity at 90% specificity, number needed to scope at the top 2%, lead time, calibration, SHAP importance with the HIV negative control, and subgroup performance.</>}
            actions={<StatusChip status="warning" label="Checking every 30 s" />}>
        <BentoGrid>
          {[1, 2, 3].map((t) => (
            <GridItem key={t} span={{ md: 4 }}>
              <Card tone="tile" title={TIER_META[t].name} icon={<Brain size={15} />} iconTone="neutral" info={TIER_META[t].blurb}>
                <StatusChip status="neutral" label={`Tier ${t} · pending`} />
              </Card>
            </GridItem>
          ))}
        </BentoGrid>
      </Card>
    </div>
  );
}
