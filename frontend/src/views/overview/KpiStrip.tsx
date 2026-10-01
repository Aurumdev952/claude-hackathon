import type { ReactNode } from "react";
import { DotMatrix } from "@/components/charts/DotMatrix";
import { useThemeMode } from "@/components/charts/EChart";
import { AnimatedNumber, Card, DataTable, DeltaChip, DetailModal, GradientRangeBar, StatTile, useDetailModal } from "@/components/ui";
import { ink, SERIES } from "@/lib/viz";

export type KpiPoint = { year: number; value: number | null; flag?: "low" | "partial" | null };
export type KpiDef = {
  id: string; label: string; value: string; unit?: string; sub?: string;
  delta: { text: string; dir: -1 | 0 | 1; tone: "good" | "bad" | "neutral"; note?: string } | null;
  spark: KpiPoint[]; partial?: boolean; scope?: string; missing?: string;
  format: (v: number | null) => string;
  /** Short name for the hero strip (defaults to label), and a shorter one for phones. */
  short?: string;
  mini?: string;
};

const notesOf = (k: KpiDef) => [k.delta?.note && `Change ${k.delta.note}.`, k.partial && "The current year is year to date (annualised where noted).", k.scope].filter(Boolean).join(" ");

/** Detail modal body for one indicator: the annual series as a line (dashed through low-coverage years, hollow for the
 * year to date), the reading notes and the table. */
export function KpiDetail({ k }: { k: KpiDef }) {
  const notes = notesOf(k);
  return (
    <div className="flex flex-col gap-5">
      {(k.missing || k.sub || notes) && (
        <div className="text-[14px] leading-[21px] text-ink/90 max-w-[640px] flex flex-col gap-1">
          {(k.missing ?? k.sub) && <p>{k.missing ?? k.sub}</p>}
          {notes && <p className="text-muted">{notes}</p>}
        </div>
      )}
      {k.spark.length > 1 && (
        <div className="rounded-tile bg-tile px-5 pt-6 pb-3">
          <KpiSpark pts={k.spark} format={k.format} label={k.label} height={150} />
          <div className="flex justify-between text-micro text-muted tabular mt-3">
            <span>{k.spark[0]?.year}</span><span>{k.spark[k.spark.length - 1]?.year}</span>
          </div>
        </div>
      )}
      {k.spark.length > 1 && (
        <>
          {(k.spark.some((p) => p.flag === "low") || k.spark.some((p) => p.flag === "partial")) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-micro text-muted">
              {k.spark.some((p) => p.flag === "low") && <span>Dashed: low EMR coverage</span>}
              {k.spark.some((p) => p.flag === "partial") && <span>Hollow dot: year to date</span>}
            </div>
          )}
          <div className="overflow-auto max-h-[40vh]">
            <DataTable rows={[...k.spark].reverse()} columns={[
              { key: "year", label: "Year" }, { key: "value", label: k.label, num: true, fmt: (v) => k.format(v) },
              { key: "flag", label: "Flag", fmt: (v) => (v === "partial" ? "year to date" : v === "low" ? "low EMR coverage" : "") },
            ]} />
          </div>
        </>
      )}
    </div>
  );
}

/** One number in the hero's white stats strip (reference "63.71 km / 298 min / 9277 kCal"): icon circle, number with
 * a small muted unit, muted label; opens the indicator's detail modal. Rendered as a listitem of "Headline indicators". */
export function HeroStat({ k, icon, attention = false }: { k: KpiDef; icon: ReactNode; attention?: boolean }) {
  const d = useDetailModal();
  return (
    <div role="listitem" aria-label={`${k.label}: ${k.value}${k.unit ? " " + k.unit : ""}`} className="min-w-0 flex-1">
      <button type="button" onClick={d.open} aria-label={`${k.label}: details`}
              className="w-full flex items-center gap-3 rounded-tile px-2.5 py-2 text-left hover:bg-tile transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
        <span className={`hidden sm:grid w-10 h-10 shrink-0 rounded-full place-items-center [&_svg]:w-[17px] [&_svg]:h-[17px] ${attention ? "bg-signal-soft text-signal-text" : "bg-tile text-ink"}`} aria-hidden>{icon}</span>
        <span className="min-w-0">
          <span className="flex items-baseline gap-1 whitespace-nowrap">
            <span className="text-[22px] max-sm:text-[19px] leading-7 font-medium tracking-[-0.01em] text-ink tabular">{k.value}</span>
            {k.unit && <span className="text-micro text-muted">{k.unit}</span>}
          </span>
          <span className="block text-micro text-muted truncate"><span className={k.mini ? "max-sm:hidden" : ""}>{k.short ?? k.label}</span>{k.mini && <span className="sm:hidden">{k.mini}</span>}</span>
        </span>
      </button>
      <DetailModal {...d.modalProps} title={k.label} subtitle={k.partial ? "Current year to date" : undefined} size="2xl">
        <KpiDetail k={k} />
      </DetailModal>
    </div>
  );
}

/** Headline indicator card (reference "Activity 2.780 Cal"): outlined icon + one-line title + the round open button, a
 * big medium-weight number with a muted unit, one muted helper line with the change as muted text, then one visual. */
export function KpiCard({ k, icon, visual = "line" }: { k: KpiDef; icon: ReactNode; visual?: "dots" | "line" | "bar" }) {
  const m = useThemeMode();
  const pts = k.spark.filter((p) => p.value !== null);
  const vals = k.spark.map((p) => p.value);
  const prev = pts[pts.length - 2];
  const first = pts[0];
  const num = Number(String(k.value).replace(/,/g, ""));
  return (
    <Card as="div" title={k.label} icon={icon} className="h-full" bodyClassName="flex flex-col"
          detail={{ children: <KpiDetail k={k} />, size: "2xl", subtitle: k.partial ? "Current year to date" : undefined }} detailLabel={`${k.label}: details`}>
      <div className="flex items-baseline gap-1.5">
        {Number.isFinite(num) ? <AnimatedNumber value={num} format={(n) => (String(k.value).includes(",") ? Math.round(n).toLocaleString("en-GB") : String(Math.round(n)))} className="text-display text-ink tabular" />
          : <span className="text-display text-ink tabular">{k.value}</span>}
        {k.unit && <span className="text-[15px] leading-5 text-muted">{k.unit}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-label font-normal text-muted min-h-[18px]">
        {(k.missing ?? k.sub) && <span className="truncate max-w-full">{k.missing ?? k.sub}</span>}
        {k.delta && <DeltaChip delta={{ text: k.delta.text, dir: k.delta.dir, tone: k.delta.tone }} className="!font-normal" />}
      </div>
      <div className="mt-auto pt-6">
        {visual === "dots" && k.spark.length > 1 && (
          <DotMatrix values={vals} labels={k.spark.map((p) => (p.flag === "partial" ? `${p.year} (annualised)` : String(p.year)))} ariaLabel={`${k.label} by year`}
                     rows={7} height={104} format={(n) => k.format(n)} ticks={[k.spark[0]?.year, k.spark[k.spark.length - 1]?.year]} />
        )}
        {visual === "line" && k.spark.length > 1 && (
          <div className="relative">
            <div className="absolute inset-0 -mx-1 opacity-70 pointer-events-none" aria-hidden
                 style={{ backgroundImage: "radial-gradient(rgb(var(--faint) / 0.55) 1px, transparent 1.4px)", backgroundSize: "12px 12px" }} />
            <div className="relative px-1 py-2"><KpiSpark pts={k.spark} format={k.format} label={k.label} height={88} color={SERIES[m][0]} /></div>
            <div className="flex justify-between text-micro text-muted tabular mt-2"><span>{k.spark[0]?.year}</span><span>{k.spark[k.spark.length - 1]?.year}</span></div>
          </div>
        )}
        {visual === "bar" && (
          <div className="flex flex-col gap-3">
            {Number.isFinite(num) && <GradientRangeBar value={num} min={0} max={100} reverse showMinMax={false} label={`${k.label}, 0 to 100%`} />}
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile label={prev ? `In ${prev.year}` : "Last year"} value={prev ? k.format(prev.value) : "—"} />
              <StatTile label={first && first !== prev ? `In ${first.year}` : "First year"} value={first && first !== prev ? k.format(first.value) : "—"} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Line for an annual indicator: a 2px data-hue line, dashed through low-coverage years, one emphasised end point
 * (hollow when the year is still running). Every point has a native tooltip; a hidden sentence carries the values. */
export function KpiSpark({ pts, format, label, height = 30, color }: { pts: KpiPoint[]; format: (v: number | null) => string; label: string; height?: number; color?: string }) {
  const m = useThemeMode();
  const k = ink(), accent = color ?? SERIES[m][0];
  const fin = pts.filter((p) => p.value !== null && Number.isFinite(p.value));
  if (fin.length < 2) return <div style={{ height }} />;
  const vals = fin.map((p) => p.value as number);
  const min = Math.min(...vals), max = Math.max(...vals), W = 100, pad = 8;
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
    <div className="relative" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden>
        {segs.map((s, i) => <path key={i} d={s.d} fill="none" stroke={accent} strokeOpacity={s.dashed ? 0.6 : 1} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray={s.dashed ? "4 4" : undefined} strokeLinecap="round" />)}
      </svg>
      {/* HTML hit targets keep their shape under the stretched SVG; only the latest point is drawn */}
      {pts.map((p, i) => p.value === null ? null : (
        <span key={p.year} title={`${p.year}: ${format(p.value)}${p.flag === "low" ? " (low EMR coverage)" : p.flag === "partial" ? " (year to date)" : ""}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={i === lastI
                ? { left: `${(x(i) / W) * 100}%`, top: y(p.value), width: 10, height: 10, background: last.flag === "partial" ? k.surface : accent, boxShadow: `0 0 0 2px ${accent}, 0 0 0 5px ${k.surface}` }
                : { left: `${(x(i) / W) * 100}%`, top: y(p.value), width: 12, height: 12 }} />
      ))}
      <span className="sr-only">{label} trend: {pts.map((p) => `${p.year} ${format(p.value)}`).join(", ")}</span>
    </div>
  );
}
