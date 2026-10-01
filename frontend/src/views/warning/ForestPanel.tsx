import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { Crosshair } from "lucide-react";
import { Card, chartDetailTabs, DataTable, Loading } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
import { fmt } from "@/lib/format";
import { chartBase, tipHead, tipRow, usePalette } from "../trends/kit";
import { SIGNAL_LABEL, useOr } from "./api";

const pFmt = (p: number) => (p < 0.001 ? "<0.001" : fmt(p, 3));

/** Signal odds ratios (conditional logistic regression): log x-axis, CI whiskers, reference at OR = 1. */
export function ForestPanel() {
  const q = useOr();
  const pal = usePalette();
  const rows = useMemo(() => [...(q.data?.data ?? [])].sort((a, b) => b.or - a.or), [q.data]);
  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const b = chartBase();
    const k = pal.ink;
    const c = pal.series[0];
    const cats = rows.map((r) => r.signal);
    const max = Math.pow(10, Math.ceil(Math.log10(Math.max(...rows.map((r) => r.uci)) * 1.1)));
    return {
      ...b,
      grid: { left: 168, right: 150, top: 28, bottom: 34 },
      xAxis: { ...b.xAxis, type: "log", logBase: 10, min: 0.5, max, name: "Odds ratio (log scale)", nameLocation: "middle", nameGap: 22, nameTextStyle: { color: k.muted, fontSize: 10 },
        splitLine: { show: true, lineStyle: { color: k.grid } }, minorSplitLine: { show: true, lineStyle: { color: k.grid, opacity: 0.4 } },
        axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => fmt(v, v < 1 ? 1 : 0) } },
      yAxis: [
        { ...b.yAxis, type: "category", data: cats, inverse: true, splitLine: { show: false }, axisLabel: { color: k.secondary, fontSize: 11.5, formatter: (v: string) => SIGNAL_LABEL[v] ?? v } },
        { ...b.yAxis, type: "category", data: cats, inverse: true, position: "right", splitLine: { show: false },
          axisLabel: { color: k.primary, fontSize: 11, align: "left", margin: 12, rich: { m: { color: k.muted, fontSize: 10.5 } },
            formatter: (v: string) => { const r = rows.find((x) => x.signal === v)!; return `${fmt(r.or, 1)} {m|[${fmt(r.lci, 1)}–${fmt(r.uci, 1)}]}`; } } },
      ],
      tooltip: { ...b.tooltip, trigger: "item", formatter: (p: any) => {
        const r = rows[p.data.value[2]];
        return tipHead(SIGNAL_LABEL[r.signal] ?? r.signal) + tipRow(c, "Odds ratio", fmt(r.or, 1), `[${fmt(r.lci, 1)}–${fmt(r.uci, 1)}]`) +
          tipRow(null, "Cases with signal", `${fmt(r.pct_cases, 0)}%`) + tipRow(null, "Controls with signal", `${fmt(r.pct_controls, 0)}%`) + tipRow(null, "p", pFmt(r.p));
      } },
      series: [{
        type: "custom", name: "or", data: rows.map((r, i) => ({ value: [r.lci, r.uci, i, r.or] })), encode: { x: [0, 1], y: 2 },
        renderItem: (_p: any, api: any) => {
          const i = api.value(2);
          const a = api.coord([api.value(0), i]), z = api.coord([api.value(1), i]), m = api.coord([api.value(3), i]);
          const st = { stroke: c, lineWidth: 1.75 };
          return { type: "group", children: [
            { type: "rect", shape: { x: a[0] - 6, y: a[1] - 11, width: z[0] - a[0] + 12, height: 22 }, style: { fill: "transparent" } },
            { type: "line", shape: { x1: a[0], y1: a[1], x2: z[0], y2: z[1] }, style: st },
            { type: "line", shape: { x1: a[0], y1: a[1] - 4, x2: a[0], y2: a[1] + 4 }, style: st },
            { type: "line", shape: { x1: z[0], y1: z[1] - 4, x2: z[0], y2: z[1] + 4 }, style: st },
            { type: "rect", shape: { x: m[0] - 5, y: m[1] - 5, width: 10, height: 10, r: 2 }, style: { fill: c, stroke: k.surface, lineWidth: 2 } },
          ] } as any;
        },
        markLine: { silent: true, symbol: "none", lineStyle: { color: k.secondary, width: 1, type: "solid" }, label: { formatter: "OR = 1", color: k.muted, fontSize: 10, position: "start" }, data: [{ xAxis: 1 }] },
      } as any],
    } as EChartsOption;
  }, [rows, pal]);

  const method = "Conditional logistic regression on the matched sets (statsmodels ConditionalLogit), one signal at a time. Windows are the 12 months before the index date (6 months for weight loss). OR = 1 means no association; the x-axis is logarithmic so ×2 and ÷2 look the same distance from 1.";
  const table = <DataTable columns={[{ key: "signal", label: "Signal", fmt: (v) => SIGNAL_LABEL[v] ?? v }, { key: "pct_cases", label: "% cases", num: true, fmt: (v) => fmt(v, 1) },
    { key: "pct_controls", label: "% controls", num: true, fmt: (v) => fmt(v, 1) }, { key: "or", label: "OR", num: true, fmt: (v) => fmt(v, 2) },
    { key: "ci", label: "95% CI", num: true, fmt: (_v, r) => `${fmt(r.lci, 2)}–${fmt(r.uci, 2)}` }, { key: "p", label: "p", num: true, fmt: pFmt }]} rows={rows} />;
  return (
    <Card
      title="Which signals separate cases?" icon={<Crosshair size={16} />}
      info={{ about: "Odds ratio for having each signal before the index date (95% CI). Right axis: OR [CI]. The share of cases and controls with each signal is in the table and the tooltip.", method }}
      detail={{ tabs: chartDetailTabs({ table, method }), defaultTab: "table" }} detailLabel="View as table"
    >
      {q.error ? <ErrorNote error={q.error} /> : !option ? <Loading h={240} /> : (
        <EChart option={option} height={352} ariaLabel="Forest plot of signal odds ratios on a log scale" />
      )}
    </Card>
  );
}
