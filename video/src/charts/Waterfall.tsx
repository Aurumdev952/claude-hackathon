import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT } from "../theme";

export type WaterfallItem = { label: string; value: number };

/** Horizontal waterfall: each contribution starts where the previous one ended, so the bars visibly add up to the
 * total. Pushes up use the accent, pushes down use sky; the label sits on the left in ink, the signed value at the tip. */
export function Waterfall({ items, width, delay = 0, stagger = 14, rowHeight = 96, labelWidth = 760, total, totalLabel = "Total", decimals = 2 }: {
  items: WaterfallItem[]; width: number; delay?: number; stagger?: number; rowHeight?: number; labelWidth?: number;
  total?: number | null; totalLabel?: string; decimals?: number;
}) {
  const frame = useCurrentFrame();
  const sums: number[] = [];
  let acc = 0;
  for (const it of items) { sums.push(acc); acc += it.value; }
  const lo = Math.min(0, ...sums, acc), hi = Math.max(0, ...sums.map((s, i) => s + items[i].value), acc);
  const plot = width - labelWidth - 150;
  const sx = (v: number) => labelWidth + ((v - lo) / (hi - lo || 1)) * plot;
  const rows = items.length + (total !== undefined ? 1 : 0);
  return (
    <svg width={width} height={rows * rowHeight} style={{ overflow: "visible", fontFamily: FONT }}>
      <line x1={sx(0)} x2={sx(0)} y1={0} y2={rows * rowHeight} stroke={C.axis} strokeWidth={1.5} />
      {items.map((it, i) => {
        const p = progressAt(frame, delay + i * stagger, 26);
        const a = sums[i], b = sums[i] + it.value * p;
        const x0 = Math.min(sx(a), sx(b)), w = Math.abs(sx(b) - sx(a));
        const up = it.value >= 0;
        const yy = i * rowHeight;
        return (
          <g key={i} transform={`translate(0 ${yy})`} opacity={Math.min(1, p * 2)}>
            <text x={0} y={rowHeight / 2 + 10} fontSize={30} fontWeight={500} fill={C.ink}>{it.label}</text>
            {w > 0.5 && <rect x={x0} y={rowHeight / 2 - 20} width={Math.max(2, w)} height={40} rx={6} fill={up ? C.signal : C.sky} />}
            {i > 0 && <line x1={sx(a)} x2={sx(a)} y1={-rowHeight / 2 + 20} y2={rowHeight / 2 - 20} stroke={C.faint} strokeWidth={1.5} />}
            {p > 0.9 && (
              <text x={(up ? Math.max(sx(a), sx(b)) : Math.min(sx(a), sx(b))) + (up ? 14 : -14)} y={rowHeight / 2 + 8}
                    textAnchor={up ? "start" : "end"} fontSize={24} fontWeight={600} fill={C.ink2}>
                {up ? "+" : "−"}{fmtNum(Math.abs(it.value), decimals)}
              </text>
            )}
          </g>
        );
      })}
      {total !== undefined && total !== null && (() => {
        const p = progressAt(frame, delay + items.length * stagger + 6, 26);
        const yy = items.length * rowHeight;
        return (
          <g transform={`translate(0 ${yy})`} opacity={p}>
            <line x1={labelWidth} x2={labelWidth + plot} y1={4} y2={4} stroke={C.hairline} strokeWidth={2} />
            <text x={0} y={rowHeight / 2 + 12} fontSize={30} fontWeight={600} fill={C.ink}>{totalLabel}</text>
            <rect x={Math.min(sx(0), sx(acc))} y={rowHeight / 2 - 20} width={Math.abs(sx(acc) - sx(0)) * p} height={40} rx={6} fill={C.ink} />
            {p > 0.9 && <text x={Math.max(sx(0), sx(acc)) + 14} y={rowHeight / 2 + 8} fontSize={26} fontWeight={600} fill={C.ink}>{acc >= 0 ? "+" : "−"}{fmtNum(Math.abs(acc), decimals)}</text>}
          </g>
        );
      })()}
    </svg>
  );
}
