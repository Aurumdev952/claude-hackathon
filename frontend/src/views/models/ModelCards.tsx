import type { ReactNode } from "react";
import { Award, Calculator, CircleDashed, GitBranch, Layers, Workflow } from "lucide-react";
import { AnimatedNumber, BentoGrid, Card, GradientRangeBar, GridItem, StatTile } from "@/components/ui";
import { fmt, int } from "@/lib/format";
import { usePalette } from "../quality/kit";
import { TIER_META, type Metrics, type RegistryModel, type Thresholds } from "./types";

/** SPEC §13.8 guidance ranges (not targets; reported honestly). */
const GUIDE: Record<number, { auroc: [number, number]; auprc: [number, number]; lead: [number, number] }> = {
  1: { auroc: [0.72, 0.8], auprc: [0.05, 0.12], lead: [2, 4] },
  2: { auroc: [0.82, 0.9], auprc: [0.15, 0.3], lead: [4, 6] },
  3: { auroc: [0.84, 0.92], auprc: [0.18, 0.35], lead: [5, 8] },
};
const MO = 30.44;

type Key = "auroc" | "auprc" | "brier" | "sens_at_spec90" | "nns_at_top2pct" | "median_lead_time_days";
const BETTER: Record<Key, "hi" | "lo"> = { auroc: "hi", auprc: "hi", brier: "lo", sens_at_spec90: "hi", nns_at_top2pct: "lo", median_lead_time_days: "hi" };

function bestTier(models: RegistryModel[], k: Key): number | null {
  const c = models.filter((m) => m.tier >= 1 && !(k === "brier" && m.tier === 1))
    .map((m) => ({ t: m.tier, v: m.metrics.test?.[k] as number | null | undefined })).filter((x) => x.v !== null && x.v !== undefined) as { t: number; v: number }[];
  if (c.length < 2) return null;
  c.sort((a, b) => (BETTER[k] === "hi" ? b.v - a.v : a.v - b.v));
  return c[0].v === c[1].v ? null : c[0].t;
}

export function ModelCards({ models, ensemble, thresholds }: { models: RegistryModel[]; ensemble?: Partial<Record<"val" | "test", Metrics>>; thresholds: Thresholds }) {
  const best = Object.fromEntries((Object.keys(BETTER) as Key[]).map((k) => [k, bestTier(models, k)])) as Record<Key, number | null>;
  return (
    <BentoGrid>
      {[1, 2, 3].map((t) => {
        const m = models.find((x) => x.tier === t);
        return <GridItem key={t} span={{ lg: 4 }}>{m ? <TierCard m={m} best={best} /> : <Missing tier={t} />}</GridItem>;
      })}
      {ensemble?.test && <GridItem span={12}><EnsembleStrip e={ensemble.test} thresholds={thresholds} /></GridItem>}
    </BentoGrid>
  );
}

const TIER_ICON: Record<number, ReactNode> = { 1: <Calculator size={16} />, 2: <GitBranch size={16} />, 3: <Workflow size={16} />, 0: <Layers size={16} /> };

function TierCard({ m, best }: { m: RegistryModel; best: Record<Key, number | null> }) {
  const { series: S } = usePalette();
  const meta = TIER_META[m.tier];
  const t = m.metrics.test;
  const v = m.metrics.val;
  const g = GUIDE[m.tier];
  const c = S[meta.slot];
  const lbl = (k: Key, text: string) => <span className="inline-flex items-center gap-1">{text}{best[k] === m.tier && <BestTag />}</span>;
  const all = (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
      <StatTile label={lbl("auroc", "AUROC")} value={fmt(t?.auroc, 3)} info={g ? `Guidance ${g.auroc[0]}–${g.auroc[1]}` : undefined} />
      <StatTile label={lbl("auprc", "AUPRC")} value={fmt(t?.auprc, 3)} info={g ? `Guidance ${g.auprc[0]}–${g.auprc[1]}` : undefined} />
      <StatTile label={lbl("brier", "Brier")} value={fmt(t?.brier, 4)} info={m.tier === 1 ? "On the rescaled points score" : t?.ece !== null && t?.ece !== undefined ? `Expected calibration error ${fmt(t.ece, 4)}` : undefined} />
      <StatTile label={lbl("sens_at_spec90", "Sensitivity")} value={t?.sens_at_spec90 === null || t?.sens_at_spec90 === undefined ? "—" : `${fmt(100 * t.sens_at_spec90, 0)}%`} info="At 90% specificity" />
      <StatTile label={lbl("nns_at_top2pct", "Number needed to scope")} value={fmt(t?.nns_at_top2pct, 1)} info={`At the top 2%${t?.ppv_at_top2pct ? `; PPV ${fmt(100 * t.ppv_at_top2pct, 1)}%` : ""}`} />
      <StatTile label={lbl("median_lead_time_days", "Median lead time")} value={t?.median_lead_time_days === null || t?.median_lead_time_days === undefined ? "—" : fmt(t.median_lead_time_days / MO, 1)} unit="months" info={g ? `Guidance ${g.lead[0]}–${g.lead[1]} months` : undefined} />
      <StatTile label="Flagged 3 months ahead" value={t?.pct_flagged_ge_90d === null || t?.pct_flagged_ge_90d === undefined ? "—" : `${fmt(t.pct_flagged_ge_90d, 0)}%`} info="Share of test-period cases flagged HIGH at least 3 months before diagnosis" />
    </div>
  );
  return (
    <Card aria-label={`${meta.name} model`} className="h-full"
      title={<span className="inline-flex items-center gap-2">{meta.name}<span className="w-2 h-2 rounded-full" style={{ background: c }} aria-hidden /></span>} titleText={meta.name}
      icon={TIER_ICON[m.tier]}
      detail={{ title: meta.name, subtitle: `Tier ${m.tier}, version ${m.version}`, size: "3xl", children: (
        <div className="flex flex-col gap-5">
          <div className="text-[14px] leading-[22px] text-ink/90 max-w-[640px] flex flex-col gap-2">
            <p>{meta.blurb}</p>
            <p className="text-muted">Test set: {int(t?.n_pos)} cases in {int((t?.n_pos ?? 0) + (t?.n_neg ?? 0))} landmarks{v?.auroc !== null && v?.auroc !== undefined ? `; validation AUROC ${fmt(v.auroc, 3)}` : ""}. Guidance ranges are SPEC §13.8 expectations, not targets. The award icon marks the best of the three tiers.</p>
          </div>
          {all}
        </div>
      ) }} detailLabel={`${meta.name}: all metrics`}>
      <div className="flex items-end gap-5">
        <div>
          <div className="text-label text-muted">{lbl("auroc", "AUROC")}</div>
          <AnimatedNumber value={t?.auroc ?? null} decimals={3} className="text-display tabular" />
        </div>
        <div className="flex-1 pb-1.5">
          <GradientRangeBar value={t?.auroc ?? null} min={0.5} max={1} reverse tone="sky" thresholds={g ? g.auroc : []} label={`AUROC on a 0.5 (chance) to 1.0 scale${g ? `, guidance ${g.auroc[0]}–${g.auroc[1]}` : ""}`}
                            minLabel="0.5" maxLabel="1.0" format={(n) => fmt(n, 2)} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5 mt-5">
        <StatTile label={lbl("auprc", "AUPRC")} value={fmt(t?.auprc, 3)} info={g ? `Guidance ${g.auprc[0]}–${g.auprc[1]}` : undefined} />
        <StatTile label={lbl("sens_at_spec90", "Sensitivity")} value={t?.sens_at_spec90 === null || t?.sens_at_spec90 === undefined ? "—" : `${fmt(100 * t.sens_at_spec90, 0)}%`} info="At 90% specificity" />
        <StatTile label={lbl("median_lead_time_days", "Lead time")} value={t?.median_lead_time_days === null || t?.median_lead_time_days === undefined ? "—" : fmt(t.median_lead_time_days / MO, 1)} unit="mo" info={`Median${g ? `; guidance ${g.lead[0]}–${g.lead[1]} months` : ""}`} />
      </div>
    </Card>
  );
}

function BestTag() {
  return <span className="inline-flex items-center text-ink" title="Best of the three tiers"><Award size={12} aria-hidden /><span className="sr-only">best of the three tiers</span></span>;
}

function Missing({ tier }: { tier: number }) {
  const meta = TIER_META[tier];
  return (
    <Card tone="outline" className="border-dashed h-full" title={meta.name} icon={TIER_ICON[tier]} iconTone="neutral"
          info={<>{meta.blurb} Not available in this training run{tier === 3 ? "; the ensemble falls back to XGBoost alone (SPEC §13.9)." : "."}</>}>
      <div className="flex-1 grid place-items-center py-6"><span className="inline-flex items-center gap-2 text-label text-muted"><CircleDashed size={14} aria-hidden />Not trained this run</span></div>
    </Card>
  );
}

function EnsembleStrip({ e, thresholds }: { e: Metrics; thresholds: Thresholds }) {
  const { series: S } = usePalette();
  return (
    <Card title={<span className="inline-flex items-center gap-2">Final risk band<span className="w-2 h-2 rounded-full" style={{ background: S[TIER_META[0].slot] }} aria-hidden /></span>} titleText="Final risk band"
          icon={TIER_ICON[0]} info={<>{TIER_META[0].blurb}</>}>
      <p className="text-label font-normal text-muted -mt-1 mb-4 tabular">
        Ensemble of XGBoost and the sequence model.{thresholds ? <> High band: the top 2%, probability {fmt(100 * thresholds.high_cut, 2)}% or more. Medium band: the next 8%, {fmt(100 * thresholds.medium_cut, 2)}% or more.</> : null}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <StatTile label="AUROC" value={fmt(e.auroc, 3)} />
        <StatTile label="AUPRC" value={fmt(e.auprc, 3)} />
        <StatTile label="Sensitivity" value={e.sens_at_spec90 === null ? "—" : `${fmt(100 * e.sens_at_spec90, 0)}%`} info="At 90% specificity" />
        <StatTile label="Number needed to scope" value={fmt(e.nns_at_top2pct, 1)} info="At the top 2%" />
        <StatTile label="Median lead time" value={e.median_lead_time_days ? fmt(e.median_lead_time_days / MO, 1) : "—"} unit="months" />
      </div>
    </Card>
  );
}
