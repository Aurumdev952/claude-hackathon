import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";

/** A number that counts from 0 (or `from`) to `value` between `delay` and `delay + duration` frames. Null renders "–"
 * (or `nullLabel`, e.g. "<5" for suppressed cells). Proportional figures (no tabular-nums) for standalone values. */
export function CountUp({ value, from = 0, delay = 0, duration = 40, decimals = 0, prefix = "", suffix = "", nullLabel = "–", style }: {
  value: number | null | undefined; from?: number; delay?: number; duration?: number; decimals?: number; prefix?: string;
  suffix?: string; nullLabel?: string; style?: React.CSSProperties;
}) {
  const frame = useCurrentFrame();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span style={style}>{nullLabel}</span>;
  const p = progressAt(frame, delay, duration);
  const v = from + (value - from) * p;
  return <span style={style}>{prefix}{fmtNum(v, decimals)}{suffix}</span>;
}
