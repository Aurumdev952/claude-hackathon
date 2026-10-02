import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT } from "../theme";
import { finite } from "./scale";

export type FunnelStep = { label: string; n: number | null };

/** Horizontal care cascade: one bar per step (length = n relative to the first step), the share kept from the previous
 * step between rows, and the largest drop marked with the accent. Suppressed steps (null) show "<5". */
export function Funnel({ steps, width, delay = 0, stagger = 10, rowHeight = 92, labelWidth = 330 }: {
  steps: FunnelStep[]; width: number; delay?: number; stagger?: number; rowHeight?: number; labelWidth?: number;
}) {
  const frame = useCurrentFrame();
  const first = steps.find((s) => finite(s.n))?.n ?? 1;
  // labelWidth 0 = narrow layout: the step label sits above its bar
  const stacked = labelWidth === 0;
  const barMax = width - labelWidth - 200;
  const by = stacked ? rowHeight - 56 : rowHeight / 2 - 24;
  // the step with the lowest kept share (largest drop) gets the accent
  let worst = -1, worstShare = Infinity;
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    if (i && finite(s.n) && prev && finite(prev.n) && prev.n > 0) {
      const share = s.n / prev.n;
      if (share < worstShare) { worstShare = share; worst = i; }
    }
  });
  return (
    <svg width={width} height={steps.length * rowHeight} style={{ overflow: "visible", fontFamily: FONT }}>
      {steps.map((s, i) => {
        const p = progressAt(frame, delay + i * stagger, 30);
        const w = finite(s.n) ? Math.max(6, (s.n / first) * barMax) * p : 0;
        const yy = i * rowHeight;
        const prev = steps[i - 1];
        const share = i && finite(s.n) && prev && finite(prev.n) && prev.n > 0 ? (100 * s.n) / prev.n : null;
        const isWorst = i === worst;
        return (
          <g key={i} transform={`translate(0 ${yy})`} opacity={Math.min(1, p * 1.5)}>
            <text x={0} y={stacked ? by - 16 : rowHeight / 2 + 2} fontSize={26} fontWeight={500} fill={C.ink}>{s.label}</text>
            <rect x={labelWidth} y={by} width={barMax} height={48} rx={8} fill={C.tile} />
            {w > 0 && <rect x={labelWidth} y={by} width={w} height={48} rx={8} fill={isWorst ? C.signal : C.sky} />}
            <text x={labelWidth + barMax + 22} y={by + 26} fontSize={30} fontWeight={600} fill={C.ink}>{finite(s.n) ? fmtNum(s.n * p) : "<5"}</text>
            {share !== null && (
              <text x={labelWidth + barMax + 22} y={by + 56} fontSize={20} fill={isWorst ? C.signalText : C.muted}>
                {fmtNum(share)}% of previous
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
