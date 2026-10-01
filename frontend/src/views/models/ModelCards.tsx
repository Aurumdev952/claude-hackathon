import type { ReactNode } from "react";
import { Award, Calculator, CircleDashed, GitBranch, Layers, Workflow } from "lucide-react";
import { AnimatedNumber, BentoGrid, Card, GradientRangeBar, GridItem, StatTile, StatusChip } from "@/components/ui";
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
  return (
    <Card aria-label={`${meta.name} model`} className="overflow-hidden"
      title={<span className="inline-flex items-center gap-2">{meta.name}<span className="w-2 h-2 rounded-full" style={{ background: c }} aria-hidden /></span>} titleText={meta.name}
      icon={TIER_ICON[m.tier]}
      info={{ about: meta.blurb, notes: <>Test set: {int(t?.n_pos)} cases / {int((t?.n_pos ?? 0) + (t?.n_neg ?? 0))} landmarks{v?.auroc !== null && v?.auroc !== undefined ? ` · validation AUROC ${fmt(v.auroc, 3)}` : ""}. Guidance ranges are SPEC §13.8 expectations, not targets. The award icon marks the best of the three tiers.</> }}
      actions={<StatusChip status="neutral" icon={false} label={<span className="tabular">Tier {m.tier} · v{m.version}</span>} title={m.model_id} />}>
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: c }} aria-hidden />
      <div className="flex items-end gap-4">
        <div>
          <div className="text-micro text-fg-muted">{lbl("auroc", "AUROC")}</div>
          <AnimatedNumber value={t?.auroc ?? null} decimals={3} className="text-display tabular" />
        </div>
        <div className="flex-1 pb-1">
          <GradientRangeBar value={t?.auroc ?? null} min={0.5} max={1} reverse thresholds={g ? g.auroc : []} label={`AUROC on a 0.5 (chance) to 1.0 scale${g ? `, guidance ${g.auroc[0]}–${g.auroc[1]}` : ""}`}
                            minLabel="0.5" maxLabel="1.0" format={(n) => fmt(n, 2)} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3">
        <StatTile label={lbl("auprc", "AUPRC")} value={fmt(t?.auprc, 3)} info={g ? `Guidance ${g.auprc[0]}–${g.auprc[1]}` : undefined} />
        <StatTile label={lbl("brier", "Brier")} value={fmt(t?.brier, 4)} info={m.tier === 1 ? "On the rescaled points score" : t?.ece !== null && t?.ece !== undefined ? `Expected calibration error ${fmt(t.ece, 4)}` : undefined} />
        <StatTile label={lbl("sens_at_spec90", "Sensitivity")} value={t?.sens_at_spec90 === null || t?.sens_at_spec90 === undefined ? "—" : `${fmt(100 * t.sens_at_spec90, 0)}%`} info="At 90% specificity" />
        <StatTile label={lbl("nns_at_top2pct", "NNS top 2%")} value={fmt(t?.nns_at_top2pct, 1)} info={`Number needed to scope at the top 2%${t?.ppv_at_top2pct ? `; PPV ${fmt(100 * t.ppv_at_top2pct, 1)}%` : ""}`} />
        <StatTile label={lbl("median_lead_time_days", "Median lead")} value={t?.median_lead_time_days === null || t?.median_lead_time_days === undefined ? "—" : fmt(t.median_lead_time_days / MO, 1)} unit="mo" info={g ? `Guidance ${g.lead[0]}–${g.lead[1]} months` : undefined} />
        <StatTile label="Flagged ≥ 3 mo" value={t?.pct_flagged_ge_90d === null || t?.pct_flagged_ge_90d === undefined ? "—" : `${fmt(t.pct_flagged_ge_90d, 0)}%`} info="Share of test-period cases flagged HIGH at least 3 months before diagnosis" />
      </div>
    </Card>
  );
}

function BestTag() {
  return <span className="inline-flex items-center text-tone-warning" title="Best of the three tiers"><Award size={11} aria-hidden /><span className="sr-only">best of the three tiers</span></span>;
}

function Missing({ tier }: { tier: number }) {
  const meta = TIER_META[tier];
  return (
    <Card tone="outline" className="border-dashed" title={meta.name} icon={TIER_ICON[tier]} iconTone="neutral"
          info={<>{meta.blurb} Not available in this training run{tier === 3 ? " — the ensemble falls back to XGBoost alone (SPEC §13.9)." : "."}</>}
          actions={<StatusChip status="neutral" icon={false} label={`Tier ${tier}`} />}>
      <div className="flex-1 grid place-items-center py-6"><StatusChip status="neutral" size="md" icon={<CircleDashed size={12} />} label="Not trained this run" /></div>
    </Card>
  );
}

function EnsembleStrip({ e, thresholds }: { e: Metrics; thresholds: Thresholds }) {
  const { series: S } = usePalette();
  return (
    <Card title={<span className="inline-flex items-center gap-2">Final risk band · ensemble<span className="w-2 h-2 rounded-full" style={{ background: S[TIER_META[0].slot] }} aria-hidden /></span>} titleText="Final risk band · ensemble"
          icon={TIER_ICON[0]} info={TIER_META[0].blurb}
          actions={thresholds ? <div className="hidden md:flex items-center gap-1.5">
            <StatusChip status="critical" label={<span className="tabular">HIGH top 2% · p ≥ {fmt(100 * thresholds.high_cut, 2)}%</span>} />
            <StatusChip status="warning" label={<span className="tabular">MEDIUM next 8% · p ≥ {fmt(100 * thresholds.medium_cut, 2)}%</span>} />
          </div> : undefined}>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <StatTile label="AUROC" value={fmt(e.auroc, 3)} />
        <StatTile label="AUPRC" value={fmt(e.auprc, 3)} />
        <StatTile label="Sensitivity" value={e.sens_at_spec90 === null ? "—" : `${fmt(100 * e.sens_at_spec90, 0)}%`} info="At 90% specificity" />
        <StatTile label="NNS top 2%" value={fmt(e.nns_at_top2pct, 1)} info="Number needed to scope at the top 2%" />
        <StatTile label="Median lead" value={e.median_lead_time_days ? fmt(e.median_lead_time_days / MO, 1) : "—"} unit="mo" />
      </div>
    </Card>
  );
}
