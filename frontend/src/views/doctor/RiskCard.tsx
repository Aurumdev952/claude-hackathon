import { motion, useReducedMotion } from "framer-motion";
import { CircleDashed } from "lucide-react";
import { AnimatedNumber, InfoHint, RiskScoreBar, StatTile } from "@/components/ui";
import { BandChip } from "@/components/ui/Status";
import { fmt } from "@/lib/format";
import { DIVERGING } from "@/lib/viz";
import { EASE } from "@/lib/motion";
import type { Reason } from "@/api/types";

/** Method text shared by the doctor views (lives behind ⓘ). */
export const RISK_METHOD = "Final band = mean of the calibrated XGBoost and sequence-model probabilities; HIGH is the top 2% of eligible GI-cohort patients (endoscopy capacity), MEDIUM the next 8%. Thresholds were frozen at training time.";
export const SHAP_NOTE = "Contributions are SHAP values (log-odds) from the XGBoost model. Decision support only — synthetic data.";
const NOT_SCORED = "Diagnosed, outside the GI cohort, or models not trained.";

/** "Not scored" placeholder with the reason behind ⓘ. */
export function NotScored() {
  return (
    <div className="flex items-center gap-1 text-label text-fg-muted">
      <CircleDashed size={14} aria-hidden /><span>Not scored</span>
      <InfoHint content={NOT_SCORED} mode="tooltip" size={13} label="Why not scored" />
    </div>
  );
}

/** Top SHAP reasons as animated contribution bars. */
export function ReasonBars({ reasons, max: n = 5 }: { reasons: Reason[]; max?: number }) {
  const reduce = useReducedMotion();
  const max = Math.max(0.01, ...reasons.map((r) => Math.abs(r.contribution)));
  if (!reasons.length) return <div className="text-label text-fg-muted">No positive contributions above baseline</div>;
  return (
    <ul className="flex flex-col gap-2">
      {reasons.slice(0, n).map((r, i) => (
        <li key={r.feature} className="text-[12.5px]">
          <div className="flex justify-between gap-2"><span className="text-fg truncate">{r.label}</span><span className="text-fg-muted tabular">+{r.contribution.toFixed(2)}</span></div>
          <div className="h-1.5 rounded-full bg-fg/[0.06] mt-1 overflow-hidden" aria-hidden>
            <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${DIVERGING.pos}99, ${DIVERGING.pos})` }}
                        initial={reduce ? false : { width: 0 }} animate={{ width: `${(100 * Math.abs(r.contribution)) / max}%` }}
                        transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : 0.1 + i * 0.06 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Risk card body (SPEC §16.3 V7): ensemble probability + band, three model tiers, top reasons. Text lives behind ⓘ. */
export function RiskCard({ risk, compact = false }: { risk: any; compact?: boolean }) {
  if (!risk) return <NotScored />;
  const reasons: Reason[] = risk.top_reasons ?? [];
  const tiers = [
    { k: "Points score", v: risk.t1_score as number, sub: `band ${risk.t1_band}`, info: "Tier 1: transparent points score from symptoms, age, labs and visit pattern." },
    { k: "XGBoost", v: `${fmt(100 * (risk.t2_prob ?? 0))}%`, sub: "12-month", info: "Tier 2: calibrated gradient-boosted trees, 12-month probability." },
    { k: "Sequence", v: risk.t3_prob === null || risk.t3_prob === undefined ? "—" : `${fmt(100 * risk.t3_prob)}%`, sub: "12-month", info: "Tier 3: sequence model over the visit timeline, 12-month probability." },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <AnimatedNumber value={100 * risk.ensemble_prob} decimals={1} className="text-display text-fg" />
          <span className="text-title text-fg-muted">%</span>
        </div>
        <BandChip band={risk.risk_band} size="md" />
      </div>
      <RiskScoreBar score={risk.ensemble_prob} band={risk.risk_band} compact label="Ensemble 12-month probability" />
      {!compact && (
        <div className="grid grid-cols-3 gap-2">
          {tiers.map((t) => <StatTile key={t.k} label={t.k} value={t.v} sub={t.sub} info={t.info} />)}
        </div>
      )}
      <div>
        <div className="flex items-center gap-0.5 mb-2">
          <h3 className="text-[13px] font-semibold text-fg">Why flagged</h3>
          <InfoHint content={SHAP_NOTE} mode="tooltip" size={13} label="About why flagged" />
        </div>
        <ReasonBars reasons={reasons} max={compact ? 3 : 5} />
      </div>
    </div>
  );
}
