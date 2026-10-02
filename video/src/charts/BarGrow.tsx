import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT } from "../theme";
import { finite, linear, niceMax, niceTicks } from "./scale";

export type Bar = { label: string; value: number | null; highlight?: boolean; nullLabel?: string };

/** Columns (vertical) that grow from one baseline, staggered. <= 24px-ish thick at small counts (scaled for video),
 * 4px rounded data end, square at the baseline, value on the cap. Null bars show a muted label ("<5"). */
export function BarGrow({ data, width, height, delay = 0, stagger = 4, duration = 30, color = C.sky, unit = "", decimals = 0, maxBar = 56 }: {
  data: Bar[]; width: number; height: number; delay?: number; stagger?: number; duration?: number; color?: string; unit?: string;
  decimals?: number; maxBar?: number;
}) {
  const frame = useCurrentFrame();
  const m = { l: 60, r: 10, t: 44, b: 46 };
  const max = niceMax(data.map((d) => d.value));
  const y = linear([0, max], [height - m.b, m.t]);
  const slot = (width - m.l - m.r) / Math.max(1, data.length);
  const bw = Math.min(maxBar, slot * 0.62);
  const ticks = niceTicks(0, max, 4);
  return (
    <svg width={width} height={height} style={{ overflow: "visible", fontFamily: FONT }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
          <text x={m.l - 12} y={y(t) + 7} textAnchor="end" fontSize={20} fill={C.muted}>{fmtNum(t, t % 1 ? 1 : 0)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const p = progressAt(frame, delay + i * stagger, duration);
        const cx = m.l + slot * (i + 0.5);
        const showLabel = data.length <= 14 || i % 2 === 0 || i === data.length - 1;
        if (!finite(d.value)) {
          return (
            <g key={i} opacity={p}>
              <line x1={cx - bw / 2} x2={cx + bw / 2} y1={y(0) - 1} y2={y(0) - 1} stroke={C.faint} strokeWidth={3} />
              <text x={cx} y={y(0) - 12} textAnchor="middle" fontSize={18} fill={C.muted}>{d.nullLabel ?? "<5"}</text>
              {showLabel && <text x={cx} y={height - m.b + 32} textAnchor="middle" fontSize={20} fill={C.muted}>{d.label}</text>}
            </g>
          );
        }
        const h = (y(0) - y(d.value)) * p;
        const r = Math.min(6, bw / 2, h);
        const x0 = cx - bw / 2, top = y(0) - h;
        const path = `M${x0},${y(0)} L${x0},${top + r} Q${x0},${top} ${x0 + r},${top} L${x0 + bw - r},${top} Q${x0 + bw},${top} ${x0 + bw},${top + r} L${x0 + bw},${y(0)} Z`;
        return (
          <g key={i}>
            {h > 0 && <path d={path} fill={d.highlight ? C.signal : color} />}
            {(d.highlight || i === data.length - 1) && p > 0.95 && (
              <text x={cx} y={top - 12} textAnchor="middle" fontSize={22} fontWeight={600} fill={C.ink}>{fmtNum(d.value, decimals)}{unit}</text>
            )}
            {showLabel && <text x={cx} y={height - m.b + 32} textAnchor="middle" fontSize={20} fill={C.muted}>{d.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}
