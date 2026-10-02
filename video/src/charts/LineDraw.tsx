import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT } from "../theme";
import { finite, linear, niceTicks } from "./scale";

export type LinePoint = { x: number; y: number | null; lo?: number | null; hi?: number | null };
export type Annotation = { x: number; y?: number; title: string; sub?: string; side?: "left" | "right" };

/** Line that draws on left to right with an optional CI band (sky wash), a context line (e.g. the fitted joinpoint trend,
 * ink at low weight), an annotation callout and an end label. Gaps (null) break the line. Gridlines are hairline and
 * recessive; the value is labelled at the end only. */
export function LineDraw({ data, width, height, delay = 0, duration = 75, color = C.sky, context, annotation, yLabel, unit = "",
  decimals = 0, xFormat = (x: number) => String(x), yMin, compact = false }: {
  data: LinePoint[]; width: number; height: number; delay?: number; duration?: number; color?: string;
  context?: { x: number; y: number | null }[]; annotation?: Annotation | null; yLabel?: string; unit?: string; decimals?: number;
  xFormat?: (x: number) => string; yMin?: number; compact?: boolean;
}) {
  const frame = useCurrentFrame();
  const m = compact ? { l: 8, r: 8, t: 8, b: 8 } : { l: 70, r: 120, t: 30, b: 50 };
  const xs = data.map((d) => d.x);
  const vals = data.flatMap((d) => [d.y, d.hi ?? null, d.lo ?? null]).concat((context ?? []).map((c) => c.y)).filter(finite);
  if (!xs.length || !vals.length) return <svg width={width} height={height} />;
  const lo = yMin ?? Math.min(0, ...vals);
  const ticks = niceTicks(lo, Math.max(...vals) * 1.05, 4);
  const x = linear([Math.min(...xs), Math.max(...xs)], [m.l, width - m.r]);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [height - m.b, m.t]);
  const p = progressAt(frame, delay, duration, (t) => t);
  const revealX = m.l + (width - m.r - m.l) * p;
  const segs: string[] = [];
  let cur = "";
  for (const d of data) {
    if (!finite(d.y)) { if (cur) segs.push(cur); cur = ""; continue; }
    cur += `${cur ? "L" : "M"}${x(d.x).toFixed(1)},${y(d.y).toFixed(1)} `;
  }
  if (cur) segs.push(cur);
  const band = data.filter((d) => finite(d.lo) && finite(d.hi));
  const bandD = band.length > 1
    ? `M${band.map((d) => `${x(d.x).toFixed(1)},${y(d.hi as number).toFixed(1)}`).join(" L")} L${[...band].reverse().map((d) => `${x(d.x).toFixed(1)},${y(d.lo as number).toFixed(1)}`).join(" L")}Z`
    : null;
  const ctxD = context?.filter((c) => finite(c.y)).map((c, i) => `${i ? "L" : "M"}${x(c.x).toFixed(1)},${y(c.y as number).toFixed(1)}`).join(" ");
  const valid = data.filter((d) => finite(d.y));
  const shown = valid.filter((d) => x(d.x) <= revealX + 0.5);
  const last = shown[shown.length - 1];
  const done = p >= 0.999;
  const id = `ld-${Math.round(width)}x${Math.round(height)}-${delay}`;
  const annP = annotation ? progressAt(frame, delay + duration * ((x(annotation.x) - m.l) / (width - m.l - m.r)), 18) : 0;
  const ay = annotation ? (finite(annotation.y) ? y(annotation.y) : (() => { const d = valid.reduce((a, b) => (Math.abs(b.x - annotation.x) < Math.abs(a.x - annotation.x) ? b : a)); return y(d.y as number); })()) : 0;

  return (
    <svg width={width} height={height} style={{ overflow: "visible", fontFamily: FONT }}>
      <defs><clipPath id={id}><rect x={0} y={-20} width={revealX} height={height + 40} /></clipPath></defs>
      {!compact && ticks.map((t) => (
        <g key={t}>
          <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
          <text x={m.l - 14} y={y(t) + 7} textAnchor="end" fontSize={20} fill={C.muted}>{fmtNum(t, t % 1 ? 1 : 0)}</text>
        </g>
      ))}
      {!compact && xLabels(data.map((d) => d.x), x, 130).map((v) => (
        <text key={v} x={x(v)} y={height - m.b + 34} textAnchor="middle" fontSize={20} fill={C.muted}>{xFormat(v)}</text>
      ))}
      {yLabel && !compact && <text x={m.l} y={m.t - 12} fontSize={20} fill={C.muted}>{yLabel}</text>}
      <g clipPath={`url(#${id})`}>
        {bandD && <path d={bandD} fill={color} fillOpacity={0.14} />}
        {ctxD && <path d={ctxD} fill="none" stroke={C.ink} strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round" />}
        {segs.map((d, i) => <path key={i} d={d} fill="none" stroke={color} strokeWidth={compact ? 3 : 4} strokeLinecap="round" strokeLinejoin="round" />)}
        {!compact && valid.map((d) => <circle key={d.x} cx={x(d.x)} cy={y(d.y as number)} r={5} fill={color} stroke={C.surface} strokeWidth={2} />)}
      </g>
      {annotation && annP > 0 && (
        <g opacity={annP}>
          <line x1={x(annotation.x)} x2={x(annotation.x)} y1={m.t} y2={height - m.b} stroke={C.ink} strokeOpacity={0.35} strokeWidth={1.5} />
          <circle cx={x(annotation.x)} cy={ay} r={9} fill={C.signal} stroke={C.surface} strokeWidth={3} />
          <g transform={`translate(${x(annotation.x) + (annotation.side === "left" ? -18 : 18)} ${m.t + 6})`}>
            <text textAnchor={annotation.side === "left" ? "end" : "start"} y={18} fontSize={26} fontWeight={600} fill={C.ink}>{annotation.title}</text>
            {annotation.sub && <text textAnchor={annotation.side === "left" ? "end" : "start"} y={50} fontSize={22} fill={C.muted}>{annotation.sub}</text>}
          </g>
        </g>
      )}
      {last && (
        <g>
          <circle cx={x(last.x)} cy={y(last.y as number)} r={compact ? 6 : 8} fill={done ? C.signal : color} stroke={C.surface} strokeWidth={3} />
          {!compact && done && (
            <text x={x(last.x) + 18} y={y(last.y as number) + 9} fontSize={28} fontWeight={600} fill={C.ink}>{fmtNum(last.y, decimals)}{unit}</text>
          )}
        </g>
      )}
    </svg>
  );
}

/** Tick labels at least `minGap` px apart; the last value always gets a label. */
function xLabels(xs: number[], x: (v: number) => number, minGap: number): number[] {
  const out: number[] = [];
  const last = xs[xs.length - 1];
  for (const v of xs) {
    if (out.length && x(v) - x(out[out.length - 1]) < minGap) continue;
    if (v !== last && x(last) - x(v) < minGap) continue;
    out.push(v);
  }
  if (!out.includes(last)) out.push(last);
  return out;
}
