import { useThemeMode } from "@/components/charts/EChart";
import { BentoGrid, GridItem } from "@/components/ui/BentoGrid";
import { DataTable } from "@/components/ui/DataTable";
import { MetricCard } from "@/components/ui/MetricCard";
import { StatusChip } from "@/components/ui/StatusChip";
import { ink, SERIES } from "@/lib/viz";

export type KpiPoint = { year: number; value: number | null; flag?: "low" | "partial" | null };
export type KpiDef = {
  id: string; label: string; value: string; unit?: string; sub?: string;
  delta: { text: string; dir: -1 | 0 | 1; tone: "good" | "bad" | "neutral"; note?: string } | null;
  spark: KpiPoint[]; partial?: boolean; scope?: string; missing?: string;
  format: (v: number | null) => string;
};

/** Headline indicators as v2 MetricCards ("Key areas of concern" layout): number + unit, delta chip, YTD chip, animated
 * sparkline. Sub-lines, scope and comparison notes live in the ⓘ; the full annual series + table open in the detail modal. */
export function KpiStrip({ items }: { items: KpiDef[] }) {
  const m = useThemeMode();
  return (
    <BentoGrid as="ul" role="list" aria-label="Headline indicators">
      {items.map((k) => (
        <GridItem key={k.id} as="li" role="listitem" span={{ sm: 6, lg: 4, xl: 2 }} aria-label={`${k.label}: ${k.value}${k.unit ? " " + k.unit : ""}`}>
          <MetricCard
            label={k.label} value={k.value} unit={k.unit}
            delta={k.delta ? { text: k.delta.text, dir: k.delta.dir, tone: k.delta.tone } : null}
            status={k.partial ? { status: "warning", label: "YTD" } : k.id === "await" && !k.missing?.startsWith("Not") ? { status: "critical", label: "HIGH band" } : null}
            spark={k.spark.length > 1 ? k.spark.map((p) => p.value) : undefined} sparkColor={SERIES[m][0]}
            info={{ about: k.missing ?? k.sub, notes: [k.delta?.note && `Change ${k.delta.note}.`, k.partial && "Current year is year-to-date (annualised where noted).", k.scope].filter(Boolean).join(" ") || undefined }}
            detail={k.spark.length > 1 ? { title: k.label, children: <KpiDetail k={k} />, size: "2xl", subtitle: k.sub } : undefined}
            className="h-full"
          />
        </GridItem>
      ))}
    </BentoGrid>
  );
}

function KpiDetail({ k }: { k: KpiDef }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-tile bg-surface-2 border border-border/70 px-4 pt-5 pb-3">
        <KpiSpark pts={k.spark} format={k.format} label={k.label} height={150} />
        <div className="flex justify-between text-micro text-fg-muted tabular mt-2">
          <span>{k.spark[0]?.year}</span><span>{k.spark[k.spark.length - 1]?.year}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {k.spark.some((p) => p.flag === "low") && <StatusChip status="neutral" label="Dashed = low EMR coverage" />}
        {k.spark.some((p) => p.flag === "partial") && <StatusChip status="warning" label="Hollow = year to date" />}
      </div>
      <div className="overflow-auto max-h-[40vh] rounded-tile border border-border">
        <DataTable rows={[...k.spark].reverse()} columns={[
          { key: "year", label: "Year" }, { key: "value", label: k.label, num: true, fmt: (v) => k.format(v) },
          { key: "flag", label: "Flag", fmt: (v) => (v === "partial" ? "year to date" : v === "low" ? "low EMR coverage" : "") },
        ]} />
      </div>
    </div>
  );
}

/** Sparkline: muted history, dashed through low-coverage years, hollow end for a partial year, accent on the current year. */
export function KpiSpark({ pts, format, label, height = 30 }: { pts: KpiPoint[]; format: (v: number | null) => string; label: string; height?: number }) {
  const m = useThemeMode();
  const k = ink(), accent = SERIES[m][0];
  const fin = pts.filter((p) => p.value !== null && Number.isFinite(p.value));
  if (fin.length < 2) return <div style={{ height }} />;
  const vals = fin.map((p) => p.value as number);
  const min = Math.min(...vals), max = Math.max(...vals), W = 100, pad = 6;
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
      {/* HTML dots keep their shape under the stretched SVG; each point has a native tooltip */}
      {pts.map((p, i) => p.value === null ? null : (
        <span key={p.year} title={`${p.year}: ${format(p.value)}${p.flag === "low" ? " (low EMR coverage)" : p.flag === "partial" ? " (year to date)" : ""}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${(x(i) / W) * 100}%`, top: y(p.value), width: 9, height: 9,
                       background: i === lastI && last.flag === "partial" ? k.surface : p.flag ? k.surface : accent, boxShadow: `0 0 0 1.8px ${accent}` }} />
      ))}
      <span className="sr-only">{label} trend: {pts.map((p) => `${p.year} ${format(p.value)}`).join(", ")}</span>
    </div>
  );
}
