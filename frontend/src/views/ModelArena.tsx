import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Brain, Hourglass } from "lucide-react";
import { ApiError, get } from "@/api/client";
import { ErrorNote, Loading, Panel, Seg } from "@/components/ui/Panel";
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

  return (
    <div className="flex flex-col gap-4 max-w-[1500px]">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="panel-title">V6 · Model arena</div>
          <h1 className="text-2xl font-bold tracking-tight">Three ways to find cancer before diagnosis</h1>
          <p className="text-sm text-fog max-w-3xl mt-0.5">Each model answers the same question at every monthly landmark — <i>will this GI-cohort patient be diagnosed with gastric cancer in the next 12 months?</i> — and is scored on a later, held-out time period.</p>
        </div>
        <div className="flex-1" />
        {m0 && (
          <dl className="text-[11px] text-fog grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 border-l border-line/60 pl-3 tabular">
            <dt>Trained</dt><dd className="text-mist">{date(m0.trained_at)}</dd>
            <dt>Train window</dt><dd className="text-mist">{m0.train_window}</dd>
            <dt>Test set</dt><dd className="text-mist">{test ? `${test.n_pos.toLocaleString()} cases · ${fmt(100 * (prevalence ?? 0), 2)}% base rate` : "—"}</dd>
          </dl>
        )}
      </div>

      <ModelCards models={models} ensemble={ensemble} thresholds={thresholds} />

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
        <Panel title="ROC curves" subtitle="Ranking: sensitivity against false-positive rate"
          method="Receiver operating characteristic on the temporal test set. The area under it (AUROC) is the chance a random future case is ranked above a random non-case. Dashed diagonal = chance."
          table={curves.length ? <CurveTable kind="roc" models={curves} /> : undefined}>
          {chart("roc", 280, [{ label: "Chance", color: "rgb(var(--fog))", shape: "dash" }])}
        </Panel>
        <Panel title="Precision–recall curves" subtitle="The honest view for a rare outcome"
          method="Precision (PPV) against recall (sensitivity). With cancer this rare, AUPRC is the most honest single number: the dashed line is the base rate a random list would achieve."
          table={curves.length ? <CurveTable kind="pr" models={curves} /> : undefined}>
          {chart("pr", 280, [{ label: "Base rate", color: "rgb(var(--fog))", shape: "dash" }])}
        </Panel>
        <Panel title="Calibration" subtitle="Do predicted risks match what happened?"
          method="Test landmarks binned into predicted-risk deciles; each dot is the mean predicted risk vs the observed 12-month cancer rate in that decile. Dots on the dashed diagonal are perfectly calibrated. The points score is not a probability and is omitted."
          table={curves.length ? <CurveTable kind="calibration" models={curves} /> : undefined}>
          {chart("calibration", 280, [{ label: "Perfect calibration", color: "rgb(var(--fog))", shape: "dash" }])}
        </Panel>
        <Panel title="Lead time" subtitle={leadMode === "lead_cum" ? "Share of test-period cases flagged HIGH at least this long before diagnosis" : "When each test-period case was first flagged HIGH"}
          method="For each test-period case, the earliest monthly landmark (up to 24 months before diagnosis) at which the model's score crossed its HIGH threshold (top 2%). Cumulative view: share of all test-period cases flagged at least m months ahead (the curve at 3 months is the '% flagged ≥ 3 months' metric). Distribution view: cases by month of first flag."
          actions={<Seg label="Lead-time view" value={leadMode} onChange={setLeadMode} options={[{ value: "lead_cum", label: "Cumulative" }, { value: "lead_time", label: "Distribution" }]} />}
          table={curves.length ? <CurveTable kind={leadMode} models={curves} /> : undefined}>
          {chart(leadMode, 280)}
        </Panel>
        <Panel title="What drives the XGBoost model" subtitle={hiv?.rank ? <span className="tabular">Mean |SHAP| on test landmarks · HIV negative control ranks <b className="text-mist">#{hiv.rank}</b>{hiv.rank > 30 ? " (expected > 30 ✓)" : " (expected > 30)"}</span> : "Mean |SHAP| on test landmarks"}
          method="Mean absolute SHAP value (contribution to the log-odds) of each feature over a sample of 5,000 test landmarks. HIV is included as a negative control: it has no effect in the data, so it should rank below 30."
          table={imp.data?.data?.length ? <ImportanceTable rows={imp.data.data} /> : undefined}>
          {imp.isLoading ? <Loading h={340} /> : imp.error ? <ErrorNote error={imp.error} /> : !imp.data?.data?.length ? <Empty h={340}>No feature importance for this run.</Empty> :
            <ImportanceBars rows={imp.data.data} hiv={hiv} />}
        </Panel>
        <Panel title="Subgroup performance" subtitle="Is the model equally good for everyone?"
          method="AUROC and sensitivity at the HIGH threshold within each subgroup of the test set. Subgroups with fewer than 20 cases are marked; their estimates are noisy. Vertical tick = overall AUROC.">
          {sub.isLoading ? <Loading h={340} /> : sub.error ? <ErrorNote error={sub.error} /> :
            <SubgroupTable rows={sub.data?.data ?? []} models={ids} overall={overall} />}
        </Panel>
      </div>
    </div>
  );
}

function Training() {
  return (
    <div className="flex flex-col gap-4 max-w-[1100px]">
      <div>
        <div className="panel-title">V6 · Model arena</div>
        <h1 className="text-2xl font-bold tracking-tight">Three ways to find cancer before diagnosis</h1>
      </div>
      <div className="panel p-6 flex gap-5 items-start">
        <div className="w-11 h-11 rounded-xl bg-kivu/20 flex items-center justify-center shrink-0"><Hourglass size={20} className="text-kivu animate-pulse" /></div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold">Models are not trained for this run yet</h2>
          <p className="text-sm text-fog mt-1 max-w-2xl">Run <code className="text-mist text-xs">make train</code> (or <code className="text-mist text-xs">python -m ml.train</code>) and re-publish. This page checks again every 30 seconds and will fill in on its own.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
            {[1, 2, 3].map((t) => (
              <div key={t} className="rounded-lg border border-dashed border-line/70 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-fog font-semibold">Tier {t}</div>
                <div className="font-semibold flex items-center gap-1.5"><Brain size={14} className="text-fog" />{TIER_META[t].name}</div>
                <p className="text-[11px] text-fog mt-1 leading-snug">{TIER_META[t].blurb}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-fog mt-3">When ready: AUROC, AUPRC, Brier, sensitivity at 90% specificity, number needed to scope at the top 2%, lead time, calibration, SHAP importance with the HIV negative control, and subgroup performance.</p>
        </div>
      </div>
    </div>
  );
}
