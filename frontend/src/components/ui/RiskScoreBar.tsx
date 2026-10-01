import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { BAND_STATUS, scoreStatus, type StatusKey } from "@/lib/viz";
import { EASE } from "@/lib/motion";
import { StatusGlyph, type StatusKind } from "./StatusChip";

export type RiskScoreBarProps = {
  /** Score on the 0..max scale (default probability 0..1). */
  score: number | null | undefined;
  max?: number;
  /** Risk band label (LOW / MEDIUM / HIGH or free text). Drives the colour when given. */
  band?: string | null;
  /** Band thresholds on the same scale as `score`, ascending (e.g. [0.02, 0.1]). Draws segmented bands. */
  thresholds?: number[];
  label?: ReactNode;
  format?: (n: number) => string;
  /** One-line list-row variant (no header text, thin bar). */
  compact?: boolean;
  className?: string;
};

const FILL: Record<StatusKey, string> = { good: "bg-success", warning: "bg-warning", serious: "bg-serious", critical: "bg-danger" };
const TEXT: Record<StatusKey, string> = { good: "text-tone-success", warning: "text-tone-warning", serious: "text-tone-serious", critical: "text-tone-danger" };
const KIND: Record<StatusKey, StatusKind> = { good: "good", warning: "warning", serious: "serious", critical: "critical" };

/** "Risk score … ▲ High · 35.4%" header + segmented bar (plan §A2, reference top-right of the ClyHealth screen). */
export function RiskScoreBar({ score, max = 1, band, thresholds, label = "Risk score", format = (n) => `${(n * 100).toFixed(1)}%`, compact, className = "" }: RiskScoreBarProps) {
  const reduce = useReducedMotion();
  const ok = score !== null && score !== undefined && Number.isFinite(score);
  const t = ok ? Math.max(0, Math.min(1, (score as number) / max)) : 0;
  const status: StatusKey = band && BAND_STATUS[band.toUpperCase()] ? BAND_STATUS[band.toUpperCase()] : scoreStatus(t);
  const bandText = band ? band.charAt(0).toUpperCase() + band.slice(1).toLowerCase() : status === "good" ? "Low" : status === "warning" ? "Medium" : "High";
  const cuts = (thresholds ?? []).map((x) => Math.max(0, Math.min(1, x / max))).filter((x) => x > 0 && x < 1);
  const edges = [0, ...cuts, 1];
  const valueText = ok ? format(score as number) : "—";
  return (
    <div className={`w-full ${className}`}>
      {!compact && (
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-label text-fg-muted">{label}</span>
          <span className="inline-flex items-center gap-1.5 text-label">
            <StatusGlyph status={KIND[status]} />
            <span className={`font-semibold ${TEXT[status]}`}>{bandText}</span>
            <span className="text-fg-muted tabular">{valueText}</span>
          </span>
        </div>
      )}
      <div className={`relative flex gap-[3px] ${compact ? "h-1.5" : "h-2"}`} role="meter" aria-label={typeof label === "string" ? label : "Risk score"}
           aria-valuemin={0} aria-valuemax={max} aria-valuenow={ok ? (score as number) : undefined} aria-valuetext={`${bandText}, ${valueText}`}>
        {edges.slice(0, -1).map((a, i) => {
          const b = edges[i + 1];
          const fill = Math.max(0, Math.min(1, (t - a) / (b - a || 1)));
          return (
            <div key={i} className="relative h-full rounded-full bg-fg/[0.07] overflow-hidden" style={{ flex: `${b - a} 1 0` }}>
              <motion.div className={`absolute inset-y-0 left-0 rounded-full ${FILL[status]}`}
                          initial={reduce ? false : { width: "0%" }} animate={{ width: `${fill * 100}%` }}
                          transition={{ duration: 0.8, ease: EASE, delay: reduce ? 0 : 0.1 + i * 0.12 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
