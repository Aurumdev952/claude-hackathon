import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { RANGE_GRADIENT, rangeGradient } from "@/lib/viz";
import { EASE, SPRING_SOFT } from "@/lib/motion";

export type RangeMarker = { value: number; label?: ReactNode; color?: string };

export type GradientRangeBarProps = {
  value: number | null | undefined;
  min?: number;
  max?: number;
  /** CSS gradient or a list of stops (default green → amber → red). */
  gradient?: string;
  stops?: string[];
  /** Flip the default gradient (when higher is better). */
  reverse?: boolean;
  /** Extra reference markers (e.g. national value, target). */
  markers?: RangeMarker[];
  /** Tick marks at band thresholds. */
  thresholds?: number[];
  showMinMax?: boolean;
  minLabel?: ReactNode;
  maxLabel?: ReactNode;
  format?: (n: number) => string;
  /** Track height in px. */
  height?: number;
  /** Accessible name of the meter. */
  label?: string;
  className?: string;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Gradient range bar with an animated value marker and min/max labels (plan §A2, reference "HbA1c 5.2 %" cards). */
export function GradientRangeBar({ value, min = 0, max = 100, gradient, stops, reverse, markers = [], thresholds = [], showMinMax = true,
  minLabel, maxLabel, format = (n) => String(Math.round(n * 10) / 10), height = 8, label = "Value in range", className = "" }: GradientRangeBarProps) {
  const reduce = useReducedMotion();
  const ok = value !== null && value !== undefined && Number.isFinite(value);
  const pos = ok ? clamp01(((value as number) - min) / (max - min || 1)) : null;
  const bg = gradient ?? (stops || reverse ? rangeGradient(stops, reverse) : RANGE_GRADIENT);
  return (
    <div className={`w-full ${className}`}>
      <div className="relative" style={{ height: Math.max(height + 10, 16) }}
           role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={ok ? (value as number) : undefined}
           aria-valuetext={ok ? format(value as number) : "no value"}>
        <motion.div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 rounded-full origin-left"
                    style={{ height, background: bg }}
                    initial={reduce ? false : { scaleX: 0, opacity: 0.4 }} animate={{ scaleX: 1, opacity: 1 }} transition={{ duration: 0.7, ease: EASE }} />
        {thresholds.map((t) => (
          <span key={t} aria-hidden className="absolute top-1/2 -translate-y-1/2 w-[2px] rounded bg-surface/90"
                style={{ left: `calc(${clamp01((t - min) / (max - min || 1)) * 100}% - 1px)`, height: height + 2 }} />
        ))}
        {markers.map((m, i) => (
          <span key={i} aria-hidden className="absolute top-1/2 -translate-y-1/2 w-[2px] rounded-full opacity-80"
                style={{ left: `calc(${clamp01((m.value - min) / (max - min || 1)) * 100}% - 1px)`, height: height + 8, background: m.color ?? "rgb(var(--fg-muted))" }}
                title={typeof m.label === "string" ? m.label : undefined} />
        ))}
        {pos !== null && (
          <motion.span aria-hidden className="absolute top-1/2 w-[4px] rounded-full bg-fg ring-2 ring-surface shadow-tile"
                       style={{ height: height + 10, translateY: "-50%", marginLeft: -2 }}
                       initial={reduce ? false : { left: "0%", opacity: 0 }} animate={{ left: `${pos * 100}%`, opacity: 1 }}
                       transition={{ ...SPRING_SOFT, delay: reduce ? 0 : 0.15 }} />
        )}
      </div>
      {showMinMax && (
        <div className="flex justify-between text-micro text-fg-muted tabular mt-0.5">
          <span>{minLabel ?? format(min)}</span>
          <span>{maxLabel ?? format(max)}</span>
        </div>
      )}
    </div>
  );
}
