import { useLayoutEffect, useRef } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/motion";

export type AnimatedNumberProps = {
  value: number | null | undefined;
  /** Formatter for every frame and the final value (default: locale string with `decimals`). */
  format?: (n: number) => string;
  decimals?: number;
  /** Seconds. */
  duration?: number;
  /** Start value for the first animation (default 0). */
  from?: number;
  /** Shown when value is null / NaN. */
  fallback?: string;
  className?: string;
};

/** Counts up to `value` (plan §A2). The DOM text is the final value at rest (screen readers and tests read it) and the
 * final value is also exposed through `aria-label`; static under prefers-reduced-motion. */
export function AnimatedNumber({ value, format, decimals = 0, duration = 0.9, from = 0, fallback = "—", className = "" }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  /** Numeric value currently on screen (survives re-renders, so value changes animate from where we are). */
  const shown = useRef<number | null>(null);
  const reduce = useReducedMotion();
  const fmt = format ?? ((n: number) => n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  const ok = value !== null && value !== undefined && Number.isFinite(value);
  const final = ok ? fmt(value as number) : fallback;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!ok || reduce) { el.textContent = final; shown.current = ok ? (value as number) : null; return; }
    const target = value as number;
    const start = shown.current ?? from;
    if (start === target) { el.textContent = final; shown.current = target; return; }
    el.textContent = fmt(start);
    shown.current = start;
    const ctl = animate(start, target, {
      duration, ease: EASE,
      onUpdate: (v) => { shown.current = v; el.textContent = fmt(v); },
      onComplete: () => { shown.current = target; el.textContent = final; },
    });
    return () => ctl.stop();
  }, [value, final, reduce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Text is written imperatively (no React text child) so per-frame updates never fight React's reconciliation.
  return <span ref={ref} className={`tabular ${className}`} aria-label={final} />;
}
