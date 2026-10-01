import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarClock } from "lucide-react";
import { useThemeMode } from "@/components/charts/EChart";
import { ink, SERIES, STATUS } from "@/lib/viz";

export type KpiPoint = { year: number; value: number | null; flag?: "low" | "partial" | null };
export type KpiDef = {
  id: string; label: string; value: string; unit?: string; sub?: string;
  delta: { text: string; dir: -1 | 0 | 1; tone: "good" | "bad" | "neutral"; note?: string } | null;
  spark: KpiPoint[]; partial?: boolean; scope?: string; missing?: string;
  format: (v: number | null) => string;
};

/** KPI stat tiles (dataviz stat-tile contract): label · value · delta vs a named period · 12-point sparkline (muted line, current in accent). */
export function KpiStrip({ items }: { items: KpiDef[] }) {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(300px,1fr))]" role="list" aria-label="Headline indicators">
      {items.map((k) => <Tile key={k.id} k={k} />)}
    </div>
  );
}

function Tile({ k }: { k: KpiDef }) {
  const tone = k.delta?.tone === "good" ? STATUS.good : k.delta?.tone === "bad" ? STATUS.serious : undefined;
  const Icon = !k.delta ? ArrowRight : k.delta.dir > 0 ? ArrowUpRight : k.delta.dir < 0 ? ArrowDownRight : ArrowRight;
  return (
    <article role="listitem" className="panel px-3.5 py-3 grid grid-cols-[minmax(0,1fr)_118px] gap-x-3 min-w-0 animate-rise" aria-label={`${k.label}: ${k.value}${k.unit ? " " + k.unit : ""}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[11.5px] leading-tight text-fog font-medium truncate">{k.label}</h3>
          {k.partial && <span className="chip bg-sorghum/15 text-sorghum !px-1.5 !py-0 !text-[10px] shrink-0" title="Current year is year-to-date (annualised where noted)"><CalendarClock size={10} aria-hidden />YTD</span>}
        </div>
        <div className="flex items-baseline gap-1 mt-1">
          <span className="text-[28px] font-bold leading-none tracking-tight">{k.value}</span>
          {k.unit && <span className="text-xs text-fog">{k.unit}</span>}
        </div>
        <div className="text-[11px] text-fog tabular mt-1.5 truncate" title={k.missing ?? k.sub}>{k.missing ?? k.sub ?? ""}</div>
        {k.scope && <div className="text-[10px] text-fog/80 truncate" title={k.scope}>{k.scope}</div>}
      </div>
      <div className="flex flex-col justify-between min-w-0">
        <KpiSpark pts={k.spark} format={k.format} label={k.label} height={34} />
        <div className="text-[11px] mt-1.5 flex items-center gap-1 tabular justify-end whitespace-nowrap" style={{ color: tone }}>
          {k.delta ? (<><Icon size={13} aria-hidden className={tone ? "" : "text-fog"} /><span className={tone ? "font-semibold" : "text-fog"}>{k.delta.text}</span></>) : <span className="text-fog">no comparison</span>}
        </div>
        {k.delta?.note && <div className="text-[10px] text-fog text-right">{k.delta.note}</div>}
      </div>
    </article>
  );
}

/** Sparkline: muted history, dashed through low-coverage years, hollow end for a partial year, accent on the current year. */
export function KpiSpark({ pts, format, label, height = 30 }: { pts: KpiPoint[]; format: (v: number | null) => string; label: string; height?: number }) {
  const m = useThemeMode();
  const k = ink(), accent = SERIES[m][0];
  const fin = pts.filter((p) => p.value !== null && Number.isFinite(p.value));
  if (fin.length < 2) return <div style={{ height }} />;
  const vals = fin.map((p) => p.value as number);
  const min = Math.min(...vals), max = Math.max(...vals), W = 100, pad = 3;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => height - pad - ((v - min) / (max - min || 1)) * (height - 2 * pad);
  const segs: { d: string; dashed: boolean }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.value === null || b.value === null) continue;
    segs.push({ d: `M${x(i - 1)},${y(a.value)}L${x(i)},${y(b.value)}`, dashed: !!a.flag || !!b.flag });
  }
  const lastI = pts.length - 1, last = pts[lastI];
  return (
    <div className="relative mt-1" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden>
        {segs.map((s, i) => <path key={i} d={s.d} fill="none" stroke={k.muted} strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeDasharray={s.dashed ? "3 3" : undefined} strokeLinecap="round" />)}
      </svg>
      {/* HTML dots keep their shape under the stretched SVG; each point has a native tooltip */}
      {pts.map((p, i) => p.value === null ? null : (
        <span key={p.year} title={`${p.year}: ${format(p.value)}${p.flag === "low" ? " (low EMR coverage)" : p.flag === "partial" ? " (year to date)" : ""}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${(x(i) / W) * 100}%`, top: y(p.value), width: i === lastI ? 7 : 10, height: i === lastI ? 7 : 10,
                       background: i === lastI ? (last.flag === "partial" ? k.surface : accent) : "transparent", boxShadow: i === lastI ? `0 0 0 1.6px ${accent}` : undefined }} />
      ))}
      <span className="sr-only">{label} trend: {pts.map((p) => `${p.year} ${format(p.value)}`).join(", ")}</span>
    </div>
  );
}
