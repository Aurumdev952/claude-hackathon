import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { EChart, base } from "@/components/charts/EChart";
import { date, fmt } from "@/lib/format";
import { CATEGORICAL, SERIES, alphaHex, ink, mode } from "@/lib/viz";
import { SPRING } from "@/lib/motion";

const LANES = [
  { key: "VISIT", label: "Visits" }, { key: "SYMPTOM", label: "Symptoms" }, { key: "DIAGNOSIS", label: "Diagnoses" },
  { key: "LAB", label: "Labs" }, { key: "DRUG", label: "Medicines" }, { key: "ORDER", label: "Orders" },
  { key: "ENDOSCOPY", label: "Endoscopy" },
];
const laneOf = (t: string) => (t === "PATHOLOGY" || t === "STAGING" ? "ENDOSCOPY" : t === "VITAL" ? null : t);

/** Width of an element in CSS pixels (drawn in real pixels so 10-11px labels stay readable at any card width). */
export function useWidth<T extends HTMLElement>(initial = 800) {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

/** Event-type colours: the validated categorical palette in fixed order (shared with the case replay bar). */
export function laneColors(): Record<string, string> {
  const c = CATEGORICAL[mode()];
  return { VISIT: c[0], VITAL: c[0], SYMPTOM: c[1], DIAGNOSIS: c[2], LAB: c[3], DRUG: c[4], ORDER: c[5], ENDOSCOPY: c[6], PROC: c[6] };
}

/** Swimlane timeline (SPEC §16.3 V7) - ringed events are those the models leaned on (Tier 3 IG / SHAP). */
export function Timeline({ events, height = 210 }: { events: any[]; height?: number }) {
  const [hover, setHover] = useState<any | null>(null);
  const [box, W] = useWidth<HTMLDivElement>();
  const ev = useMemo(() => events.filter((e) => laneOf(e.event_type)), [events]);
  const laneColor = laneColors();
  if (!ev.length) return <div ref={box} className="text-label text-muted py-6 text-center">No events in this window</div>;
  return <Lanes ev={ev} W={W} height={height} box={box} hover={hover} setHover={setHover} laneColor={laneColor} />;
}

function Lanes({ ev, W, height, box, hover, setHover, laneColor }: {
  ev: any[]; W: number; height: number; box: (el: HTMLDivElement | null) => void; hover: any; setHover: (h: any) => void; laneColor: Record<string, string>;
}) {
  const t0 = Date.parse(ev[0].ts), t1 = Math.max(Date.parse(ev[ev.length - 1].ts), t0 + 86400000);
  const laneH = (height - 24) / LANES.length, left = 112;
  const x = (ts: string) => left + ((Date.parse(ts) - t0) / (t1 - t0)) * (W - left - 10);
  const years: number[] = [];
  for (let y = new Date(t0).getFullYear() + 1; y <= new Date(t1).getFullYear(); y++) years.push(y);
  return (
    <div className="relative" ref={box}>
      <svg width={W} height={height} className="block" role="img" aria-label="Patient timeline">
        {LANES.map((l, i) => {
          const cy = i * laneH + laneH / 2;
          return (
            <g key={l.key}>
              <line x1={left - 4} x2={W - 4} y1={cy} y2={cy} stroke="rgb(var(--faint))" strokeOpacity={0.55} strokeDasharray="1 5" strokeLinecap="round" />
              <circle cx={4} cy={cy} r={3.5} fill={laneColor[l.key]} />
              <text x={14} y={cy + 4} fontSize={12} fill="rgb(var(--muted))">{l.label}</text>
            </g>
          );
        })}
        {years.map((y) => {
          const xx = x(`${y}-01-01T00:00:00`);
          return <g key={y}><line x1={xx} x2={xx} y1={0} y2={height - 20} stroke="rgb(var(--faint))" strokeOpacity={0.7} strokeDasharray="1 4" strokeLinecap="round" />
            <text x={xx + 4} y={height - 4} fontSize={12} fill="rgb(var(--muted))">{y}</text></g>;
        })}
        {ev.map((e, i) => {
          const lane = LANES.findIndex((l) => l.key === laneOf(e.event_type));
          const cy = lane * laneH + laneH / 2;
          const r = e.highlight ? 5.5 : e.is_abnormal ? 4.5 : 3.5;
          return (
            <g key={i} onMouseEnter={() => setHover({ ...e, px: x(e.ts), py: cy })} onMouseLeave={() => setHover(null)}>
              <circle cx={x(e.ts)} cy={cy} r={11} fill="transparent" />
              {e.highlight && <circle cx={x(e.ts)} cy={cy} r={r + 4} fill="none" stroke="rgb(var(--ink))" strokeOpacity={0.6} strokeWidth={1.2} strokeDasharray="2 2" />}
              <circle cx={x(e.ts)} cy={cy} r={r} fill={laneColor[laneOf(e.event_type)!]} stroke="rgb(var(--surface))" strokeWidth={1.5}
                      opacity={e.is_abnormal || e.highlight ? 1 : 0.75} />
            </g>
          );
        })}
      </svg>
      <AnimatePresence>
        {hover && (
          <motion.div key={`${hover.ts}-${hover.label}`} initial={{ opacity: 0, y: 4, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING}
                      className="absolute z-20 pointer-events-none rounded-tile bg-surface shadow-float dark:border dark:border-hairline px-3.5 py-2.5 text-[13px] leading-[18px] max-w-[260px]"
                      style={{ left: Math.min(hover.px, W - 270), top: hover.py, translateX: 10, translateY: "-50%" }}>
            <div className="font-semibold text-ink">{hover.label ?? hover.event_type}</div>
            <div className="text-muted">{date(hover.ts)}</div>
            {hover.facility && <div className="text-muted">{String(hover.facility).replace(" (Synthetic)", "")}</div>}
            {hover.value_num !== null && hover.value_num !== undefined && <div className="tabular text-ink mt-0.5">{fmt(hover.value_num)} {hover.unit ?? ""}</div>}
            {hover.value_text && <div className="text-muted">{hover.value_text}</div>}
            {hover.highlight && <div className="text-ink mt-1 font-medium inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full border border-dashed border-ink" aria-hidden />Weighed by the models</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MiniSeries({ title, points, unit, threshold, height = 220 }: { title: string; points: { ts: string; value: number }[]; unit: string; threshold?: number; height?: number }) {
  const k = ink();
  const c = SERIES[mode()][0];
  const opt: any = {
    ...base(), grid: { left: 40, right: 14, top: 16, bottom: 26 },
    xAxis: { ...(base().xAxis as any), type: "time", axisLabel: { color: k.muted, fontSize: 12, hideOverlap: true } },
    yAxis: { ...(base().yAxis as any), type: "value", scale: true, axisLabel: { color: k.muted, fontSize: 12 } },
    tooltip: { ...(base().tooltip as any), valueFormatter: (v: number) => `${v} ${unit}` },
    series: [{ type: "line", data: points.map((p) => [p.ts, p.value]), showSymbol: true, symbolSize: 7, smooth: 0.2, lineStyle: { width: 2, color: c },
               itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
               areaStyle: { color: alphaHex(c, 0.08) },
               markLine: threshold ? { silent: true, symbol: "none", lineStyle: { color: k.axis, type: "dashed" }, label: { color: k.muted, fontSize: 12, formatter: `Anaemia below ${threshold}` }, data: [{ yAxis: threshold }] } : undefined }],
  };
  if (!points.length) return <div className="text-label text-muted h-[120px] grid place-items-center">{title}: not measured</div>;
  return <EChart option={opt} height={height} ariaLabel={`${title} over time`} />;
}
