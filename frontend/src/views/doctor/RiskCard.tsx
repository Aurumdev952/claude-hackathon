import { motion, useReducedMotion } from "framer-motion";
import { CircleDashed } from "lucide-react";
import { AnimatedNumber, InfoHint, StatTile } from "@/components/ui";
import { fmt } from "@/lib/format";
import { EASE } from "@/lib/motion";
import type { Reason } from "@/api/types";
import { BandMark } from "./BandMark";

/** Method text shared by the doctor views (lives behind ⓘ). */
export const RISK_METHOD = "Final band = mean of the calibrated XGBoost and sequence-model probabilities; HIGH is the top 2% of eligible GI-cohort patients (endoscopy capacity), MEDIUM the next 8%. Thresholds were frozen at training time.";
export const SHAP_NOTE = "Contributions are SHAP values (log-odds) from the XGBoost model. Decision support only, synthetic data.";
const NOT_SCORED = "Diagnosed, outside the GI cohort, or models not trained.";

/** "Not scored" placeholder with the reason behind ⓘ. */
export function NotScored() {
  return (
    <div className="flex items-center gap-1.5 text-label text-muted">
      <CircleDashed size={14} aria-hidden /><span>Not scored</span>
      <InfoHint content={NOT_SCORED} mode="tooltip" size={13} label="Why not scored" />
    </div>
  );
}

/** Thin 6px track with one solid fill (design v3, reference "2.32 SLW"). */
export function Track({ value, tone = "sky", label, delay = 0.1, height = 6 }: { value: number; tone?: "sky" | "signal" | "ink"; label?: string; delay?: number; height?: number }) {
  const reduce = useReducedMotion();
  const fill = tone === "signal" ? "bg-signal" : tone === "ink" ? "bg-ink" : "bg-sky";
  const w = Math.max(0, Math.min(1, value));
  return (
    <div className="relative rounded-full bg-tile dark:bg-hairline overflow-hidden" style={{ height }} aria-hidden={label ? undefined : true}
         {...(label ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(100 * w) } : {})}>
      <motion.div className={`absolute inset-y-0 left-0 rounded-full ${fill}`} initial={reduce ? false : { width: 0 }} animate={{ width: `${Math.max(w * 100, w > 0 ? 2 : 0)}%` }}
                  transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : delay }} />
    </div>
  );
}

/** Top SHAP reasons as plain sky bars (data hue, not attention): label, contribution and a thin track. */
export function ReasonBars({ reasons, max: n = 5 }: { reasons: Reason[]; max?: number }) {
  const max = Math.max(0.01, ...reasons.map((r) => Math.abs(r.contribution)));
  if (!reasons.length) return <div className="text-label text-muted">No positive contributions above baseline</div>;
  return (
    <ul className="flex flex-col gap-4">
      {reasons.slice(0, n).map((r, i) => (
        <li key={r.feature} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 mb-1.5">
            <span className="text-[14px] leading-5 text-ink truncate" title={r.label}>{r.label}</span>
            <span className="text-label text-muted tabular shrink-0">+{r.contribution.toFixed(2)}</span>
          </div>
          <Track value={Math.abs(r.contribution) / max} delay={0.1 + i * 0.06} />
        </li>
      ))}
    </ul>
  );
}

const TIERS = (risk: any) => [
  { k: "Points", v: risk.t1_score as number, sub: `Band ${String(risk.t1_band ?? "").toLowerCase()}`, info: "Tier 1: transparent points score from symptoms, age, labs and visit pattern." },
  { k: "XGBoost", v: `${fmt(100 * (risk.t2_prob ?? 0))}%`, sub: "12 months", info: "Tier 2: calibrated gradient-boosted trees, 12-month probability." },
  { k: "Sequence", v: risk.t3_prob === null || risk.t3_prob === undefined ? "—" : `${fmt(100 * risk.t3_prob)}%`, sub: "12 months", info: "Tier 3: sequence model over the visit timeline, 12-month probability." },
];

/** Risk summary (reference "Activity 2.780 Cal"): 48px probability with a muted unit, one helper line, a thin track and
 * the three model tiers as grey tiles. */
export function RiskSummary({ risk, tiers = true }: { risk: any; tiers?: boolean }) {
  if (!risk) return <NotScored />;
  const high = risk.risk_band === "HIGH";
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-1.5">
        <AnimatedNumber value={100 * risk.ensemble_prob} decimals={1} className="text-display text-ink" />
        <span className="text-[17px] text-muted">%</span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-label font-normal text-muted">
        <span>12-month probability</span>
        <BandMark band={risk.risk_band} label={`${String(risk.risk_band ?? "").charAt(0)}${String(risk.risk_band ?? "").slice(1).toLowerCase()} band`} />
      </div>
      <div className="mt-4">
        <Track value={risk.ensemble_prob} tone={high ? "signal" : "sky"} label="Ensemble 12-month probability" />
      </div>
      {tiers && (
        <div className="grid grid-cols-3 gap-2 mt-5">
          {TIERS(risk).map((t) => <StatTile key={t.k} label={t.k} value={t.v} sub={t.sub} info={t.info} className="!px-3.5" />)}
        </div>
      )}
    </div>
  );
}

/** Risk + reasons in one body (used in the case-analysis risk modal). */
export function RiskCard({ risk }: { risk: any; compact?: boolean }) {
  if (!risk) return <NotScored />;
  return (
    <div className="flex flex-col gap-7">
      <RiskSummary risk={risk} />
      <section>
        <div className="flex items-center gap-0.5 mb-3">
          <h3 className="text-title text-ink">Why flagged</h3>
          <InfoHint content={SHAP_NOTE} mode="tooltip" size={13} label="About why flagged" />
        </div>
        <ReasonBars reasons={risk.top_reasons ?? []} />
      </section>
    </div>
  );
}
