import { useMemo } from "react";
import type { EChartsOption, SeriesOption } from "echarts";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { fmt, int } from "@/lib/format";
import { HUE, ink } from "@/lib/viz";
import { alpha, bandSeries, chartBase, tipHead, tipNote, tipRow } from "../trends/kit";
import type { FcMetric, FcPt, HistPt } from "./api";

/** Registry years below this completeness are drawn dashed (the synthetic registry ramps from 40% in 2000 to 85%). */
export const FULL_COMPLETENESS = 0.85;
const lowComp = (h?: HistPt) => !!h && h.completeness !== undefined && h.completeness < FULL_COMPLETENESS - 1e-6;
export const fmtValue = (metric: FcMetric, v: number | null | undefined) => (metric === "cases" ? int(v) : fmt(v, 1));

type FanProps = {
  history: HistPt[]; forecast: FcPt[]; metric: FcMetric; height: number; today: number | null;
  /** Draw on the sky stage (hero): bands in deeper sky tints, axes in ink. */
  stage?: boolean; ariaLabel: string; from?: number;
  /** Extra grid padding (the hero keeps room for the white stats strip at the bottom). */
  grid?: { left?: number; right?: number; top?: number; bottom?: number };
};

/** Forecast fan (2D on purpose: a 3D ribbon adds depth that encodes nothing). History is the registry line (dashed where
 * registry completeness is low), the forecast mean is dashed and the 80% / 95% intervals are sky tints that open from
 * the last observed year. A vertical rule marks the simulated "today"; the 2031 mean carries the one signal dot. */
export function FanChart({ history, forecast, metric, height, today, stage = false, ariaLabel, from, grid }: FanProps) {
  const m = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase();
    const k = ink();
    const h = HUE[m];
    const hist = history.filter((p) => p.year >= (from ?? 0));
    const last = [...hist].reverse().find((p) => p.mean !== null);
    const x0 = hist[0]?.year ?? 2000, x1 = forecast.length ? forecast[forecast.length - 1].year : (last?.year ?? 2031);
    const anchor = last ? [{ x: last.year, lo: last.mean, hi: last.mean }] : [];
    const band95 = [...anchor, ...forecast.map((p) => ({ x: p.year, lo: p.lo95, hi: p.hi95 }))];
    const band80 = [...anchor, ...forecast.map((p) => ({ x: p.year, lo: p.lo80, hi: p.hi80 }))];
    const op95 = stage ? (m === "dark" ? 0.22 : 0.3) : (m === "dark" ? 0.16 : 0.16);
    const op80 = stage ? (m === "dark" ? 0.4 : 0.55) : (m === "dark" ? 0.3 : 0.3);
    const line = k.primary;
    const solid = hist.map((p, i) => [p.year, lowComp(p) && lowComp(hist[i + 1]) ? null : p.mean]);
    const dashed = hist.map((p, i) => [p.year, lowComp(p) || lowComp(hist[i - 1]) ? p.mean : null]);
    const fcLine = [...(last ? [[last.year, last.mean]] : []), ...forecast.map((p) => [p.year, p.mean])];
    const end = forecast[forecast.length - 1];
    const series: SeriesOption[] = [
      bandSeries("95% interval", band95, h.sky, { opacity: op95, z: 1 }),
      bandSeries("80% interval", band80, h.sky, { opacity: op80, z: 2 }),
      { type: "line", name: "Registry", data: solid, showSymbol: false, connectNulls: false, z: 4, lineStyle: { width: 2, color: line }, itemStyle: { color: line }, emphasis: { disabled: true } } as any,
      { type: "line", name: "Registry, low completeness", data: dashed, showSymbol: false, connectNulls: false, z: 4,
        lineStyle: { width: 1.5, color: line, type: [2, 4], opacity: 0.7 }, itemStyle: { color: line }, emphasis: { disabled: true } } as any,
      { type: "line", name: "Forecast", data: fcLine, showSymbol: false, z: 5, lineStyle: { width: 2, color: line, type: [6, 5] }, itemStyle: { color: line }, emphasis: { disabled: true } } as any,
    ];
    if (end) {
      series.push({
        type: "scatter", name: "2031", data: [[end.year, end.mean]], symbolSize: 11, z: 7, silent: true,
        itemStyle: { color: h.signal, borderColor: stage ? h.skySoft : k.surface, borderWidth: 3 },
        label: { show: true, position: "left", distance: 10, formatter: () => fmtValue(metric, end.mean), color: k.primary, fontSize: 13, fontWeight: 600 },
      } as any);
    }
    if (today !== null && today >= x0 && today <= x1 + 0.5) {
      (series[2] as any).markLine = {
        silent: true, symbol: "none", animation: false,
        lineStyle: { color: k.primary, width: 1, type: "solid", opacity: 0.35 },
        label: { formatter: "Today", position: "end", color: k.secondary, fontSize: 11, fontWeight: 500, distance: 6 },
        data: [{ xAxis: today }],
      };
    }
    return {
      ...b,
      grid: { left: 52, right: 24, top: 28, bottom: 30, ...grid },
      xAxis: { ...b.xAxis, type: "value", min: x0, max: x1 + 0.4, interval: x1 - x0 > 16 ? 5 : 1,
               axisLabel: { ...b.xAxis.axisLabel, color: k.secondary, formatter: (v: number) => (Number.isInteger(v) ? String(v) : "") } },
      yAxis: { ...b.yAxis, type: "value", min: 0, splitNumber: 4,
               axisLabel: { ...b.yAxis.axisLabel, color: k.secondary, formatter: (v: number) => (metric === "cases" ? (v >= 1000 ? `${fmt(v / 1000, v % 1000 ? 1 : 0)}k` : String(v)) : String(v)) },
               splitLine: { lineStyle: { color: stage ? alpha(k.primary.startsWith("#") ? k.primary : "#15171C", m === "dark" ? 0.12 : 0.1) : k.grid, type: [1, 4] } } },
      tooltip: {
        ...b.tooltip, trigger: "axis",
        formatter: (ps: any) => {
          const yr = Math.round(Array.isArray(ps) ? ps[0]?.axisValue : ps?.axisValue);
          const hp = history.find((p) => p.year === yr);
          const fp = forecast.find((p) => p.year === yr);
          const unit = metric === "cases" ? "cases" : "per 100k";
          if (fp) {
            return tipHead(`${yr}, forecast`) + tipRow(line, "Mean", `${fmtValue(metric, fp.mean)} ${unit}`)
              + tipRow(alpha(h.sky, 0.8), "80% interval", `${fmtValue(metric, fp.lo80)}–${fmtValue(metric, fp.hi80)}`)
              + tipRow(alpha(h.sky, 0.4), "95% interval", `${fmtValue(metric, fp.lo95)}–${fmtValue(metric, fp.hi95)}`);
          }
          if (hp) {
            const v = hp.mean === null ? (hp.cases_label ? `${hp.cases_label} cases` : "suppressed") : `${fmtValue(metric, hp.mean)} ${unit}`;
            return tipHead(String(yr)) + tipRow(line, "Registry", v)
              + (hp.completeness !== undefined ? tipNote(`Registry completeness ${fmt(100 * hp.completeness, 0)}%${lowComp(hp) ? ": counts understate the true burden." : "."}`) : "");
          }
          return "";
        },
      },
      series,
    } as EChartsOption;
  }, [history, forecast, metric, today, stage, m, from, grid]);
  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}

/** Mini fan for the Overview card: last observed decade + projection, as a plain SVG (no axes, no hover). */
export function FanSpark({ history, forecast, height = 96, from = 2014 }: { history: HistPt[]; forecast: FcPt[]; height?: number; from?: number }) {
  const m = useThemeMode();
  const h = HUE[m], k = ink();
  const hist = history.filter((p) => p.year >= from && p.mean !== null) as (HistPt & { mean: number })[];
  if (hist.length < 2 || !forecast.length) return <div style={{ height }} />;
  const last = hist[hist.length - 1];
  const x0 = hist[0].year, x1 = forecast[forecast.length - 1].year;
  const vals = [...hist.map((p) => p.mean), ...forecast.flatMap((p) => [p.lo95, p.hi95])];
  const lo = Math.min(...vals) * 0.92, hi = Math.max(...vals) * 1.02;
  const W = 300, P = 6;
  const x = (yr: number) => P + ((yr - x0) / (x1 - x0)) * (W - 2 * P);
  const y = (v: number) => height - P - ((v - lo) / (hi - lo || 1)) * (height - 2 * P);
  const path = (pts: [number, number][]) => pts.map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join("");
  const band = (key: "95" | "80") => {
    const up = forecast.map((p) => [p.year, key === "95" ? p.hi95 : p.hi80] as [number, number]);
    const dn = [...forecast].reverse().map((p) => [p.year, key === "95" ? p.lo95 : p.lo80] as [number, number]);
    return `${path([[last.year, last.mean], ...up, ...dn, [last.year, last.mean]])}Z`;
  };
  const end = forecast[forecast.length - 1];
  return (
    <div className="relative" style={{ height }} aria-hidden>
      <svg viewBox={`0 0 ${W} ${height}`} className="absolute inset-0 w-full h-full overflow-visible" preserveAspectRatio="none">
        <path d={band("95")} fill={alpha(h.sky, m === "dark" ? 0.2 : 0.22)} />
        <path d={band("80")} fill={alpha(h.sky, m === "dark" ? 0.38 : 0.42)} />
        <path d={path(hist.map((p) => [p.year, p.mean]))} fill="none" stroke={k.primary} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <path d={path([[last.year, last.mean], ...forecast.map((p) => [p.year, p.mean] as [number, number])])} fill="none" stroke={k.primary} strokeWidth={2}
              strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* the end point as HTML so it stays round under the stretched SVG */}
      <span className="absolute w-[11px] h-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${(x(end.year) / W) * 100}%`, top: y(end.mean), background: h.signal, boxShadow: `0 0 0 2.5px ${k.surface}` }} />
    </div>
  );
}
