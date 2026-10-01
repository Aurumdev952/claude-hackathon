import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/motion";

export type RangeMarker = { value: number; label?: ReactNode; color?: string };

export type GradientRangeBarProps = {
  value: number | null | undefined;
  min?: number;
  max?: number;
  /** v2: CSS gradient for the track. v3 ignores gradients (one solid fill); a plain colour here sets the fill. */
  gradient?: string;
  /** v2 gradient stops. v3 uses the last stop as the fill colour when given. */
  stops?: string[];
  /** Higher is better: the fill stays sky (neutral) instead of turning signal near the top. */
  reverse?: boolean;
  /** Extra reference markers (e.g. national value, target): small ink ticks. */
  markers?: RangeMarker[];
  /** Tick marks at band thresholds (surface-coloured notches in the track). */
  thresholds?: number[];
  showMinMax?: boolean;
  minLabel?: ReactNode;
  maxLabel?: ReactNode;
  format?: (n: number) => string;
  /** Track height in px (default 6). */
  height?: number;
  /** Fill tone: auto (default) = signal when the value sits in the upper third of a higher-is-worse scale, else sky;
   * signal = attention; sky = neutral / good. */
  tone?: "auto" | "signal" | "sky";
  /** Accessible name of the meter. */
  label?: string;
  className?: string;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Progress / range bar (design v3, reference "2.32 SLW"): a thin grey track with one solid fill from the minimum to the
 * value, optional ink ticks for reference markers. No multicolour gradients. role="meter" with the value as text. */
export function GradientRangeBar({ value, min = 0, max = 100, gradient, stops, reverse, markers = [], thresholds = [], showMinMax = true,
  minLabel, maxLabel, format = (n) => String(Math.round(n * 10) / 10), height = 6, tone = "auto", label = "Value in range", className = "" }: GradientRangeBarProps) {
  const reduce = useReducedMotion();
  const ok = value !== null && value !== undefined && Number.isFinite(value);
  const pos = ok ? clamp01(((value as number) - min) / (max - min || 1)) : 0;
  const custom = gradient && !gradient.includes("gradient(") ? gradient : stops?.length ? stops[stops.length - 1] : null;
  // signed scales (min < 0 < max, e.g. annual percent change) fill from zero, the baseline; others from the minimum
  const origin = min < 0 && max > 0 ? clamp01((0 - min) / (max - min)) : 0;
  const attention = tone === "signal" || (tone === "auto" && !reverse && (origin > 0 ? pos > origin : pos >= 2 / 3));
  const fill = custom ?? (attention ? "rgb(var(--signal))" : "rgb(var(--sky))");
  const at = (x: number) => `${clamp01((x - min) / (max - min || 1)) * 100}%`;
  return (
    <div className={`w-full ${className}`}>
      <div className="relative" style={{ height: Math.max(height + 8, 14) }}
           role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={ok ? (value as number) : undefined}
           aria-valuetext={ok ? format(value as number) : "no value"}>
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 rounded-full bg-tile dark:bg-hairline overflow-hidden" style={{ height }}>
          {ok && (
            <motion.div className="absolute inset-y-0 rounded-full" style={{ background: fill, left: `${Math.min(origin, pos) * 100}%` }}
                        initial={reduce ? false : { width: "0%" }} animate={{ width: `${Math.max(Math.abs(pos - origin) * 100, 2)}%` }}
                        transition={{ duration: 0.8, ease: EASE, delay: reduce ? 0 : 0.1 }} />
          )}
        </div>
        {thresholds.map((t) => (
          <span key={t} aria-hidden className="absolute top-1/2 -translate-y-1/2 w-[2px] bg-surface"
                style={{ left: `calc(${at(t)} - 1px)`, height }} />
        ))}
        {markers.map((m, i) => (
          <span key={i} aria-hidden className="absolute top-1/2 -translate-y-1/2 w-[2px] rounded-full"
                style={{ left: `calc(${at(m.value)} - 1px)`, height: height + 8, background: m.color ?? "rgb(var(--ink))" }}
                title={typeof m.label === "string" ? m.label : undefined} />
        ))}
      </div>
      {showMinMax && (
        <div className="flex justify-between text-micro text-muted tabular mt-1">
          <span>{minLabel ?? format(min)}</span>
          <span>{maxLabel ?? format(max)}</span>
        </div>
      )}
    </div>
  );
}
