import { Award, CircleDashed } from "lucide-react";
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
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
        {[1, 2, 3].map((t) => {
          const m = models.find((x) => x.tier === t);
          return m ? <Card key={t} m={m} best={best} /> : <Missing key={t} tier={t} />;
        })}
      </div>
      {ensemble?.test && <EnsembleStrip e={ensemble.test} thresholds={thresholds} />}
    </div>
  );
}

function Card({ m, best }: { m: RegistryModel; best: Record<Key, number | null> }) {
  const { series: S } = usePalette();
  const meta = TIER_META[m.tier];
  const t = m.metrics.test;
  const v = m.metrics.val;
  const g = GUIDE[m.tier];
  const c = S[meta.slot];
  const cell = (k: Key, label: string, value: string, sub?: string) => (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-fog whitespace-nowrap truncate">{label}</div>
      <div className="text-base font-semibold tabular leading-tight flex items-center gap-1.5">{value}
        {best[k] === m.tier && <BestTag />}</div>
      {sub && <div className="text-[10px] text-fog leading-tight">{sub}</div>}
    </div>
  );
  return (
    <article className="panel p-4 flex flex-col gap-3 relative overflow-hidden animate-rise" aria-label={`${meta.name} model`}>
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: c }} aria-hidden />
      <header>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-fog font-semibold">Tier {m.tier}</span>
          <span className="flex-1" />
          <span className="text-[10px] text-fog tabular" title={m.model_id}>v{m.version}</span>
        </div>
        <h3 className="text-lg font-bold leading-tight flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: c }} aria-hidden />{meta.name}</h3>
        <p className="text-[11px] text-fog leading-snug mt-0.5">{meta.blurb}</p>
      </header>
      <div className="flex items-end gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fog flex items-center gap-1.5">AUROC {best.auroc === m.tier && <BestTag />}</div>
          <div className="text-4xl font-semibold tabular leading-none mt-0.5">{fmt(t?.auroc, 3)}</div>
        </div>
        <div className="flex-1 pb-1"><RangeBar value={t?.auroc ?? null} guide={g?.auroc} color={c} /></div>
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2.5 border-t border-line/50 pt-3">
        {cell("auprc", "AUPRC", fmt(t?.auprc, 3), g ? `guide ${g.auprc[0]}–${g.auprc[1]}` : undefined)}
        {cell("brier", "Brier", fmt(t?.brier, 4), m.tier === 1 ? "on rescaled score" : t?.ece !== null && t?.ece !== undefined ? `ECE ${fmt(t.ece, 4)}` : undefined)}
        {cell("sens_at_spec90", "Sens @ 90% spec", t?.sens_at_spec90 === null || t?.sens_at_spec90 === undefined ? "—" : `${fmt(100 * t.sens_at_spec90, 0)}%`)}
        {cell("nns_at_top2pct", "NNS @ top 2%", fmt(t?.nns_at_top2pct, 1), t?.ppv_at_top2pct ? `PPV ${fmt(100 * t.ppv_at_top2pct, 1)}%` : undefined)}
        {cell("median_lead_time_days", "Median lead", t?.median_lead_time_days === null || t?.median_lead_time_days === undefined ? "—" : `${fmt(t.median_lead_time_days / MO, 1)} mo`, g ? `guide ${g.lead[0]}–${g.lead[1]} mo` : undefined)}
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-fog whitespace-nowrap">Flagged ≥ 3 mo</div>
          <div className="text-base font-semibold tabular leading-tight">{t?.pct_flagged_ge_90d === null || t?.pct_flagged_ge_90d === undefined ? "—" : `${fmt(t.pct_flagged_ge_90d, 0)}%`}</div>
          <div className="text-[10px] text-fog leading-tight">of test-period cases</div>
        </div>
      </div>
      <footer className="text-[10px] text-fog tabular border-t border-line/50 pt-2 flex flex-wrap gap-x-3">
        <span>test {int(t?.n_pos)} cases / {int((t?.n_pos ?? 0) + (t?.n_neg ?? 0))} landmarks</span>
        {v?.auroc !== null && v?.auroc !== undefined && <span>val AUROC {fmt(v.auroc, 3)}</span>}
      </footer>
    </article>
  );
}

function BestTag() {
  return <span className="inline-flex items-center gap-0.5 rounded px-1 text-[9px] font-semibold uppercase tracking-wider text-mist bg-mist/10" title="Best of the three tiers"><Award size={9} aria-hidden />best</span>;
}

/** AUROC on a 0.5 (chance) → 1.0 scale with the SPEC guidance range shaded. */
function RangeBar({ value, guide, color }: { value: number | null; guide?: [number, number]; color: string }) {
  const x = (v: number) => `${Math.max(0, Math.min(1, (v - 0.5) / 0.5)) * 100}%`;
  return (
    <div className="relative h-7" title={guide ? `SPEC guidance ${guide[0]}–${guide[1]}` : undefined}>
      <div className="absolute inset-x-0 top-2 h-1.5 rounded-full bg-ridge2" />
      {guide && <div className="absolute top-2 h-1.5 bg-fog/35 rounded-sm" style={{ left: x(guide[0]), width: `calc(${x(guide[1])} - ${x(guide[0])})` }} />}
      {value !== null && <div className="absolute top-[3px] w-3.5 h-3.5 rounded-full -translate-x-1/2 border-2 border-ridge" style={{ left: x(value), background: color }} />}
      <div className="absolute inset-x-0 top-[18px] flex justify-between text-[9px] text-fog tabular"><span>0.5 chance</span>{guide && <span>guide {guide[0]}–{guide[1]}</span>}<span>1.0</span></div>
    </div>
  );
}

function Missing({ tier }: { tier: number }) {
  const meta = TIER_META[tier];
  return (
    <article className="panel p-4 flex flex-col gap-2 border-dashed opacity-80">
      <span className="text-[10px] uppercase tracking-[0.14em] text-fog font-semibold">Tier {tier}</span>
      <h3 className="text-lg font-bold text-fog">{meta.name}</h3>
      <p className="text-[11px] text-fog">{meta.blurb}</p>
      <div className="flex-1 flex items-center gap-2 text-xs text-fog"><CircleDashed size={14} /> Not available in this training run{tier === 3 ? " — the ensemble falls back to XGBoost alone (SPEC §13.9)." : "."}</div>
    </article>
  );
}

function EnsembleStrip({ e, thresholds }: { e: Metrics; thresholds: Thresholds }) {
  const { series: S } = usePalette();
  return (
    <div className="panel px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs">
      <span className="flex items-center gap-2 font-semibold"><span className="w-2.5 h-2.5 rounded-full" style={{ background: S[TIER_META[0].slot] }} aria-hidden />Final risk band · ensemble</span>
      <span className="tabular"><span className="text-fog">AUROC</span> <b>{fmt(e.auroc, 3)}</b></span>
      <span className="tabular"><span className="text-fog">AUPRC</span> <b>{fmt(e.auprc, 3)}</b></span>
      <span className="tabular"><span className="text-fog">Sens @ 90% spec</span> <b>{e.sens_at_spec90 === null ? "—" : `${fmt(100 * e.sens_at_spec90, 0)}%`}</b></span>
      <span className="tabular"><span className="text-fog">NNS @ top 2%</span> <b>{fmt(e.nns_at_top2pct, 1)}</b></span>
      <span className="tabular"><span className="text-fog">Median lead</span> <b>{e.median_lead_time_days ? `${fmt(e.median_lead_time_days / MO, 1)} mo` : "—"}</b></span>
      <span className="flex-1" />
      {thresholds && <span className="text-fog tabular">HIGH = top 2% (p ≥ {fmt(100 * thresholds.high_cut, 2)}%) · MEDIUM = next 8% (p ≥ {fmt(100 * thresholds.medium_cut, 2)}%)</span>}
    </div>
  );
}
