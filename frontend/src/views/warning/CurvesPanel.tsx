import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { DataTable, ErrorNote, Loading, Panel } from "@/components/ui/Panel";
import { fmt, int } from "@/lib/format";
import { bandSeries, chartBase, Key, tipHead, tipRow, usePalette } from "../trends/kit";
import { CurveRow, useCurves } from "./api";

const METRICS = [
  { id: "gi_visits", title: "GI visits", unit: "per 100 patients per month", nd: 1 },
  { id: "ppi_rx", title: "PPI prescriptions", unit: "% prescribed that month", nd: 1 },
  { id: "mean_hb", title: "Mean haemoglobin", unit: "g/dL, among those tested", nd: 2 },
  { id: "weight", title: "Weight change", unit: "% vs months −24…−19", nd: 1 },
] as const;

/** Aligned pre-diagnostic curves (INS-3): one small multiple per signal, each with its own axis; cases vs matched controls. */
export function CurvesPanel() {
  const q = useCurves();
  const pal = usePalette();
  const rows = q.data?.data ?? [];
  const caseC = pal.series[0], ctrlC = pal.ink.muted;

  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const b = chartBase();
    const k = pal.ink;
    const get = (m: string, g: string) => rows.filter((r) => r.metric === m && r.group === g && r.month_before < 0).sort((a, c) => a.month_before - c.month_before);
    const cols = 4;
    const gw = 100 / cols;
    const grids = METRICS.map((_, i) => ({ left: `${i * gw + 3.2}%`, width: `${gw - 5.6}%`, top: 46, bottom: 30 }));
    const series: any[] = [];
    METRICS.forEach((m, i) => {
      const cs = get(m.id, "case"), ct = get(m.id, "control");
      series.push(bandSeries(`${m.id}-ctrl-band`, ct.map((r) => ({ x: r.month_before, lo: r.lci, hi: r.uci })), "#8696a2", { xAxisIndex: i, yAxisIndex: i, opacity: 0.18 }));
      series.push(bandSeries(`${m.id}-case-band`, cs.map((r) => ({ x: r.month_before, lo: r.lci, hi: r.uci })), caseC, { xAxisIndex: i, yAxisIndex: i, opacity: 0.22 }));
      series.push({ type: "line", name: `${m.id}|control`, xAxisIndex: i, yAxisIndex: i, data: ct.map((r) => [r.month_before, r.value]), showSymbol: false, connectNulls: false, lineStyle: { width: 2, color: ctrlC }, itemStyle: { color: ctrlC }, z: 3 });
      series.push({ type: "line", name: `${m.id}|case`, xAxisIndex: i, yAxisIndex: i, data: cs.map((r) => [r.month_before, r.value]), showSymbol: false, connectNulls: false, lineStyle: { width: 2, color: caseC }, itemStyle: { color: caseC }, z: 4,
        markLine: i === 0 ? undefined : undefined });
      if (i === 0) {
        const lc = cs.find((r) => r.month_before === -9), lt = ct.find((r) => r.month_before === -9);
        const lbl = (r: CurveRow | undefined, text: string, pos: "top" | "bottom") => r ? { type: "scatter", xAxisIndex: 0, yAxisIndex: 0, data: [[r.month_before, r.value]], symbolSize: 0, silent: true, z: 6,
          label: { show: true, position: pos, distance: 8, align: "right", formatter: text, color: k.secondary, fontSize: 11, fontWeight: 500 } } : null;
        series.push(lbl(lc, "Cases", "top"), lbl(lt, "Controls", "top"));
      }
    });
    const findV = (m: string, g: string, mo: number) => rows.find((r) => r.metric === m && r.group === g && r.month_before === mo);
    return {
      ...b,
      title: METRICS.map((m, i) => ({ text: m.title, subtext: m.unit, left: `${i * gw + 3.2}%`, top: 0, itemGap: 3,
        textStyle: { color: k.primary, fontSize: 12, fontWeight: 600 }, subtextStyle: { color: k.muted, fontSize: 10.5 } })),
      grid: grids,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      xAxis: METRICS.map((_, i) => ({ ...b.xAxis, type: "value", gridIndex: i, min: -24, max: 0, interval: 6,
        axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => (v === 0 ? "Dx" : String(v)) } })),
      yAxis: METRICS.map((m, i) => ({ ...b.yAxis, type: "value", gridIndex: i, scale: m.id === "mean_hb", splitNumber: 4,
        axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => (m.id === "mean_hb" ? fmt(v, 1) : int(v)) } })),
      tooltip: {
        ...b.tooltip, trigger: "axis",
        formatter: (ps: any) => {
          const mo = Math.round(ps[0]?.axisValue);
          return tipHead(`${Math.abs(mo)} month${Math.abs(mo) === 1 ? "" : "s"} before diagnosis`) + METRICS.map((m) => {
            const c = findV(m.id, "case", mo), t = findV(m.id, "control", mo);
            return `<div style="margin-top:4px;color:${k.muted};font-size:10.5px">${m.title}</div>` +
              tipRow(caseC, "Cases", c?.value === null || !c ? "—" : fmt(c.value, m.nd), c?.lci !== null && c ? `[${fmt(c.lci, m.nd)}–${fmt(c.uci, m.nd)}]` : "") +
              tipRow(ctrlC, "Controls", t?.value === null || !t ? "—" : fmt(t.value, m.nd), t?.lci !== null && t ? `[${fmt(t.lci, m.nd)}–${fmt(t.uci, m.nd)}]` : "");
          }).join("");
        },
      },
      series: series.filter(Boolean),
    } as EChartsOption;
  }, [rows, pal, caseC, ctrlC]);

  const nCase = rows.find((r) => r.group === "case")?.n, nCtrl = rows.find((r) => r.group === "control")?.n;
  const table = (
    <DataTable columns={[{ key: "month_before", label: "Month", num: true }, { key: "metric", label: "Signal", fmt: (v) => METRICS.find((m) => m.id === v)?.title ?? v },
      { key: "group", label: "Group" }, { key: "value", label: "Value", num: true, fmt: (v) => fmt(v, 2) }, { key: "ci", label: "95% CI", num: true }]}
      rows={rows.filter((r) => r.month_before < 0 && METRICS.some((m) => m.id === r.metric)).map((r) => ({ ...r, ci: r.lci !== null && r.uci !== null ? `${fmt(r.lci, 2)}–${fmt(r.uci, 2)}` : "—" }))} />
  );
  return (
    <Panel
      title="Months before diagnosis · cases vs matched controls"
      subtitle={<>Every patient aligned on their diagnosis date (controls on their matched case's date). {nCase ? <span className="tabular">{int(nCase)} cases · {int(nCtrl)} controls.</span> : null}</>}
      method="Nested case–control within the GI cohort: up to 5 controls per case, matched on sex, age ±5 years, province and cohort entry year, cancer-free at the case's index date (incidence-density sampling). Curves are monthly group means for months −24 to −1; bands are bootstrap 95% CIs (200 resamples). The diagnosis month itself is not plotted."
      table={table}
    >
      {q.error ? <ErrorNote error={q.error} /> : !option ? <Loading h={250} /> : (
        <>
          <EChart option={option} height={250} ariaLabel="Pre-diagnostic signal curves: GI visits, PPI prescriptions, haemoglobin and weight, cases versus controls" />
          <div className="flex items-center gap-4 mt-1">
            <Key color={caseC} label="Cases (gastric cancer)" />
            <Key color={ctrlC} label="Matched controls" />
            <Key color={caseC} kind="band" label="95% CI" />
            <span className="text-[11px] text-fog ml-auto">Each panel has its own y-axis.</span>
          </div>
        </>
      )}
    </Panel>
  );
}
