import { useMemo } from "react";
import type { ChartSpec, ChartWidget as ChartWidgetT, KpiTile, Row } from "@agent/widgets";
import { BarChart3, Gauge, LineChart, Map as MapIcon, Rows3, Sigma, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { AnimatedNumber, Card, chartDetailTabs, DataTable, Sparkline, type Column } from "@/components/ui";
import { alphaHex, CATEGORICAL, CORE, ink } from "@/lib/viz";
import { Markdown } from "../parts/Markdown";
import { ChoroplethMap } from "./ChoroplethMap";
import { cellText, colLabel, fmtValue, unitText } from "./format";
import { barHeight, barOption, forestOption, lineOption, seriesLabel } from "./options";

const ICON: Record<ChartSpec["type"], JSX.Element> = {
  line: <LineChart size={16} />, area: <LineChart size={16} />, bar: <BarChart3 size={16} />, kpi: <Gauge size={16} />,
  table: <Rows3 size={16} />, choropleth: <MapIcon size={16} />, forest: <Sigma size={16} />,
};

/** make_chart output (plan §B7, design v3 card grammar): outlined circle icon + title, big numbers, dotted-grid charts in
 * the sky + signal palette; Chart / Table / Method in the detail modal. */
export function ChartWidget({ widget }: { widget: ChartWidgetT }) {
  const spec = widget.spec;
  const method = <MethodNotes spec={spec} />;
  return (
    <Card as="article" aria-label={`Chart: ${spec.title}`} title={spec.title} titleText={spec.title} icon={ICON[spec.type]} className="agent-widget"
          detailLabel="Open chart details"
          detail={{ subtitle: spec.subtitle, size: "5xl", tabs: chartDetailTabs({ chart: spec.type === "table" ? undefined : <ChartBody spec={spec} large />, table: <SpecTable spec={spec} />, method }) }}>
      <figure className="m-0">
        {spec.subtitle && <p className="text-[14px] leading-5 text-muted -mt-3 mb-5">{spec.subtitle}</p>}
        <ChartBody spec={spec} />
        {(spec.caption || hasSuppressed(spec)) && (
          <figcaption className="mt-4 flex flex-col gap-1.5">
            {spec.caption && <span className="text-[14px] leading-[21px] text-ink/80">{spec.caption}</span>}
            {hasSuppressed(spec) && <span className="text-[13px] leading-[18px] text-muted">Gaps mark years or areas with fewer than 5 cases (suppressed).</span>}
          </figcaption>
        )}
        {!!spec.caveats?.length && (
          <ul className="mt-2 flex flex-col gap-0.5 text-[13px] leading-[18px] text-muted" aria-label="Caveats">
            {spec.caveats.slice(0, 3).map((c) => <li key={c}>{c}</li>)}
          </ul>
        )}
      </figure>
    </Card>
  );
}

const hasSuppressed = (spec: ChartSpec) =>
  "data" in spec && spec.type !== "table" && spec.data.some((r) => Object.keys(r).some((k) => k.endsWith("_label") && typeof r[k] === "string"));

/** Series colours: the CORE four (sky, signal, ink, grey) for up to four series, the validated CATEGORICAL palette beyond. */
function usePalette(n: number) {
  const mode = useThemeMode();
  return { mode, S: n > 4 ? CATEGORICAL[mode] : CORE[mode], k: ink() };
}

export function ChartBody({ spec, large = false }: { spec: ChartSpec; large?: boolean }) {
  const { mode, S, k } = usePalette("series" in spec ? spec.series.length : 1);
  const option = useMemo(() => {
    if (spec.type === "line" || spec.type === "area") return lineOption(spec, S, k);
    if (spec.type === "bar") return barOption(spec, S, k);
    if (spec.type === "forest") return forestOption(spec, S, k);
    return null;
  }, [spec, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (spec.type === "kpi") return <KpiTiles tiles={spec.tiles} unit={spec.unit} />;
  if (spec.type === "table") return <div className="max-h-[360px] overflow-auto -mx-1"><SpecTable spec={spec} /></div>;
  if (spec.type === "choropleth") return <ChoroplethMap spec={spec} large={large} />;
  if (!option) return null;
  const height = spec.type === "bar" ? barHeight(spec) * (large ? 1.25 : 1) : spec.type === "forest" ? Math.max(160, spec.data.length * 30 + 40) : large ? 420 : 260;
  return (
    <div>
      <Legend spec={spec} S={S} />
      <EChart option={option} height={height} ariaLabel={`${spec.type} chart: ${spec.title}`} />
    </div>
  );
}

function Legend({ spec, S }: { spec: ChartSpec; S: string[] }) {
  if (spec.type !== "line" && spec.type !== "area" && spec.type !== "bar") return spec.unit ? <div className="text-[13px] text-muted mb-2">{unitText(spec.unit)}</div> : null;
  const ci = spec.series.some((s) => s.lci && s.uci);
  const multi = spec.series.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 text-[13px] text-muted">
      {(spec.unit || spec.yLabel) && <span>{spec.yLabel ?? unitText(spec.unit)}</span>}
      <span className="flex-1" />
      {multi && spec.series.map((s, i) => {
        const fan = spec.type !== "bar" && spec.fan;
        const solid = Math.max(0, spec.series.findIndex((x) => !x.dashed));
        const c = fan && s.dashed ? S[solid % S.length] : S[i % S.length];
        return (
          <span key={s.key} className="inline-flex items-center gap-2">
            {s.dashed ? <span className="w-3.5 h-0 border-t-2 border-dashed" style={{ borderColor: c }} aria-hidden />
                      : <span className="w-2 h-2 rounded-full" style={{ background: c }} aria-hidden />}{seriesLabel(s)}
          </span>
        );
      })}
      {spec.type !== "bar" && spec.fan && (
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex" aria-hidden>
            <span className="w-2.5 h-2.5 rounded-l-full" style={{ background: alphaHex(S[Math.max(0, spec.series.findIndex((x) => !x.dashed)) % S.length], 0.34) }} />
            <span className="w-2.5 h-2.5 rounded-r-full" style={{ background: alphaHex(S[Math.max(0, spec.series.findIndex((x) => !x.dashed)) % S.length], 0.14) }} />
          </span>
          {spec.fan.label ?? (spec.fan.lo80 ? "80% / 95% interval" : "95% interval")}
        </span>
      )}
      {ci && (
        <span className="inline-flex items-center gap-2">
          {spec.type === "bar" ? <span className="w-2.5 h-2.5 border-x border-muted/70 relative" aria-hidden><span className="absolute inset-x-0 top-1/2 h-px bg-muted/70" /></span>
                               : <span className="w-2.5 h-2.5 rounded-full" style={{ background: alphaHex(S[0], 0.28) }} aria-hidden />}
          95% CI
        </span>
      )}
    </div>
  );
}

function KpiTiles({ tiles, unit }: { tiles: KpiTile[]; unit?: string }) {
  const cols = tiles.length === 1 ? "grid-cols-1" : tiles.length === 2 || tiles.length === 4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3";
  return (
    <div className={`grid gap-3 ${cols}`}>
      {tiles.map((t) => {
        // the chart-level unit only applies to tiles that are rates / plain numbers (not counts or percentages)
        const u = t.unit ?? (t.format === "integer" || t.format === "percent" || t.format === "fraction_percent" ? undefined : unit);
        const fmt = (n: number) => fmtValue(n, t.format, u);
        const dir = t.delta === null || t.delta === undefined ? 0 : t.delta > 0 ? 1 : t.delta < 0 ? -1 : 0;
        const DeltaIcon = dir > 0 ? TrendingUp : dir < 0 ? TrendingDown : Minus;
        return (
          <div key={t.label} className="rounded-tile bg-tile p-5 flex flex-col min-w-0">
            <div className="text-[14px] leading-5 text-muted truncate" title={t.label}>{t.label}</div>
            <div className="flex items-baseline gap-2 min-w-0 mt-2">
              {t.value === null
                ? <span className="text-metric text-ink">{t.valueLabel ?? "—"}</span>
                : <AnimatedNumber value={t.value} format={fmt} className={`${tiles.length === 1 ? "text-display" : "text-metric"} text-ink`} />}
              {u && !/%$/.test(u) && t.format !== "percent" && t.format !== "fraction_percent" && <span className="text-[15px] text-muted truncate">{u}</span>}
            </div>
            {(t.ci && t.ci[0] !== null && t.ci[1] !== null || t.delta !== null && t.delta !== undefined || t.deltaLabel) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-[18px] text-muted tabular">
                {t.delta !== null && t.delta !== undefined && (
                  <span className="inline-flex items-center gap-1 text-ink/80">
                    <DeltaIcon size={13} aria-hidden />{`${t.delta > 0 ? "+" : ""}${fmtValue(t.delta, t.format === "fraction_percent" ? "fraction_percent" : undefined)}`}
                    {t.deltaLabel && <span className="text-muted">{t.deltaLabel}</span>}
                  </span>
                )}
                {(t.delta === null || t.delta === undefined) && t.deltaLabel && <span>{t.deltaLabel}</span>}
                {t.ci && t.ci[0] !== null && t.ci[1] !== null && <span>95% CI {fmt(t.ci[0])}–{fmt(t.ci[1])}</span>}
              </div>
            )}
            {t.trend && t.trend.filter((v) => v !== null).length > 1 && <Sparkline values={t.trend} height={32} className="mt-3" />}
          </div>
        );
      })}
    </div>
  );
}

/** All columns of the spec's data (or the declared table columns), formatted, suppression labels shown. */
export function SpecTable({ spec }: { spec: ChartSpec }) {
  const { columns, rows } = useMemo(() => {
    if (spec.type === "kpi") {
      const rows: Row[] = spec.tiles.map((t) => ({ label: t.label, value: t.value, value_label: t.valueLabel ?? null, lci: t.ci?.[0] ?? null, uci: t.ci?.[1] ?? null, delta: t.delta ?? null }));
      return { rows, columns: ["label", "value", "lci", "uci", "delta"].map((key) => col(key, rows)) };
    }
    if (spec.type === "table") {
      return { rows: spec.data, columns: spec.columns.map((c) => ({ ...col(c.key, spec.data, c.format), label: c.label ?? colLabel(c.key) })) };
    }
    const keys = [...new Set(spec.data.flatMap((r) => Object.keys(r)))].filter((k) => !k.endsWith("_label"));
    return { rows: spec.data, columns: keys.map((k) => col(k, spec.data, undefined, spec.unit)) };
  }, [spec]);
  return <DataTable columns={columns} rows={rows} ariaLabel={`${spec.title} data`} />;
}

function col(key: string, rows: Row[], format?: Parameters<typeof fmtValue>[1], unit?: string): Column<Row> {
  const num = rows.some((r) => typeof r[key] === "number");
  return { key, label: colLabel(key), num, fmt: (_v, r) => cellText(r, key, format, num ? unit : undefined) };
}

function MethodNotes({ spec }: { spec: ChartSpec }) {
  const src = spec.source;
  return (
    <div className="flex flex-col gap-3">
      {spec.subtitle && <p>{spec.subtitle}</p>}
      {spec.caption && <p className="text-fg-muted">{spec.caption}</p>}
      {src?.tool && <p><span className="text-muted">Source tool </span><code className="font-mono text-[12px] bg-tile rounded-md px-1.5 py-0.5">{src.tool}</code></p>}
      {src?.note && <p className="text-muted">{src.note}</p>}
      {src?.sql && <Markdown>{"```sql\n" + src.sql + "\n```"}</Markdown>}
      {!!spec.caveats?.length && <ul className="list-disc pl-5 text-fg-muted">{spec.caveats.map((c) => <li key={c}>{c}</li>)}</ul>}
      <p className="text-[13px] text-muted">Synthetic data. Numbers come straight from the tool output; counts under 5 are suppressed.</p>
    </div>
  );
}


