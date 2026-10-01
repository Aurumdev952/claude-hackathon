import type { EChartsOption } from "echarts";
import type { Segment } from "@/api/types";
import { base, EChart, useThemeMode } from "@/components/charts/EChart";
import { ink, SERIES } from "@/lib/viz";
import { fmt, signed } from "@/lib/format";

export type Obs = { year: number; asr: number | null; lci: number | null; uci: number | null; cases?: number | null; coverage_flag?: string | null; partial_year?: boolean };
export type TrendEvent = { x: number; label: string; kind: "endoscopy" | "emr" };

const flagged = (o: Obs) => !!o.coverage_flag || !!o.partial_year;
const niceCeil = (v: number) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-6)))); const s = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10; return s * p; };

/** Honest rate trend (SPEC §12.1, INS-7): CI band, joinpoint fit, low-coverage and year-to-date points dashed and flagged,
 * off-scale unreliable points clipped with a marker, event annotations along the baseline, EMR roll-out shaded. */
export function AsrTrend({ obs, fitted, segments, events = [], emrSpan, emrLabel, height = 280, compact = false, bare = false, name = "Observed ASR", unit = "per 100,000", ariaLabel }: {
  obs: Obs[]; fitted?: { year: number; asr: number }[] | null; segments?: Segment[] | null; events?: TrendEvent[]; emrSpan?: [number, number] | null; emrLabel?: string;
  height?: number; compact?: boolean; name?: string; unit?: string; ariaLabel: string;
  /** Card-face variant: no legend, no in-chart labels, fit drawn in ink (the legend and notes live in the detail modal). */
  bare?: boolean;
}) {
  const m = useThemeMode();
  const k = ink(), S = SERIES[m];
  const rows = obs.filter((o) => o.asr !== null).sort((a, b) => a.year - b.year);
  if (!rows.length) return <div className="text-xs text-muted flex items-center justify-center" style={{ height }}>No rate data for this selection.</div>;
  const reliable = rows.filter((o) => !flagged(o));
  // Axis follows the estimates, not runaway CIs: CIs past the top are clipped (shown as reaching the edge).
  const ref = reliable.length ? reliable : rows;
  const topUci = Math.max(...ref.map((o) => o.uci ?? o.asr ?? 0)), topAsr = Math.max(...ref.map((o) => o.asr ?? 0), ...(fitted ?? []).map((f) => f.asr));
  const yMax = niceCeil(Math.min(topUci, topAsr * 1.7) * 1.08);
  const clip = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.min(v, yMax));
  const x0 = rows[0].year, x1 = rows[rows.length - 1].year;

  const solid = rows.map((o) => [o.year, flagged(o) ? null : clip(o.asr)]);
  // Dashed series: flagged years plus the neighbouring reliable year so the line connects.
  const dashed = rows.map((o, i) => {
    const near = flagged(o) || (rows[i - 1] && flagged(rows[i - 1])) || (rows[i + 1] && flagged(rows[i + 1]));
    return [o.year, near ? clip(o.asr) : null];
  });
  const offScale = rows.filter((o) => (o.asr ?? 0) > yMax);
  const fit = (fitted ?? []).filter((f) => f.year >= x0 && f.year <= x1);
  const jps = (segments ?? []).slice(1).map((s) => s.start_year);
  const ev = events.filter((e) => e.x >= x0 - 0.5 && e.x <= x1 + 0.5);
  const byYear = (y: number) => ev.filter((e) => Math.floor(e.x) === y);

  if (bare) compact = true;
  const fitC = bare ? (m === "dark" ? "#B4B8C2" : "#3A3F4B") : S[1];
  const L = compact ? { obs: name === "Observed ASR" ? "ASR" : name, ci: "95% CI", fit: "Joinpoint", flag: "Low cov./YTD", endo: "Endoscopy" }
                    : { obs: name, ci: "95% CI", fit: "Joinpoint fit", flag: "Low coverage / YTD", endo: "Endoscopy opened" };
  const b = base();
  const opt: EChartsOption = {
    ...b,
    grid: { left: compact ? 34 : 40, right: compact ? 10 : 18, top: bare ? 10 : compact ? 34 : 36, bottom: 26 },
    legend: { ...(b.legend as object), show: !bare, top: 0, left: 0, right: "auto", itemGap: compact ? 7 : 14, itemWidth: compact ? 9 : 10,
      textStyle: { color: k.secondary, fontSize: compact ? 10 : 11 },
      data: [
        { name: L.obs, icon: "path://M0,2h12v2h-12z" },
        { name: L.ci, icon: "roundRect" },
        ...(fit.length ? [{ name: L.fit, icon: "path://M0,2h12v2h-12z" }] : []),
        ...(rows.some(flagged) ? [{ name: L.flag, icon: "path://M0,2h4v2h-4zM7,2h4v2h-4z" }] : []),
        ...(ev.some((e) => e.kind === "endoscopy") ? [{ name: L.endo, icon: "triangle" }] : []),
      ] as any },
    xAxis: { ...(b.xAxis as object), type: "value", min: x0 - 0.4, max: x1 + 0.4, interval: 1, axisLabel: { color: k.muted, formatter: (v: number) => (Number.isInteger(v) ? String(v) : ""), hideOverlap: true } } as any,
    yAxis: { ...(b.yAxis as object), type: "value", min: 0, max: yMax, name: compact ? "" : unit, nameGap: 8, splitNumber: compact ? 3 : 4 } as any,
    tooltip: {
      ...(b.tooltip as object), trigger: "axis",
      formatter: (ps: any) => {
        const y = Math.round(Array.isArray(ps) ? ps[0]?.value?.[0] ?? ps[0]?.axisValue : ps.value?.[0]);
        const o = rows.find((r) => r.year === y);
        if (!o) return "";
        const f = fit.find((r) => r.year === y);
        const flags = [o.coverage_flag && "Low EMR coverage: the rate is unreliable", o.partial_year && "Year to date (annualised); excluded from joinpoint"].filter(Boolean);
        const evs = byYear(y);
        return `<div style="min-width:180px"><b>${y}</b><br/>${name}: <b>${fmt(o.asr)}</b> <span style="color:${k.muted}">(${fmt(o.lci)}–${fmt(o.uci)})</span>` +
          (o.cases !== undefined && o.cases !== null ? `<br/>Cases: ${o.cases}` : "") + (f ? `<br/>Joinpoint fit: ${fmt(f.asr)}` : "") +
          flags.map((x) => `<br/><span style="color:${k.secondary}">${x}</span>`).join("") +
          evs.map((e) => `<br/><span style="color:${k.secondary}">Endoscopy: ${e.label}</span>`).join("") + "</div>";
      },
    } as any,
    series: ([
      {
        // CI band as polygons (one per contiguous run of years with a CI), clipped at the axis top.
        name: L.ci, type: "custom", silent: true, z: 1, itemStyle: { color: S[0] }, tooltip: { show: false },
        data: rows.map((o) => [o.year, clip(o.lci) ?? NaN, clip(o.uci) ?? NaN]),
        encode: { x: 0, y: [1, 2] },
        renderItem: (params: any, api: any) => {
          if (params.dataIndex !== 0) return null;
          const runs: Obs[][] = [];
          let cur: Obs[] = [];
          rows.forEach((o) => { if (o.lci !== null && o.uci !== null) cur.push(o); else if (cur.length) { runs.push(cur); cur = []; } });
          if (cur.length) runs.push(cur);
          return { type: "group", children: runs.map((run) => ({
            type: "polygon", shape: { points: [...run.map((o) => api.coord([o.year, clip(o.uci)])), ...run.slice().reverse().map((o) => api.coord([o.year, clip(o.lci)]))] },
            style: { fill: S[0], opacity: m === "dark" ? 0.2 : 0.14 },
          })) };
        },
      },
      { name: L.obs, type: "line", data: solid, connectNulls: false, symbol: "circle", symbolSize: compact ? 4 : 5, showSymbol: true, lineStyle: { width: 2, color: S[0] }, itemStyle: { color: S[0] }, z: 5 },
      { name: L.flag, type: "line", data: dashed, connectNulls: false, symbol: "emptyCircle", symbolSize: compact ? 5 : 6,
        lineStyle: { width: 1.6, type: [4, 4], color: S[0], opacity: 0.85 }, itemStyle: { color: S[0], borderColor: S[0] }, z: 4 },
      ...(fit.length ? [{
        name: L.fit, type: "line" as const, data: fit.map((f) => [f.year, clip(f.asr)]), symbol: "none", lineStyle: { width: bare ? 1.5 : 2, color: fitC }, itemStyle: { color: fitC }, z: 6,
        markPoint: jps.length ? { symbol: "diamond", symbolSize: 9, itemStyle: { color: fitC, borderColor: k.surface, borderWidth: 1.5 }, label: { show: false },
          data: jps.map((y) => ({ coord: [y, clip(fit.find((f) => f.year === y)?.asr)], name: `Joinpoint ${y}` })) } : undefined,
      }] : []),
      ...(offScale.length ? [{
        name: "off-scale", type: "scatter" as const, data: offScale.map((o) => [o.year, yMax]), symbol: "triangle", symbolSize: 8, itemStyle: { color: k.muted }, silent: true, tooltip: { show: false },
        label: { show: true, position: "right" as const, color: k.muted, fontSize: 10, formatter: (q: any) => `${fmt(offScale.find((o) => o.year === q.value[0])?.asr)} off scale` },
      }] : []),
      ...(ev.length && !bare ? [{
        name: L.endo, type: "scatter" as const, data: ev.filter((e) => e.kind === "endoscopy").map((e) => ({ value: [e.x, yMax * 0.012], name: e.label })),
        symbol: "triangle", symbolSize: 7, itemStyle: { color: k.secondary }, z: 7, tooltip: { show: false },
      }] : []),
      ...(emrSpan ? [{
        name: "emr", type: "line" as const, data: [], silent: true,
        markArea: { silent: true, itemStyle: { color: m === "dark" ? "rgba(230,236,238,0.045)" : "rgba(27,36,48,0.05)" },
          label: { show: !bare && (!compact || !offScale.length), position: "insideTopLeft" as const, color: k.muted, fontSize: 10, formatter: emrLabel ?? (compact ? "EMR roll-out" : "EMR roll-out: crude counts inflated") },
          data: [[{ xAxis: Math.max(emrSpan[0], x0 - 0.4) }, { xAxis: Math.min(emrSpan[1], x1 + 0.4) }]] as any },
      }] : []),
    ] as any),
  };
  // Direct labels on joinpoint segments (APC), only in the large chart.
  if (!compact && segments?.length && fit.length) {
    (opt.series as any[]).push({
      name: "apc", type: "scatter", silent: true, tooltip: { show: false }, symbolSize: 0,
      data: segments.map((s) => {
        const mid = (s.start_year + s.end_year) / 2;
        const a = fit.find((f) => f.year === Math.round(mid))?.asr ?? 0;
        return { value: [mid, clip(a)], label: { formatter: `APC ${signed(s.apc, 1, "%")}${s.significant ? "*" : ""}` } };
      }),
      label: { show: true, position: "top", distance: 10, color: k.secondary, fontSize: 11, fontWeight: 600 },
    });
  }
  return <EChart option={opt} height={height} ariaLabel={ariaLabel} />;
}

const yearFrac = (d: string) => { const t = new Date(d); return t.getUTCFullYear() + t.getUTCMonth() / 12 + (t.getUTCDate() - 1) / 365; };
/** Annotations for a geography: endoscopy openings as baseline markers; EMR go-live dates as a shaded roll-out span. */
export function annotationsFor(events: { date: string; event_type: string; label: string; geo_code: string }[] | undefined, geo: string | null) {
  const ev = (events ?? []).filter((e) => !geo || e.geo_code === geo);
  const endo: TrendEvent[] = ev.filter((e) => e.event_type === "ENDOSCOPY_OPENED").map((e) => ({ x: yearFrac(e.date), label: e.label.replace(" (Synthetic)", ""), kind: "endoscopy" }));
  const emr = ev.filter((e) => e.event_type === "EMR_GO_LIVE").map((e) => yearFrac(e.date));
  const emrSpan: [number, number] | null = emr.length ? (geo ? [2000, Math.max(...emr)] : [Math.min(...emr), Math.max(...emr)]) : null;
  return { endo, emrSpan, emrLabel: geo ? "Before EMR go-live" : undefined };
}

export function SegmentList({ segments, aapc }: { segments: Segment[]; aapc?: { value: number | null; lci: number | null; uci: number | null } | null }) {
  return (
    <table className="w-full text-[12px] tabular">
      <thead><tr className="text-micro text-muted"><th className="text-left font-medium py-1.5">Years</th><th className="text-right font-medium">Change per year</th><th className="text-right font-medium">95% CI</th><th className="text-right font-medium">Significant</th></tr></thead>
      <tbody>
        {segments.map((s) => (
          <tr key={s.segment_no} className="border-t border-hairline">
            <td className="py-1.5">{s.start_year}–{s.end_year}</td>
            <td className="text-right font-medium">{signed(s.apc, 1, "%")}</td>
            <td className="text-right text-muted">{fmt(s.apc_lci)} to {fmt(s.apc_uci)}</td>
            <td className="text-right">{s.significant ? "Yes" : <span className="text-muted">No</span>}</td>
          </tr>
        ))}
        {aapc && aapc.value !== null && (
          <tr className="border-t border-hairline"><td className="py-1.5 text-muted">Average, 10 years</td><td className="text-right font-medium">{signed(aapc.value, 1, "%")}</td><td className="text-right text-muted">{fmt(aapc.lci)} to {fmt(aapc.uci)}</td><td /></tr>
        )}
      </tbody>
    </table>
  );
}
