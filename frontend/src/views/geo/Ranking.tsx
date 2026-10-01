import type { EChartsOption } from "echarts";
import type { MapRow } from "@/api/types";
import { base, EChart, useThemeMode } from "@/components/charts/EChart";
import { ink, SERIES } from "@/lib/viz";
import { fmt, int } from "@/lib/format";
import type { SpatialRow } from "./data";
import { LISA_LABEL, lisaRgb, numeric, rgbCss, type MetricDef } from "./model";

/** Caterpillar plot: every district's value with its 95% CI against the national reference (the 2D twin of the map). */
export function Ranking({ rows, metric, spatial, national, selected, highlight, onSelect }: {
  rows: MapRow[]; metric: MetricDef; spatial: Map<string, SpatialRow>; national: number | null; selected: string | null; highlight: string | null; onSelect: (c: string) => void;
}) {
  const m = useThemeMode();
  const k = ink(), S = SERIES[m];
  const key = (metric.key === "lisa_quadrant" ? "asr" : metric.key) as keyof MapRow;
  const data = rows.filter((r) => numeric(r, key) !== null && !r.suppressed).sort((a, b) => (numeric(a, key) ?? 0) - (numeric(b, key) ?? 0));
  const ci = (r: MapRow): [number | null, number | null] =>
    key === "asr" ? [r.asr_lci, r.asr_uci] : key === "sir" ? [spatial.get(r.geo_code)?.sir_lci ?? null, spatial.get(r.geo_code)?.sir_uci ?? null] : [null, null];
  const ref = metric.key === "sir" ? 1 : key === "asr" || key === "crude_rate" ? national : null;
  const dot = (r: MapRow) => (metric.key === "lisa_quadrant" ? rgbCss(lisaRgb(r.lisa_quadrant)) : r.geo_code === selected ? k.primary : S[0]);
  const b = base();
  const opt: EChartsOption = {
    ...b,
    grid: { left: 92, right: 56, top: 22, bottom: 26 },
    tooltip: {
      ...(b.tooltip as object), trigger: "item",
      formatter: (p: any) => {
        const r = data[p.dataIndex ?? 0] ?? data.find((x) => x.name === p.name);
        if (!r) return "";
        const [lo, hi] = ci(r);
        return `<b>${r.name}</b> · #${data.length - data.indexOf(r)} of ${data.length}<br/>${metric.short}: <b>${metric.format(numeric(r, key))}</b>${lo !== null ? ` <span style="color:${k.muted}">(${fmt(lo, metric.key === "sir" ? 2 : 1)}–${fmt(hi, metric.key === "sir" ? 2 : 1)})</span>` : ""}` +
          `<br/>Cases: ${r.suppressed ? "<5" : int(r.cases)}${r.lisa_quadrant && r.lisa_quadrant !== "NS" ? `<br/>LISA: ${LISA_LABEL[r.lisa_quadrant]}` : ""}${r.coverage_flag ? "<br/>⚑ Low EMR coverage" : ""}`;
      },
    } as any,
    xAxis: { ...(b.xAxis as object), type: "value", min: 0, axisLabel: { color: k.muted }, splitLine: { show: true, lineStyle: { color: k.grid } },
      name: metric.unit, nameLocation: "middle", nameGap: 22, nameTextStyle: { color: k.muted, fontSize: 10 } } as any,
    yAxis: { ...(b.yAxis as object), type: "category", data: data.map((r) => r.name), axisLabel: {
      color: k.secondary, fontSize: 11,
      formatter: (v: string) => { const r = data.find((x) => x.name === v); return r?.geo_code === selected ? `{s|${v}}` : r?.geo_code === highlight ? `{h|${v}}` : v; },
      rich: { s: { color: k.primary, fontWeight: 700, fontSize: 11 }, h: { color: k.primary, fontWeight: 600, fontSize: 11, textDecoration: "underline" } as any },
    }, splitLine: { show: false } } as any,
    series: [
      {
        type: "custom", name: "95% CI", silent: true,
        renderItem: (_: any, api: any) => {
          const lo = api.value(0), hi = api.value(1), y = api.value(2);
          if (lo === null || hi === null || Number.isNaN(lo)) return null;
          const a = api.coord([lo, y]), c = api.coord([hi, y]);
          return { type: "line", shape: { x1: a[0], y1: a[1], x2: c[0], y2: c[1] }, style: { stroke: k.axis, lineWidth: 1.5 } };
        },
        data: data.map((r, i) => { const [lo, hi] = ci(r); return [lo ?? NaN, hi ?? NaN, i]; }),
        encode: { x: [0, 1], y: 2 }, z: 1,
      } as any,
      {
        type: "scatter", name: metric.short, data: data.map((r, i) => ({ value: [numeric(r, key), i], name: r.name, itemStyle: { color: dot(r), borderColor: k.surface, borderWidth: 1.5, opacity: r.coverage_flag ? 0.45 : 1 } })),
        symbolSize: (_: any, p: any) => (data[p.dataIndex]?.geo_code === selected ? 11 : 8), z: 3,
        markLine: ref !== null ? { silent: true, symbol: "none", lineStyle: { color: k.muted, type: "solid", width: 1 },
          label: { formatter: metric.key === "sir" ? "1.0 = national" : `national ${fmt(ref)}`, color: k.muted, fontSize: 10, position: "end" }, data: [{ xAxis: ref }] } : undefined,
      } as any,
    ],
  };
  return <EChart option={opt} height={Math.max(260, data.length * 17 + 56)} ariaLabel={`District ranking by ${metric.label}`}
                 onEvents={{ click: (e: any) => { const r = data.find((x) => x.name === e.name) ?? data[e.dataIndex]; if (r) onSelect(r.geo_code); } }} />;
}
