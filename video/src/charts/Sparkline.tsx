import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { C } from "../theme";
import { finite, linear } from "./scale";

/** Small trend line: de-emphasis hue for the history, the accent dot on the latest value. Draws on from the left. */
export function Sparkline({ values, width, height, delay = 0, duration = 40, color = C.sky, accent = C.signal }: {
  values: (number | null)[]; width: number; height: number; delay?: number; duration?: number; color?: string; accent?: string;
}) {
  const frame = useCurrentFrame();
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => finite(p.v));
  if (pts.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  const pad = 6;
  const x = linear([0, values.length - 1], [pad, width - pad]);
  const y = linear([lo, hi === lo ? lo + 1 : hi], [height - pad, pad]);
  const p = progressAt(frame, delay, duration);
  const d = pts.map((q, k) => `${k ? "L" : "M"}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const clipW = pad + (width - 2 * pad) * p;
  const id = `spk-${Math.round(width)}-${Math.round(height)}-${delay}`;
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <defs><clipPath id={id}><rect x={0} y={-10} width={clipW} height={height + 20} /></clipPath></defs>
      <path d={d} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" clipPath={`url(#${id})`} />
      {p > 0.98 && <circle cx={x(last.i)} cy={y(last.v)} r={5} fill={accent} stroke={C.surface} strokeWidth={2} />}
    </svg>
  );
}
