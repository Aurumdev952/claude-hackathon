import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { BarChart3, BookOpen, LineChart, Table2 } from "lucide-react";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { DataTable, DetailModal, Loading, StatTile, type DetailTab } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int } from "@/lib/format";
import { CATEGORICAL, HUE, ink } from "@/lib/viz";
import { chartBase, tipHead, tipRow } from "../trends/kit";
import { useBacktest, type BacktestAll } from "./api";
import { pctFmt, Swatch } from "./kit";

const geoName = (sid: string) => {
  const g = sid.split("|")[0];
  return ({ NATIONAL: "National", KGL: "Kigali", NOR: "Northern", SOU: "Southern", EAS: "Eastern", WES: "Western" } as Record<string, string>)[g] ?? g;
};

/** Backtest detail (modal): accuracy by horizon, forecast vs actual for each rolling origin, the per-series table. */
export function BacktestModal({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  const q = useBacktest(isOpen);
  const d = q.data?.data;
  const tabs: DetailTab[] = d ? [
    { key: "accuracy", label: "Accuracy", icon: <BarChart3 size={13} aria-hidden />, content: <Accuracy d={d} /> },
    { key: "tracking", label: "Forecast vs actual", icon: <LineChart size={13} aria-hidden />, content: <Tracking d={d} /> },
    { key: "table", label: "Table", icon: <Table2 size={13} aria-hidden />, content: (
      <div className="overflow-auto max-h-[60vh]">
        <DataTable ariaLabel="Backtest accuracy by series" rows={d.by_series} columns={[
          { key: "series_id", label: "Series", fmt: (v) => geoName(String(v)) },
          { key: "mape", label: "MAPE", num: true, fmt: (v) => `${fmt(v, 1)}%` },
          { key: "cov80", label: "In 80% band", num: true, fmt: (v) => pctFmt(v) },
          { key: "cov95", label: "In 95% band", num: true, fmt: (v) => pctFmt(v) },
          { key: "crps", label: "CRPS (scaled)", num: true, fmt: (v) => fmt(v, 3) },
          { key: "n", label: "Forecasts", num: true }]} />
      </div>) },
    { key: "method", label: "Method", icon: <BookOpen size={13} aria-hidden />, content: (
      <div className="max-w-[680px] text-[14px] leading-[22px] text-ink/90 flex flex-col gap-3">
        <p>Rolling-origin backtest: the forecast model is refitted on the registry up to each origin year ({d.summary.origins.join(", ")}) and asked to forecast the next five years, which are then compared with what the registry recorded.</p>
        <p><b>MAPE</b> is the mean absolute percentage error of the forecast mean. <b>Coverage</b> is the share of actual values that fell inside the 80% and 95% intervals; well-calibrated intervals cover about 80% and 95%. <b>CRPS</b> scores the whole predictive distribution, scaled by the actual (lower is better).</p>
        <p className="text-muted">Synthetic registry. A small number of origins means coverage is estimated from few forecasts per horizon.</p>
      </div>) },
  ] : [];
  return (
    <DetailModal isOpen={isOpen} onOpenChange={onOpenChange} title="Forecast backtest" icon={<BarChart3 size={17} />} size="4xl"
                 subtitle={d ? `${d.summary.n} past forecasts from ${d.summary.origins.length} origins, synthetic registry` : undefined}
                 tabs={tabs.length ? tabs : undefined}>
      {!d ? (q.error ? <ErrorNote error={q.error} /> : <Loading h={360} label="Loading backtests" />) : undefined}
    </DetailModal>
  );
}

function Accuracy({ d }: { d: BacktestAll }) {
  const m = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase(), k = ink(), h = HUE[m];
    return {
      ...b, grid: { left: 44, right: 16, top: 24, bottom: 34 },
      xAxis: { ...b.xAxis, type: "category", data: d.by_horizon.map((x) => `${x.horizon} yr`), name: "Years ahead", nameLocation: "middle", nameGap: 26 },
      yAxis: { ...b.yAxis, type: "value", name: "MAPE %", min: 0 },
      tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => {
        const x = d.by_horizon[ps[0].dataIndex];
        return tipHead(`${x.horizon} year${x.horizon > 1 ? "s" : ""} ahead`) + tipRow(h.sky, "MAPE", `${fmt(x.mape, 1)}%`)
          + tipRow(null, "In 80% band", pctFmt(x.cov80)) + tipRow(null, "In 95% band", pctFmt(x.cov95)) + tipRow(null, "Forecasts", String(x.n));
      } },
      series: [{ type: "bar", data: d.by_horizon.map((x) => x.mape), barWidth: 28, itemStyle: { color: h.sky, borderRadius: [6, 6, 0, 0] },
                 label: { show: true, position: "top", color: k.secondary, fontSize: 11, formatter: (p: any) => `${fmt(p.value, 1)}%` } }],
    } as EChartsOption;
  }, [d, m]);
  const s = d.summary;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <StatTile label="Mean error (MAPE)" value={`${fmt(s.mape, 1)}%`} sub="All series and horizons" />
        <StatTile label="Inside 80% band" value={pctFmt(s.cov80)} sub="Target about 80%" />
        <StatTile label="Inside 95% band" value={pctFmt(s.cov95)} sub="Target about 95%" />
        <StatTile label="CRPS" value={fmt(s.crps, 3)} sub="Scaled, lower is better" />
      </div>
      <div className="rounded-tile bg-tile/60 px-3 pt-2">
        <EChart option={option} height={260} ariaLabel="Backtest error by forecast horizon" />
      </div>
      <p className="text-label font-normal text-muted">Error grows with the horizon, as it should. Intervals that cover less than their nominal level are too narrow; read the 2031 band as a lower bound on uncertainty.</p>
    </div>
  );
}

function Tracking({ d }: { d: BacktestAll }) {
  const m = useThemeMode();
  const sid = d.by_series.find((x) => x.series_id.startsWith("NATIONAL|"))?.series_id ?? d.by_series[0]?.series_id;
  const rows = d.rows.filter((r) => r.series_id === sid);
  const origins = [...new Set(rows.map((r) => r.origin_year))].sort();
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase(), k = ink();
    const cat = CATEGORICAL[m];
    const actual = new Map<number, number>();
    rows.forEach((r) => actual.set(r.year, r.actual));
    const years = [...actual.keys()].sort();
    return {
      ...b, grid: { left: 52, right: 18, top: 20, bottom: 30 },
      xAxis: { ...b.xAxis, type: "value", min: Math.min(...origins), max: Math.max(...years), interval: 1, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => String(v) } },
      yAxis: { ...b.yAxis, type: "value", scale: true, axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => int(v) } },
      tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => {
        const yr = Math.round(ps[0].axisValue);
        return tipHead(String(yr)) + (actual.has(yr) ? tipRow(k.primary, "Recorded", int(actual.get(yr))) : "")
          + origins.map((o, i) => { const r = rows.find((x) => x.origin_year === o && x.year === yr); return r ? tipRow(cat[i], `Forecast from ${o}`, `${int(r.forecast)} (${fmt(r.mape, 1)}% off)`) : ""; }).join("");
      } },
      series: [
        { type: "line", name: "Recorded", data: years.map((y) => [y, actual.get(y)]), symbolSize: 6, lineStyle: { width: 2, color: k.primary }, itemStyle: { color: k.primary } },
        ...origins.map((o, i) => ({ type: "line", name: `From ${o}`, data: rows.filter((r) => r.origin_year === o).map((r) => [r.year, r.forecast]),
          symbolSize: 5, lineStyle: { width: 2, color: cat[i], type: [5, 4] }, itemStyle: { color: cat[i] } })),
      ],
    } as EChartsOption;
  }, [rows, origins, m]); // eslint-disable-line react-hooks/exhaustive-deps
  const cat = CATEGORICAL[m];
  const tr = d.tracking.filter((t) => t.series_id === sid || t.series_id.startsWith("NATIONAL|"));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <Swatch kind="line" color={ink().primary} label="Recorded (registry)" />
        {origins.map((o, i) => <Swatch key={o} kind="dash" color={cat[i]} label={`Forecast made in ${o}`} />)}
      </div>
      <EChart option={option} height={300} ariaLabel={`Past national forecasts against recorded cases, origins ${origins.join(", ")}`} />
      <div>
        <h3 className="text-[15px] font-semibold text-ink mb-1">Live tracking</h3>
        {tr.length ? (
          <DataTable ariaLabel="Forecast against new actuals" rows={tr} columns={[
            { key: "period", label: "Year", fmt: (v) => String(v).slice(0, 4) },
            { key: "forecast_mean", label: "Forecast", num: true, fmt: (v) => int(v) },
            { key: "actual", label: "Recorded", num: true, fmt: (v) => int(v) },
            { key: "abs_pct_error", label: "Error", num: true, fmt: (v) => (v === null ? "—" : `${fmt(v, 1)}%`) },
            { key: "in_band80", label: "In 80% band", fmt: (v) => (v === null ? "—" : v ? "Yes" : "No") }]} />
        ) : (
          <p className="text-label font-normal text-muted">No forecast year has been completed in simulated time yet. As the clock passes 31 December, each year's forecast is compared here with what the registry records.</p>
        )}
      </div>
    </div>
  );
}
