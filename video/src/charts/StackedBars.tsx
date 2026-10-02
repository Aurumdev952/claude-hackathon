import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT } from "../theme";
import { finite } from "./scale";

export type StackRow = { label: string; values: (number | null)[] };

/** 100% stacked columns (one per year) that grow upward, staggered left to right. A 2px surface gap separates the
 * segments; the legend sits above; the last column labels its top segment share. Rows with no data show "<5". */
export function StackedBars({ rows, keys, colors, width, height, delay = 0, stagger = 4, highlightKey }: {
  rows: StackRow[]; keys: string[]; colors: string[]; width: number; height: number; delay?: number; stagger?: number; highlightKey?: number;
}) {
  const frame = useCurrentFrame();
  const m = { l: 60, r: 120, t: 70, b: 46 };
  const slot = (width - m.l - m.r) / Math.max(1, rows.length);
  const bw = Math.min(64, slot * 0.66);
  const ph = height - m.t - m.b;
  const hk = highlightKey ?? keys.length - 1;
  return (
    <svg width={width} height={height} style={{ overflow: "visible", fontFamily: FONT }}>
      <g transform={`translate(${m.l} 8)`}>
        {keys.map((k, i) => (
          <g key={k} transform={`translate(${i * 150} 0)`}>
            <rect x={0} y={4} width={22} height={22} rx={5} fill={colors[i]} />
            <text x={32} y={23} fontSize={22} fill={C.ink2}>{k}</text>
          </g>
        ))}
      </g>
      {[0, 50, 100].map((t) => (
        <g key={t}>
          <line x1={m.l} x2={width - m.r} y1={m.t + ph * (1 - t / 100)} y2={m.t + ph * (1 - t / 100)} stroke={t === 0 ? C.axis : C.grid} />
          <text x={m.l - 12} y={m.t + ph * (1 - t / 100) + 7} textAnchor="end" fontSize={20} fill={C.muted}>{t}%</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const p = progressAt(frame, delay + i * stagger, 28);
        const cx = m.l + slot * (i + 0.5);
        const tot = r.values.reduce<number>((a, v) => a + (finite(v) ? v : 0), 0);
        const label = <text x={cx} y={height - m.b + 32} textAnchor="middle" fontSize={20} fill={C.muted}>{r.label}</text>;
        if (!tot) return <g key={i}>{label}<text x={cx} y={m.t + ph - 12} textAnchor="middle" fontSize={18} fill={C.muted} opacity={p}>&lt;5</text></g>;
        let acc = 0;
        return (
          <g key={i}>
            {r.values.map((v, k) => {
              if (!finite(v) || v <= 0) return null;
              const h = (v / tot) * ph * p;
              const y0 = m.t + ph - acc - h;
              acc += h;
              return <rect key={k} x={cx - bw / 2} y={y0 + 1} width={bw} height={Math.max(0, h - 2)} rx={k === r.values.length - 1 ? 4 : 0} fill={colors[k]} />;
            })}
            {label}
            {i === rows.length - 1 && p > 0.95 && finite(r.values[hk]) && (
              <text x={cx + bw / 2 + 14} y={m.t + 24} fontSize={24} fontWeight={600} fill={C.ink}>{fmtNum((100 * (r.values[hk] as number)) / tot)}% {keys[hk]}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
