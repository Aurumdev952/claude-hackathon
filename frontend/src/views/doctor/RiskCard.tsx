import { BandChip } from "@/components/ui/Status";
import { fmt } from "@/lib/format";
import { DIVERGING } from "@/lib/viz";
import type { Reason } from "@/api/types";

/** Risk card (SPEC §16.3 V7): three tiers side by side + final band; top reasons with contribution bars. */
export function RiskCard({ risk, compact = false }: { risk: any; compact?: boolean }) {
  if (!risk) return <div className="text-xs text-fog">Not scored (diagnosed, outside the GI cohort, or models not trained).</div>;
  const reasons: Reason[] = risk.top_reasons ?? [];
  const max = Math.max(0.01, ...reasons.map((r) => Math.abs(r.contribution)));
  const tiers = [
    { k: "Points score", v: `${risk.t1_score}`, sub: `band ${risk.t1_band}` },
    { k: "XGBoost", v: `${fmt(100 * (risk.t2_prob ?? 0))}%`, sub: "12-month prob." },
    { k: "Sequence model", v: risk.t3_prob === null || risk.t3_prob === undefined ? "—" : `${fmt(100 * risk.t3_prob)}%`, sub: "12-month prob." },
  ];
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <BandChip band={risk.risk_band} size="md" />
        <div className="text-sm"><span className="text-2xl font-bold tabular">{fmt(100 * risk.ensemble_prob, 1)}%</span>
          <span className="text-fog text-xs ml-2">ensemble 12-month probability</span></div>
      </div>
      {!compact && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {tiers.map((t) => (
            <div key={t.k} className="rounded-lg bg-ridge2/60 border border-line/50 p-2">
              <div className="text-[10px] uppercase tracking-wider text-fog">{t.k}</div>
              <div className="text-lg font-semibold tabular">{t.v}</div>
              <div className="text-[10px] text-fog">{t.sub}</div>
            </div>
          ))}
        </div>
      )}
      <div className="panel-title mb-1.5">Why flagged</div>
      <ul className="flex flex-col gap-1.5">
        {reasons.slice(0, compact ? 3 : 5).map((r) => (
          <li key={r.feature} className="text-xs">
            <div className="flex justify-between gap-2"><span>{r.label}</span><span className="text-fog tabular">+{r.contribution.toFixed(2)}</span></div>
            <div className="h-1.5 rounded bg-ridge2 mt-0.5" aria-hidden>
              <div className="h-full rounded" style={{ width: `${(100 * Math.abs(r.contribution)) / max}%`, background: DIVERGING.pos }} />
            </div>
          </li>
        ))}
        {reasons.length === 0 && <li className="text-xs text-fog">No positive contributions above baseline.</li>}
      </ul>
      <p className="text-[10px] text-fog mt-2">Contributions are SHAP values (log-odds) from the XGBoost model. Decision support only — synthetic data.</p>
    </div>
  );
}
