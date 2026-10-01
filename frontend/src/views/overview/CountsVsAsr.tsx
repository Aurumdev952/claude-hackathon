import type { EChartsOption } from "echarts";
import type { RateRow } from "@/api/types";
import { base, EChart, useThemeMode } from "@/components/charts/EChart";
import { ink, SERIES } from "@/lib/viz";
import { fmt, int } from "@/lib/format";

/** INS-7: raw counts vs person-time ASR on ONE axis, both indexed to the first full-coverage year (never a dual axis). */
export function CountsVsAsr({ rows, height = 230 }: { rows: RateRow[]; height?: number }) {
  const m = useThemeMode();
  const k = ink(), S = SERIES[m];
  const ys = rows.filter((r) => r.asr !== null).map((r) => ({ ...r, year: Number(r.period) })).sort((a, b) => a.year - b.year);
  const baseRow = ys.find((r) => !r.coverage_flag && !r.partial_year && (r.cases ?? 0) > 0);
  if (!baseRow) return <div className="text-xs text-fog p-4">Not enough years to index.</div>;
  // Partial year: annualise the count by the share of person-time elapsed (YTD person-years ÷ previous full year).
  const ann = (r: (typeof ys)[number]) => {
    const prev = ys.find((x) => x.year === r.year - 1);
    return r.partial_year && prev?.population ? ((r.cases ?? 0) * prev.population) / (r.population || 1) : r.cases ?? 0;
  };
  const idxC = (r: (typeof ys)[number]) => (100 * ann(r)) / (baseRow.cases || 1);
  const idxA = (r: (typeof ys)[number]) => (100 * (r.asr ?? 0)) / (baseRow.asr || 1);
  const flag = (r: (typeof ys)[number]) => !!r.coverage_flag || r.partial_year;
  const split = (f: (r: (typeof ys)[number]) => number) => ({
    solid: ys.map((r) => [r.year, flag(r) ? null : f(r)]),
    dashed: ys.map((r, i) => [r.year, flag(r) || (ys[i - 1] && flag(ys[i - 1])) || (ys[i + 1] && flag(ys[i + 1])) ? f(r) : null]),
  });
  const c = split(idxC), a = split(idxA);
  const last = ys[ys.length - 1], first = ys[0];
  const b = base();
  const opt: EChartsOption = {
    ...b,
    grid: { left: 40, right: 74, top: 30, bottom: 26 },
    legend: { ...(b.legend as object), left: 0, right: "auto", data: [
      { name: "Crude case count", icon: "path://M0,2h12v2h-12z" }, { name: "Age-standardised rate", icon: "path://M0,2h12v2h-12z" },
      { name: "Low coverage / YTD", icon: "path://M0,2h4v2h-4zM7,2h4v2h-4z", itemStyle: { color: k.muted } } as any] },
    xAxis: { ...(b.xAxis as object), type: "value", min: first.year - 0.3, max: last.year + 0.3, interval: 1, axisLabel: { color: k.muted, formatter: (v: number) => (Number.isInteger(v) ? String(v) : "") } } as any,
    yAxis: { ...(b.yAxis as object), type: "value", min: 0, name: `index, ${baseRow.year} = 100`, nameGap: 10 } as any,
    tooltip: { ...(b.tooltip as object), formatter: (ps: any) => {
      const y = Math.round(ps[0]?.value?.[0]); const r = ys.find((x) => x.year === y); if (!r) return "";
      return `<b>${y}</b>${flag(r) ? ` <span style="color:${k.muted}">${r.partial_year ? "· year to date" : "· low EMR coverage"}</span>` : ""}<br/>Cases: <b>${int(r.cases)}</b> (index ${fmt(idxC(r), 0)})<br/>ASR: <b>${fmt(r.asr)}</b> per 100k (index ${fmt(idxA(r), 0)})`;
    } } as any,
    series: [
      { name: "Crude case count", type: "line", data: c.solid, symbol: "circle", symbolSize: 5, lineStyle: { width: 2, color: S[2] }, itemStyle: { color: S[2] },
        endLabel: { show: false } },
      { name: "Low coverage / YTD", type: "line", data: c.dashed, symbol: "emptyCircle", symbolSize: 5, lineStyle: { width: 1.6, type: [4, 4], color: S[2] }, itemStyle: { color: S[2] } },
      { name: "Age-standardised rate", type: "line", data: a.solid, symbol: "circle", symbolSize: 5, lineStyle: { width: 2, color: S[0] }, itemStyle: { color: S[0] } },
      { name: "asr-dashed", type: "line", data: a.dashed, symbol: "emptyCircle", symbolSize: 5, lineStyle: { width: 1.6, type: [4, 4], color: S[0] }, itemStyle: { color: S[0] }, tooltip: { show: false } },
      { name: "labels", type: "scatter", silent: true, symbolSize: 0, tooltip: { show: false },
        data: [{ value: [last.year, idxC(last)], label: { formatter: `counts ${fmt(idxC(last) / 100, 1)}×` } }, { value: [last.year, idxA(last)], label: { formatter: `ASR ${fmt(idxA(last) / 100, 2)}×` } }],
        label: { show: true, position: "right", color: k.secondary, fontSize: 11, fontWeight: 600, distance: 8 } },
      { name: "base", type: "line", data: [], markLine: { silent: true, symbol: "none", lineStyle: { color: k.axis, width: 1, type: "solid" }, label: { show: false }, data: [{ yAxis: 100 }] } },
    ] as any,
  };
  return <EChart option={opt} height={height} ariaLabel={`Crude case counts versus age-standardised rate, indexed to ${baseRow.year}`} />;
}
