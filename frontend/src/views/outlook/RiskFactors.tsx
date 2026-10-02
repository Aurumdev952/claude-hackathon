import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { HeartPulse } from "lucide-react";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { Card, chartDetailTabs, DataTable, Loading } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, monthYear } from "@/lib/format";
import { HUE, ink } from "@/lib/viz";
import { alpha, bandSeries, chartBase, tipHead, tipRow, whiskerSeries } from "../trends/kit";
import { INDICATORS, NOWCAST_ORDER, SURVEY_ORDER, useRiskFactors, type RiskFactor, type RfPt } from "./api";
import { Swatch } from "./kit";

const pc = (v: number | null | undefined, nd = 0) => (v === null || v === undefined ? "—" : `${fmt(100 * v, nd)}%`);

/** Risk-factor small multiples: survey rounds with 95% CIs (sky dots and whiskers), the fitted trend, and the projection
 * to 2031 (dashed, sky band). Every panel has its own y-range (they are prevalences of different size) but the same
 * x-axis, so the projection years line up. EMR nowcasts (monthly proxies) follow as three sparkline tiles. */
export function RiskFactorsCard() {
  const q = useRiskFactors();
  const all = q.data?.data ?? [];
  const by = Object.fromEntries(all.map((r) => [r.indicator, r])) as Record<string, RiskFactor>;
  const surveys = SURVEY_ORDER.map((k) => by[k]).filter(Boolean);
  const nowcasts = NOWCAST_ORDER.map((k) => by[k]).filter((r) => r && r.nowcast.length);
  const m = useThemeMode();
  const k = ink(), h = HUE[m];
  const tableRows = surveys.flatMap((r) => [...r.survey.map((p) => ({ ...p, kind: "Survey" })), ...r.forecast.map((p) => ({ ...p, kind: "Projection" }))]
    .map((p) => ({ indicator: INDICATORS[r.indicator]?.label ?? r.indicator, ...p })));
  return (
    <Card title="Risk factors behind the forecast" icon={<HeartPulse size={16} />}
          detail={surveys.length ? { tabs: chartDetailTabs({
            table: <DataTable ariaLabel="Risk-factor surveys and projections" rows={tableRows} columns={[
              { key: "indicator", label: "Indicator" }, { key: "kind", label: "Kind" }, { key: "year", label: "Year", num: true },
              { key: "value", label: "Prevalence", num: true, fmt: (v, r) => (v === null ? (r.label ?? "—") : pc(v, 1)) },
              { key: "lo95", label: "95% CI", num: true, fmt: (_v, r) => (r.lo95 === null ? "—" : `${pc(r.lo95, 1)}–${pc(r.hi95, 1)}`) },
              { key: "n", label: "n", num: true, fmt: (v) => (v === null || v === undefined ? "" : Math.round(v).toLocaleString("en-GB")) }]} />,
            method: "Each indicator is projected with a logit-linear trend fitted to the survey rounds, weighted by their design-effect-adjusted sample sizes; the band is the 95% interval of the trend. Survey points carry their own 95% confidence intervals. EMR nowcasts are monthly proportions among patients seen in the synthetic EMR (cells under 5 suppressed).",
            notes: "Synthetic DHS/STEPS-style surveys. Lagged H. pylori, smoking and salt prevalence feed the scenario model below." }), defaultTab: "table" } : undefined}
          detailLabel="Risk factors: view as table">
      {q.isLoading ? <Loading h={260} /> : q.error ? <ErrorNote error={q.error} /> : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 -mt-1 mb-4">
            <Swatch kind="dot" color={h.sky} label="Survey round, 95% CI" />
            <Swatch kind="line" color={k.secondary} label="Trend" />
            <Swatch kind="dash" color={k.primary} label="Projection to 2031" />
          </div>
          <div role="list" aria-label="Risk factors" className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {surveys.map((r) => <Panel key={r.indicator} r={r} />)}
          </div>
          {nowcasts.length > 0 && (
            <div className="mt-5">
              <div className="text-label text-muted mb-2">EMR nowcast, last 24 months</div>
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                {nowcasts.map((r) => <Nowcast key={r.indicator} r={r} />)}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Panel({ r }: { r: RiskFactor }) {
  const m = useThemeMode();
  const meta = INDICATORS[r.indicator] ?? { label: r.indicator, short: r.indicator };
  const lastS = [...r.survey].reverse().find((p) => p.value !== null);
  const end = r.forecast[r.forecast.length - 1];
  const delta = lastS?.value !== null && lastS?.value !== undefined && end?.value !== null && end?.value !== undefined ? 100 * (end.value - lastS.value) : null;
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase(), k = ink(), h = HUE[m];
    const vals = [...r.survey, ...r.fitted, ...r.forecast].flatMap((p) => [p.lo95, p.hi95, p.value]).filter((v): v is number => v !== null);
    const lo = Math.max(0, Math.min(...vals) - 0.02), hi = Math.min(1, Math.max(...vals) + 0.02);
    const fcLine = [...(r.fitted.length ? [r.fitted[r.fitted.length - 1]] : []), ...r.forecast];
    const tip = (p: RfPt, kind: string) => tipRow(null, kind, pc(p.value, 1), p.lo95 !== null ? `${pc(p.lo95, 1)}–${pc(p.hi95, 1)}` : "");
    return {
      ...b, grid: { left: 34, right: 16, top: 8, bottom: 22 },
      xAxis: { ...b.xAxis, type: "value", min: 2005, max: 2031, interval: 13, axisLabel: { ...b.xAxis.axisLabel, fontSize: 11, margin: 8, alignMinLabel: "left", alignMaxLabel: "right", formatter: (v: number) => String(v) } },
      yAxis: { ...b.yAxis, type: "value", min: lo, max: hi, splitNumber: 2, axisLabel: { ...b.yAxis.axisLabel, fontSize: 11, showMinLabel: false, showMaxLabel: false, formatter: (v: number) => `${Math.round(100 * v)}%` } },
      tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => {
        const yr = Math.round(ps[0].axisValue);
        const s = r.survey.find((p) => p.year === yr), f = r.forecast.find((p) => p.year === yr), t = r.fitted.find((p) => p.year === yr);
        return tipHead(String(yr)) + (s ? tip(s, "Survey") : "") + (f ? tip(f, "Projection") : t ? tipRow(null, "Trend", pc(t.value, 1)) : "");
      } },
      series: [
        bandSeries("band", r.forecast.map((p) => ({ x: p.year, lo: p.lo95, hi: p.hi95 })), h.sky, { opacity: m === "dark" ? 0.22 : 0.2 }),
        { type: "line", data: r.fitted.map((p) => [p.year, p.value]), showSymbol: false, lineStyle: { width: 1.5, color: k.secondary }, z: 3, silent: true },
        { type: "line", data: fcLine.map((p) => [p.year, p.value]), showSymbol: false, lineStyle: { width: 2, color: k.primary, type: [5, 4] }, z: 3, silent: true },
        whiskerSeries("ci", r.survey.map((p) => ({ a: p.year, lo: p.lo95, hi: p.hi95 })), alpha(h.sky, 0.9), { cap: 3, width: 1.25 }),
        { type: "scatter", data: r.survey.filter((p) => p.value !== null).map((p) => [p.year, p.value]), symbolSize: 7, z: 5,
          itemStyle: { color: h.sky, borderColor: k.surface, borderWidth: 1.5 } },
      ],
    } as EChartsOption;
  }, [r, m]);
  return (
    <div role="listitem" aria-label={`${meta.label}: ${pc(lastS?.value)} in ${lastS?.year}, projected ${pc(end?.value)} in ${end?.year}`} className="rounded-tile bg-tile px-4 pt-3.5 pb-2 min-w-0">
      <div className="text-label text-muted truncate">{meta.label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-[22px] leading-7 font-medium tracking-[-0.01em] text-ink tabular">{pc(lastS?.value)}</span>
        <span className="text-micro text-muted tabular whitespace-nowrap">{lastS?.year}, {end ? `${pc(end.value)} by ${end.year}` : ""}</span>
      </div>
      <div className="text-micro text-muted tabular">{delta === null ? "" : Math.abs(delta) < 0.5 ? "Flat to 2031" : `${delta > 0 ? "Up" : "Down"} ${fmt(Math.abs(delta), 1)} points by ${end?.year}`}</div>
      <div className="-mx-1 mt-1"><EChart option={option} height={120} ariaLabel={`${meta.label} survey rounds and projection`} /></div>
    </div>
  );
}

function Nowcast({ r }: { r: RiskFactor }) {
  const m = useThemeMode();
  const h = HUE[m];
  const meta = INDICATORS[r.indicator] ?? { label: r.indicator, short: r.indicator };
  const pts = r.nowcast;
  const last = [...pts].reverse().find((p) => p.value !== null);
  const vals = pts.map((p) => p.value).filter((v): v is number => v !== null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 100, H = 36;
  const xy = pts.map((p, i) => (p.value === null ? null : [(i / Math.max(1, pts.length - 1)) * W, H - 3 - ((p.value - lo) / (hi - lo || 1)) * (H - 6)] as [number, number]));
  const d = xy.reduce((acc, p, i) => (p ? acc + `${acc && xy[i - 1] ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), "");
  return (
    <div className="rounded-tile bg-tile px-4 py-3 min-w-0 flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-label text-muted truncate">{meta.label}</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[20px] leading-7 font-medium text-ink tabular">{last ? pc(last.value) : "<5"}</span>
          <span className="text-micro text-muted tabular">{last ? monthYear(last.period) : ""}{last?.n ? `, n ${Math.round(last.n)}` : ""}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-[42%] h-9 shrink-0 overflow-visible" role="img" aria-label={`${meta.label}, monthly, ${pc(lo)} to ${pc(hi)}`}>
        <path d={d} fill="none" stroke={h.sky} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
