import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { BAND_STATUS, scoreStatus, type StatusKey } from "@/lib/viz";
import { EASE } from "@/lib/motion";
import { StatusChip, type StatusKind } from "./StatusChip";

export type RiskScoreBarProps = {
  /** Score on the 0..max scale (default probability 0..1). */
  score: number | null | undefined;
  max?: number;
  /** Risk band label (LOW / MEDIUM / HIGH or free text). Drives the colour when given. */
  band?: string | null;
  /** Band thresholds on the same scale as `score`, ascending (e.g. [0.02, 0.1]): drawn as notches in the track. */
  thresholds?: number[];
  label?: ReactNode;
  format?: (n: number) => string;
  /** One-line list-row variant (no header text). */
  compact?: boolean;
  className?: string;
};

/** Fill per status: HIGH solid signal, MEDIUM lighter signal, LOW sky (neutral). Never colour alone: the band text is in
 * the header (or the row's chip) and in aria-valuetext. */
const FILL: Record<StatusKey, string> = { good: "bg-sky", warning: "bg-signal/55", serious: "bg-signal/80", critical: "bg-signal" };
const KIND: Record<StatusKey, StatusKind> = { good: "good", warning: "warning", serious: "serious", critical: "critical" };

/** Risk score (design v3): header "Risk score · [High] 35.4%" + a thin 6px grey track with one solid fill. */
export function RiskScoreBar({ score, max = 1, band, thresholds, label = "Risk score", format = (n) => `${(n * 100).toFixed(1)}%`, compact, className = "" }: RiskScoreBarProps) {
  const reduce = useReducedMotion();
  const ok = score !== null && score !== undefined && Number.isFinite(score);
  const t = ok ? Math.max(0, Math.min(1, (score as number) / max)) : 0;
  const status: StatusKey = band && BAND_STATUS[band.toUpperCase()] ? BAND_STATUS[band.toUpperCase()] : scoreStatus(t);
  const bandText = band ? band.charAt(0).toUpperCase() + band.slice(1).toLowerCase() : status === "good" ? "Low" : status === "warning" ? "Medium" : "High";
  const cuts = (thresholds ?? []).map((x) => Math.max(0, Math.min(1, x / max))).filter((x) => x > 0 && x < 1);
  const valueText = ok ? format(score as number) : "—";
  return (
    <div className={`w-full ${className}`}>
      {!compact && (
        <div className="flex items-center justify-between gap-3 mb-2">
          <span className="text-label text-muted">{label}</span>
          <span className="inline-flex items-center gap-2 text-label">
            <StatusChip status={KIND[status]} label={bandText} />
            <span className="text-ink font-semibold tabular">{valueText}</span>
          </span>
        </div>
      )}
      <div className="relative h-1.5 rounded-full bg-tile dark:bg-hairline overflow-hidden" role="meter" aria-label={typeof label === "string" ? label : "Risk score"}
           aria-valuemin={0} aria-valuemax={max} aria-valuenow={ok ? (score as number) : undefined} aria-valuetext={`${bandText}, ${valueText}`}>
        <motion.div className={`absolute inset-y-0 left-0 rounded-full ${FILL[status]}`}
                    initial={reduce ? false : { width: "0%" }} animate={{ width: `${ok ? Math.max(t * 100, 2) : 0}%` }}
                    transition={{ duration: 0.8, ease: EASE, delay: reduce ? 0 : 0.1 }} />
        {cuts.map((c) => <span key={c} aria-hidden className="absolute inset-y-0 w-[2px] bg-surface" style={{ left: `calc(${c * 100}% - 1px)` }} />)}
      </div>
    </div>
  );
}
