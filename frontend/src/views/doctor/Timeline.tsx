import { useMemo, useState } from "react";
import { EChart, base } from "@/components/charts/EChart";
import { date, fmt } from "@/lib/format";
import { SERIES, ink, mode } from "@/lib/viz";

const LANES = [
  { key: "VISIT", label: "Visits" }, { key: "SYMPTOM", label: "Symptoms" }, { key: "DIAGNOSIS", label: "Diagnoses" },
  { key: "LAB", label: "Labs" }, { key: "DRUG", label: "Medicines" }, { key: "ORDER", label: "Orders" },
  { key: "ENDOSCOPY", label: "Endoscopy / path" },
];
const laneOf = (t: string) => (t === "PATHOLOGY" || t === "STAGING" ? "ENDOSCOPY" : t === "VITAL" ? null : t);

/** Swimlane timeline (SPEC §16.3 V7) - highlighted events are those the models leaned on (Tier 3 IG / SHAP). */
export function Timeline({ events, height = 220 }: { events: any[]; height?: number }) {
  const [hover, setHover] = useState<any | null>(null);
  const ev = useMemo(() => events.filter((e) => laneOf(e.event_type)), [events]);
  if (!ev.length) return <div className="text-xs text-fog">No events in this window.</div>;
  const t0 = Date.parse(ev[0].ts), t1 = Math.max(Date.parse(ev[ev.length - 1].ts), t0 + 86400000);
  const W = 1000, laneH = (height - 22) / LANES.length, left = 112;
  const x = (ts: string) => left + ((Date.parse(ts) - t0) / (t1 - t0)) * (W - left - 10);
  const years: number[] = [];
  for (let y = new Date(t0).getFullYear() + 1; y <= new Date(t1).getFullYear(); y++) years.push(y);
  const c = SERIES[mode()];
  const laneColor: Record<string, string> = { VISIT: c[0], SYMPTOM: c[1], DIAGNOSIS: c[2], LAB: c[3], DRUG: c[4], ORDER: c[6], ENDOSCOPY: c[7] };
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height }} role="img" aria-label="Patient timeline">
        {LANES.map((l, i) => (
          <g key={l.key}>
            <line x1={left} x2={W - 10} y1={i * laneH + laneH / 2} y2={i * laneH + laneH / 2} stroke="rgb(var(--line))" strokeOpacity={0.35} />
            <text x={0} y={i * laneH + laneH / 2 + 4} fontSize={11} fill="rgb(var(--fog))">{l.label}</text>
          </g>
        ))}
        {years.map((y) => {
          const xx = x(`${y}-01-01T00:00:00`);
          return <g key={y}><line x1={xx} x2={xx} y1={0} y2={height - 18} stroke="rgb(var(--line))" strokeOpacity={0.5} strokeDasharray="2 4" />
            <text x={xx + 3} y={height - 4} fontSize={10} fill="rgb(var(--fog))">{y}</text></g>;
        })}
        {ev.map((e, i) => {
          const lane = LANES.findIndex((l) => l.key === laneOf(e.event_type));
          const cy = lane * laneH + laneH / 2;
          const r = e.highlight ? 7 : e.is_abnormal ? 5 : 4;
          return (
            <g key={i} onMouseEnter={() => setHover({ ...e, px: x(e.ts) / W, py: cy / height })} onMouseLeave={() => setHover(null)}>
              <circle cx={x(e.ts)} cy={cy} r={12} fill="transparent" />
              {e.highlight && <circle cx={x(e.ts)} cy={cy} r={r + 4} fill="none" stroke="rgb(var(--mist))" strokeWidth={1.5} strokeDasharray="2 2" />}
              <circle cx={x(e.ts)} cy={cy} r={r} fill={laneColor[laneOf(e.event_type)!]} stroke="rgb(var(--ridge))" strokeWidth={2}
                      opacity={e.is_abnormal || e.highlight ? 1 : 0.75} />
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="absolute z-20 panel bg-ridge px-3 py-2 text-xs pointer-events-none" style={{ left: `${Math.min(hover.px * 100, 75)}%`, top: `${hover.py * 100}%`, transform: "translate(8px, -50%)" }}>
          <div className="font-semibold">{hover.label ?? hover.event_type}</div>
          <div className="text-fog">{date(hover.ts)}{hover.facility ? ` · ${String(hover.facility).replace(" (Synthetic)", "")}` : ""}</div>
          {hover.value_num !== null && hover.value_num !== undefined && <div>{fmt(hover.value_num)} {hover.unit ?? ""}</div>}
          {hover.value_text && <div className="text-fog">{hover.value_text}</div>}
          {hover.highlight && <div className="text-sorghum mt-1">Model attention</div>}
        </div>
      )}
    </div>
  );
}

export function MiniSeries({ title, points, unit, threshold }: { title: string; points: { ts: string; value: number }[]; unit: string; threshold?: number }) {
  const k = ink();
  const c = SERIES[mode()][0];
  const opt: any = {
    ...base(), grid: { left: 36, right: 10, top: 22, bottom: 22 },
    title: { text: title, textStyle: { fontSize: 11, color: k.secondary, fontWeight: 600 }, left: 0, top: 0 },
    xAxis: { ...(base().xAxis as any), type: "time", axisLabel: { color: k.muted, fontSize: 10, hideOverlap: true } },
    yAxis: { ...(base().yAxis as any), type: "value", scale: true, axisLabel: { color: k.muted, fontSize: 10 } },
    tooltip: { ...(base().tooltip as any), valueFormatter: (v: number) => `${v} ${unit}` },
    series: [{ type: "line", data: points.map((p) => [p.ts, p.value]), showSymbol: true, symbolSize: 6, lineStyle: { width: 2, color: c },
               itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
               markLine: threshold ? { silent: true, symbol: "none", lineStyle: { color: k.axis, type: "dashed" }, label: { color: k.muted, fontSize: 10, formatter: `anaemia < ${threshold}` }, data: [{ yAxis: threshold }] } : undefined }],
  };
  if (!points.length) return <div className="text-xs text-fog h-[120px] flex items-center">{title}: not measured</div>;
  return <EChart option={opt} height={130} ariaLabel={`${title} over time`} />;
}
