import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT } from "../theme";
import { finite, linear, niceTicks } from "./scale";

export type FanPoint = { year: number; value: number | null; lo80?: number | null; hi80?: number | null; lo95?: number | null; hi95?: number | null };

/** Observed history (sky line) then a forecast fan: 95% band (lighter wash) and 80% band (deeper wash) opening out
 * from the last observed year, the median line, and the final value labelled with its 95% interval. */
export function FanChart({ history, forecast, width, height, delay = 0, unit = "", decimals = 1 }: {
  history: FanPoint[]; forecast: FanPoint[]; width: number; height: number; delay?: number; unit?: string; decimals?: number;
}) {
  const frame = useCurrentFrame();
  const m = { l: 70, r: 190, t: 40, b: 50 };
  const all = [...history, ...forecast];
  const vals = all.flatMap((d) => [d.value, d.hi95 ?? null, d.lo95 ?? null, d.hi80 ?? null]).filter(finite);
  if (!all.length || !vals.length) return <svg width={width} height={height} />;
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals) * 1.05, 4);
  const years = all.map((d) => d.year);
  const x = linear([Math.min(...years), Math.max(...years)], [m.l, width - m.r]);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [height - m.b, m.t]);
  const hist = history.filter((d) => finite(d.value));
  const anchor = hist[hist.length - 1];
  const fc = anchor ? [{ ...anchor, lo80: anchor.value, hi80: anchor.value, lo95: anchor.value, hi95: anchor.value }, ...forecast] : forecast;
  const pH = progressAt(frame, delay, 50, (t) => t);
  const pF = progressAt(frame, delay + 50, 60);
  const xSplit = anchor ? x(anchor.year) : m.l;
  const histClip = m.l + (xSplit - m.l) * pH;
  const fcClip = xSplit + (width - m.r - xSplit) * pF;
  const area = (lo: keyof FanPoint, hi: keyof FanPoint) => {
    const pts = fc.filter((d) => finite(d[lo] as number) && finite(d[hi] as number));
    if (pts.length < 2) return null;
    return `M${pts.map((d) => `${x(d.year)},${y(d[hi] as number)}`).join(" L")} L${[...pts].reverse().map((d) => `${x(d.year)},${y(d[lo] as number)}`).join(" L")}Z`;
  };
  const line = (pts: FanPoint[]) => pts.filter((d) => finite(d.value)).map((d, i) => `${i ? "L" : "M"}${x(d.year)},${y(d.value as number)}`).join(" ");
  const end = forecast[forecast.length - 1];
  const id = `fan-${delay}`;
  return (
    <svg width={width} height={height} style={{ overflow: "visible", fontFamily: FONT }}>
      <defs>
        <clipPath id={`${id}-h`}><rect x={0} y={-20} width={histClip} height={height + 40} /></clipPath>
        <clipPath id={`${id}-f`}><rect x={xSplit} y={-20} width={Math.max(0, fcClip - xSplit)} height={height + 40} /></clipPath>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={C.grid} />
          <text x={m.l - 14} y={y(t) + 7} textAnchor="end" fontSize={20} fill={C.muted}>{fmtNum(t, t % 1 ? 1 : 0)}</text>
        </g>
      ))}
      {years.filter((yy, i, a) => a.indexOf(yy) === i && (yy % 2 === 1 || yy === Math.max(...years))).map((yy) => (
        <text key={yy} x={x(yy)} y={height - m.b + 34} textAnchor="middle" fontSize={20} fill={C.muted}>{yy}</text>
      ))}
      {anchor && (
        <g opacity={pF}>
          <line x1={xSplit} x2={xSplit} y1={m.t} y2={height - m.b} stroke={C.ink} strokeOpacity={0.3} />
          <text x={xSplit + 14} y={m.t + 4} fontSize={22} fill={C.muted}>Forecast</text>
        </g>
      )}
      <g clipPath={`url(#${id}-f)`}>
        {area("lo95", "hi95") && <path d={area("lo95", "hi95") as string} fill={C.sky} fillOpacity={0.14} />}
        {area("lo80", "hi80") && <path d={area("lo80", "hi80") as string} fill={C.sky} fillOpacity={0.28} />}
        <path d={line(fc)} fill="none" stroke={C.skyDeep} strokeWidth={3} strokeLinecap="round" />
      </g>
      <g clipPath={`url(#${id}-h)`}>
        <path d={line(history)} fill="none" stroke={C.sky} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {end && finite(end.value) && pF > 0.98 && (
        <g>
          <circle cx={x(end.year)} cy={y(end.value)} r={8} fill={C.signal} stroke={C.surface} strokeWidth={3} />
          <text x={x(end.year) + 18} y={y(end.value) - 4} fontSize={30} fontWeight={600} fill={C.ink}>{fmtNum(end.value, decimals)}{unit}</text>
          {finite(end.lo95) && finite(end.hi95) && (
            <text x={x(end.year) + 18} y={y(end.value) + 26} fontSize={20} fill={C.muted}>95% {fmtNum(end.lo95, decimals)}–{fmtNum(end.hi95, decimals)}</text>
          )}
        </g>
      )}
    </svg>
  );
}
