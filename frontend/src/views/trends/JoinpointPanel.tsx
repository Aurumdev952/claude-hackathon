import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { ArrowDownRight, ArrowRight, ArrowUpRight, GitCommitHorizontal } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Card, chartDetailTabs, InfoHint, Loading, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import type { Joinpoint, Segment } from "@/api/types";
import { fmt, int, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { Empty, Key, tipHead, tipNote, tipRow, usePalette, whiskerSeries, chartBase } from "./kit";
import { AGE_LABEL, Band, jpId, SEX_LABEL, specKey, useGeoNames, useJp, useJpList, useSeries } from "./api";

export function parseJp(id: string) {
  const [geo, sex, age, def] = id.split("|");
  return { geo, sex, age, def };
}

export function jpLabel(id: string, names: Record<string, string>) {
  const p = parseJp(id);
  const geo = p.geo === "NATIONAL" ? "National" : names[p.geo] ?? p.geo;
  return [geo, AGE_LABEL[p.age as Band] ?? p.age, SEX_LABEL[p.sex as "M"] ?? ""].filter(Boolean).join(", ");
}

export function TrendChip({ s }: { s: Pick<Segment, "apc" | "significant"> }) {
  if (!s.significant) return <StatusChip status="neutral" icon={<ArrowRight size={11} aria-hidden />} label="Not significant" />;
  return s.apc > 0
    ? <StatusChip status="serious" icon={<ArrowUpRight size={11} aria-hidden />} label="Rising" />
    : <StatusChip status="good" icon={<ArrowDownRight size={11} aria-hidden />} label="Falling" />;
}

/** Trend direction as text with an arrow (no pill): rising in signal text, falling in green text, otherwise muted. */
export function TrendText({ s }: { s: Pick<Segment, "apc" | "significant"> }) {
  if (!s.significant) return <span className="inline-flex items-center gap-1 text-muted"><ArrowRight size={13} aria-hidden />Not significant</span>;
  return s.apc > 0
    ? <span className="inline-flex items-center gap-1 text-signal-text"><ArrowUpRight size={13} aria-hidden />Rising</span>
    : <span className="inline-flex items-center gap-1 text-tone-success"><ArrowDownRight size={13} aria-hidden />Falling</span>;
}

export function JoinpointPanel() {
  const f = useFilters();
  const { series, focus } = useSeries();
  const { names } = useGeoNames();
  const pal = usePalette();
  const list = useJpList();
  const avail = useMemo(() => (list.data?.data ?? []).map((x) => x.series_id).filter((s) => s.endsWith(`|${f.caseDef}`)), [list.data, f.caseDef]);
  const focusSpec = series.find((s) => specKey(s) === focus);
  const wanted = focusSpec ? jpId(focusSpec, f.caseDef) : `NATIONAL|ALL|<50|${f.caseDef}`;
  const [sel, setSel] = useState(wanted);
  useEffect(() => setSel(wanted), [wanted]);
  const fitted = avail.includes(sel);
  const q = useJp(list.data && !fitted ? null : sel);
  const color = focusSpec && jpId(focusSpec, f.caseDef) === sel ? pal.series[focusSpec.slot] : pal.series[0];
  const jp = q.data?.data;

  const groups = useMemo(() => {
    const nat = avail.filter((s) => s.startsWith("NATIONAL|"));
    const prov = avail.filter((s) => !s.startsWith("NATIONAL|") && !s.split("|")[0].includes("-"));
    const dist = avail.filter((s) => s.split("|")[0].includes("-"));
    return [{ label: "National", ids: nat }, { label: "Provinces", ids: prov }, { label: "Districts", ids: dist }];
  }, [avail]);

  const method = "ln(ASR) = β0 + β1·year + Σ δk·(year − τk)+, weighted least squares (weights 1/Var(ln ASR)). 0–2 joinpoints at integer years, exhaustive grid search, weighted BIC selects the model. APC = 100·(e^slope − 1) with t-based 95% CI; AAPC = duration-weighted mean slope over the last 10 years.";
  const last = jp?.segments[jp.segments.length - 1];
  return (
    <Card
      title="Joinpoint regression" icon={<GitCommitHorizontal size={16} />}
      detail={jp ? { tabs: chartDetailTabs({ table: <SegTable jp={jp} />, method: <><p>Log-linear segments fitted to the annual ASR; the current partial year is excluded. Pick any fitted national, province or district series.</p><p className="mt-2">{method}</p></>,
        notes: `${jp.n_joinpoints ?? 0} joinpoint${jp.n_joinpoints === 1 ? "" : "s"} selected by weighted BIC. * means the 95% CI excludes 0.` }), defaultTab: "table" } : undefined} detailLabel="Joinpoint: view as table"
      actions={
        <select className="bg-tile rounded-full pl-4 pr-2 h-9 text-ink text-[13px] max-w-[220px] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal cursor-pointer" value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Joinpoint series">
          {!fitted && <option value={sel}>{jpLabel(sel, names)} (not fitted)</option>}
          {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.ids.map((id) => <option key={id} value={id}>{jpLabel(id, names)}</option>)}</optgroup>)}
        </select>
      }
    >
      {!fitted && list.data ? (
        <Empty h={300}><span className="inline-flex items-center gap-1">Not fitted for this series
          <InfoHint content="Joinpoint is fitted each run for national series (all ages, men, women, <50, 50–64, 65+), every province and every district (all ages, confirmed + probable). Pick one from the list." label="About fitted series" /></span></Empty>
      ) : q.error ? <ErrorNote error={q.error} /> : !jp ? <Loading h={300} /> : (
        <>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3 mb-3">
            {jp.segments.map((sg) => (
              <div key={sg.segment_no} className="min-w-0" title={`${sg.start_year}–${sg.end_year}: APC ${signed(sg.apc, 1, "%")} (95% CI ${fmt(sg.apc_lci, 1)} to ${fmt(sg.apc_uci, 1)})`}>
                <div className="text-micro text-muted tabular">{sg.start_year}–{sg.end_year}</div>
                <div className="flex items-baseline gap-2 mt-0.5"><span className="text-[22px] leading-7 font-medium tracking-[-0.01em] tabular">{signed(sg.apc, 1, "%")}</span><span className="text-micro"><TrendText s={sg} /></span></div>
              </div>
            ))}
            {last && jp.aapc_last10.value !== null && (
              <div className="ml-auto text-right">
                <div className="text-micro text-muted">Average, last 10 years</div>
                <div className="text-[22px] leading-7 font-medium tracking-[-0.01em] tabular mt-0.5">{signed(jp.aapc_last10.value, 1, "%")}</div>
              </div>
            )}
          </div>
          <JpChart jp={jp} color={color} />
          <div className="flex items-center gap-5 flex-wrap mt-2">
            <Key color={color} kind="dot" label="Observed ± 95% CI" />
            <Key color={color} label="Fitted segments" />
            <Key color={pal.ink.muted} label="Joinpoint" />
          </div>
        </>
      )}
    </Card>
  );
}

function JpChart({ jp, color }: { jp: Joinpoint; color: string }) {
  const pal = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase();
    const k = pal.ink;
    const obs = jp.observed.filter((o) => o.asr !== null);
    const fit = jp.fitted;
    const fitAt = (y: number) => {
      const i = fit.findIndex((p) => p.year >= y);
      if (i <= 0) return fit[0]?.asr ?? 0;
      const a = fit[i - 1], c = fit[i];
      return a.asr + ((c.asr - a.asr) * (y - a.year)) / (c.year - a.year);
    };
    const joins = jp.segments.slice(1).map((s) => s.start_year);
    // Keep the axis on the data: zero-case years have unbounded upper CIs, so whiskers are clipped at 1.6x the largest estimate.
    const peak = Math.max(...obs.map((o) => o.asr ?? 0), ...fit.map((p) => p.asr));
    const yMax = niceCeil(Math.max(peak * 1.6, ...obs.filter((o) => (o.cases ?? 0) >= 5).map((o) => o.uci ?? 0)) , peak * 1.6);
    const y0 = Math.min(...jp.observed.map((o) => o.year)), y1 = Math.max(...jp.observed.map((o) => o.year));
    return {
      ...b,
      grid: { left: 44, right: 18, top: 34, bottom: 26 },
      xAxis: { ...b.xAxis, type: "value", min: y0 - 0.4, max: y1 + 0.4, interval: 1, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => (Number.isInteger(v) ? String(v) : "") } },
      yAxis: { ...b.yAxis, type: "value", min: 0, max: yMax, name: "ASR per 100,000" },
      tooltip: {
        ...b.tooltip, trigger: "axis",
        formatter: (ps: any) => {
          const yr = Math.round(ps[0]?.axisValue);
          const o = jp.observed.find((x) => x.year === yr);
          const fv = fit.find((x) => x.year === yr);
          const seg = jp.segments.find((s) => yr >= s.start_year && yr <= s.end_year);
          return tipHead(String(yr)) +
            (o ? tipRow(color, "Observed", fmt(o.asr, 1), o.lci !== null ? `(${fmt(o.lci, 1)}–${fmt(o.uci, 1)})` : "") : "") +
            (fv ? tipRow(null, "Fitted", fmt(fv.asr, 1)) : "") +
            (o ? tipRow(null, "Cases", o.cases > 0 && o.cases < 5 ? "<5" : int(o.cases)) : "") +
            (seg ? tipRow(null, `Segment ${seg.segment_no} APC`, `${signed(seg.apc, 1, "%")}`, `(${fmt(seg.apc_lci, 1)} to ${fmt(seg.apc_uci, 1)})`) : "") +
            (o?.partial_year ? tipNote("Year to date, excluded from the fit.") : o?.coverage_flag ? tipNote("Low EMR coverage year.") : "");
        },
      },
      series: [
        whiskerSeries("ci", obs.map((o) => ({ a: o.year, lo: o.lci, hi: o.uci })), pal.mode === "dark" ? "rgba(230,236,238,0.28)" : "rgba(27,36,48,0.28)", { cap: 3, width: 1 }),
        {
          type: "line", name: "fitted", data: fit.map((p) => [p.year, p.asr]), showSymbol: false, lineStyle: { width: 2.5, color }, itemStyle: { color }, z: 3,
          markLine: joins.length ? {
            silent: true, symbol: "none", lineStyle: { color: k.muted, width: 1, type: "solid" },
            label: { color: k.secondary, fontSize: 10.5, formatter: (p: any) => `Joinpoint ${p.value}`, position: "end", distance: 4 },
            data: joins.map((y) => ({ xAxis: y })),
          } : undefined,
          markPoint: {
            silent: true, symbol: "rect", symbolSize: 0,
            data: jp.segments.map((s) => ({
              coord: [(s.start_year + s.end_year) / 2, fitAt((s.start_year + s.end_year) / 2)],
              label: { show: true, position: "top", distance: 10, color: k.primary, fontSize: 11, fontWeight: 600, formatter: `${signed(s.apc, 1, "%")}/yr${s.significant ? "*" : ""}` },
            })),
          },
        } as any,
        {
          type: "scatter", name: "observed", z: 4, symbolSize: 7,
          data: obs.map((o) => ({ value: [o.year, o.asr], itemStyle: o.partial_year ? { color: k.surface, borderColor: color, borderWidth: 1.5 } : { color, opacity: o.coverage_flag ? 0.45 : 1, borderColor: k.surface, borderWidth: 1.5 } })),
        },
      ],
    } as EChartsOption;
  }, [jp, color, pal]);
  return <EChart option={option} height={318} ariaLabel={`Joinpoint fit for ${jp.series_id}`} />;
}

function niceCeil(v: number, cap: number) {
  const x = Math.min(v, Math.max(cap, 1));
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= x) ?? x;
}

function SegTable({ jp }: { jp: Joinpoint }) {
  const a = jp.aapc_last10;
  const aSig = a.lci !== null && a.uci !== null && (a.lci > 0 || a.uci < 0);
  return (
    <table className="w-full text-xs tabular">
      <thead>
        <tr className="text-micro text-muted border-b border-hairline">
          <th className="text-left font-semibold py-1.5 pr-2">Segment</th><th className="text-left font-semibold">Years</th>
          <th className="text-right font-semibold">APC</th><th className="text-right font-semibold pr-3">95% CI</th><th className="text-left font-semibold">Trend</th>
        </tr>
      </thead>
      <tbody>
        {jp.segments.map((s) => (
          <tr key={s.segment_no} className="border-b border-hairline">
            <td className="py-1.5">{s.segment_no}</td><td>{s.start_year}–{s.end_year}</td>
            <td className="text-right font-semibold">{signed(s.apc, 1, "%")}</td>
            <td className="text-right text-muted pr-3">{fmt(s.apc_lci, 1)} to {fmt(s.apc_uci, 1)}</td>
            <td><TrendText s={s} /></td>
          </tr>
        ))}
        <tr className="bg-tile">
          <td className="py-1.5 font-semibold" colSpan={2}>AAPC, last 10 years</td>
          <td className="text-right font-semibold">{signed(a.value, 1, "%")}</td>
          <td className="text-right text-muted pr-3">{fmt(a.lci, 1)} to {fmt(a.uci, 1)}</td>
          <td>{a.value !== null && <TrendText s={{ apc: a.value, significant: aSig }} />}</td>
        </tr>
      </tbody>
      <caption className="caption-bottom text-left text-micro text-muted pt-2">
        {jp.n_joinpoints ?? 0} joinpoint{jp.n_joinpoints === 1 ? "" : "s"} selected by weighted BIC. * 95% CI excludes 0.
      </caption>
    </table>
  );
}

