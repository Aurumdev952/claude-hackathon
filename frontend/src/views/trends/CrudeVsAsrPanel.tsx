import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { Scale } from "lucide-react";
import { AnimatedNumber, Card, chartDetailTabs, DataTable, Loading, Seg } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import type { RateRow } from "@/api/types";
import { fmt, int } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { bandSeries, Empty, Key, tipHead, tipNote, tipRow, usePalette, chartBase } from "./kit";
import { AGE_LABEL, SEX_LABEL, useNationalRates } from "./api";

type Row = { year: number; cases: number; py: number; asr: number; lci: number; uci: number; low: boolean };

/** INS-7: crude counts rise with EMR roll-out; person-time ASR does not. Indexed to a base year, or small multiples — never two y-scales. */
export function CrudeVsAsrPanel() {
  const f = useFilters();
  const pal = usePalette();
  const q = useNationalRates(f.sex, f.ageBand, f.caseDef);
  const [view, setView] = useState<"index" | "multiples">("index");
  const rows: Row[] = useMemo(() => (q.data?.data ?? [])
    .filter((r: RateRow) => !r.partial_year && !r.suppressed && +r.period >= f.yearFrom && +r.period <= f.yearTo && r.asr !== null && r.cases !== null)
    .map((r) => ({ year: +r.period, cases: r.cases!, py: r.population, asr: r.asr!, lci: r.asr_lci!, uci: r.asr_uci!, low: !!r.coverage_flag })), [q.data, f.yearFrom, f.yearTo]);
  const years = rows.map((r) => r.year);
  const [baseYear, setBaseYear] = useState<number | null>(null);
  const by = baseYear !== null && years.includes(baseYear) ? baseYear : years[0];
  const b0 = rows.find((r) => r.year === by);
  const cmpYear = years.includes(2019) && by < 2019 ? 2019 : years[years.length - 1];
  const b1 = rows.find((r) => r.year === cmpYear);
  // the rate (the honest measure) wears the data hue; counts and person-years are context in ink and grey
  const C = { cases: pal.series[2], py: pal.series[3], asr: pal.series[0] };
  const who = [AGE_LABEL[f.ageBand], SEX_LABEL[f.sex]].filter(Boolean).join(", ");

  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length || !b0) return null;
    const b = chartBase();
    const k = pal.ink;
    const x = { ...b.xAxis, type: "value", min: years[0], max: years[years.length - 1], interval: 1, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => (Number.isInteger(v) ? String(v) : "") } };
    const lowMax = Math.max(...rows.filter((r) => r.low).map((r) => r.year), -Infinity);
    const shade = Number.isFinite(lowMax) ? { silent: true, itemStyle: { color: pal.mode === "dark" ? "rgba(230,236,238,0.035)" : "rgba(27,36,48,0.04)" },
      label: { color: k.muted, fontSize: 10, position: "insideTop" }, data: [[{ xAxis: years[0], name: "Low EMR coverage" }, { xAxis: lowMax + 0.5 }]] } : undefined;
    const tip = (yr: number) => {
      const r = rows.find((z) => z.year === yr);
      if (!r) return "";
      return tipHead(String(yr)) +
        tipRow(C.cases, "Recorded cases", int(r.cases), `index ${int((100 * r.cases) / b0.cases)}`) +
        tipRow(C.py, "Person-years on EMR", int(r.py), `index ${int((100 * r.py) / b0.py)}`) +
        tipRow(C.asr, "ASR per 100k", fmt(r.asr, 1), `(${fmt(r.lci, 1)}–${fmt(r.uci, 1)}), index ${int((100 * r.asr) / b0.asr)}`) +
        (r.low ? tipNote("Under 50% of facilities live on the EMR.") : "");
    };
    if (view === "index") {
      const idx = (v: number, b: number) => (100 * v) / b;
      const last = rows[rows.length - 1];
      const ends = [idx(last.cases, b0.cases), idx(last.py, b0.py), idx(last.asr, b0.asr)];
      const off = ends.map(() => 0);
      const ord = ends.map((v, i) => [v, i] as const).sort((a, c) => c[0] - a[0]);
      for (let j = 1; j < ord.length; j++) if (Math.log2(ord[j - 1][0] / ord[j][0]) < 0.4) { off[ord[j - 1][1]] -= 7; off[ord[j][1]] += 7; }
      const endLab = (name: string, v: number) => ({ type: "scatter", data: [[last.year, v]], symbolSize: 0, silent: true, z: 7,
        label: { show: true, position: "right", distance: 8, offset: [0, off[ends.indexOf(v)]], formatter: `${name}  ${int(v)}`, color: k.secondary, fontSize: 11, fontWeight: 500 } });
      const allIdx = rows.flatMap((r) => [idx(r.cases, b0.cases), idx(r.py, b0.py), idx(r.lci, b0.asr)]);
      const ymin = 2 ** Math.floor(Math.log2(Math.max(1, Math.min(...allIdx))));
      return {
        ...b, grid: { left: 46, right: 132, top: 30, bottom: 26 }, xAxis: x,
        yAxis: { ...b.yAxis, type: "log", logBase: 2, min: ymin, max: Math.max(800, 2 ** Math.ceil(Math.log2(Math.max(...rows.map((r) => idx(r.cases, b0.cases)), ...rows.map((r) => idx(r.py, b0.py)))))),
          name: `Index, ${by} = 100, log scale`, axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => int(v) } },
        tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => tip(Math.round(ps[0]?.axisValue)) },
        series: [
          bandSeries("asr-band", rows.map((r) => ({ x: r.year, lo: idx(r.lci, b0.asr), hi: idx(r.uci, b0.asr) })), C.asr, { floor: ymin }),
          { type: "line", name: "cases", data: rows.map((r) => [r.year, idx(r.cases, b0.cases)]), showSymbol: false, lineStyle: { width: 2, color: C.cases }, itemStyle: { color: C.cases },
            markArea: shade,
            markLine: { silent: true, symbol: "none", lineStyle: { color: k.axis, width: 1, type: "solid" }, label: { show: false }, data: [{ yAxis: 100 }] } },
          { type: "line", name: "py", data: rows.map((r) => [r.year, idx(r.py, b0.py)]), showSymbol: false, lineStyle: { width: 2, color: C.py }, itemStyle: { color: C.py } },
          { type: "line", name: "asr", data: rows.map((r) => [r.year, idx(r.asr, b0.asr)]), showSymbol: false, lineStyle: { width: 2.5, color: C.asr }, itemStyle: { color: C.asr } },
          endLab("Cases", idx(last.cases, b0.cases)), endLab("Person-years", idx(last.py, b0.py)), endLab("ASR", idx(last.asr, b0.asr)),
        ] as any,
      } as EChartsOption;
    }
    const grids = [0, 1, 2].map((i) => ({ left: `${5 + i * 33.4}%`, width: "25.5%", top: 34, bottom: 26, containLabel: false }));
    const titles = ["Recorded cases", "Person-years on EMR", "ASR per 100,000"];
    const cats = years.map(String);
    const lowCats = rows.filter((r) => r.low).map((r) => String(r.year));
    const shadeC = lowCats.length ? { silent: true, itemStyle: { color: pal.mode === "dark" ? "rgba(230,236,238,0.035)" : "rgba(27,36,48,0.04)" },
      label: { show: false }, data: [[{ xAxis: cats[0] }, { xAxis: lowCats[lowCats.length - 1] }]] } : undefined;
    return {
      ...b,
      title: titles.map((t, i) => ({ text: t, left: `${1 + i * 33.4}%`, top: 2, textStyle: { color: k.secondary, fontSize: 11, fontWeight: 600 } })),
      grid: grids,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      xAxis: [0, 1, 2].map((i) => ({ ...b.xAxis, type: "category", gridIndex: i, data: cats, boundaryGap: true,
        axisLabel: { ...b.xAxis.axisLabel, interval: 1, hideOverlap: true } })),
      yAxis: [0, 1, 2].map((i) => ({ ...b.yAxis, gridIndex: i, type: "value", min: 0, axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => (i === 1 ? (v >= 1e6 ? `${fmt(v / 1e6, 1)}M` : `${int(v / 1e3)}k`) : int(v)) } })),
      tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => tip(Number(ps[0]?.name ?? ps[0]?.axisValue)) },
      series: [
        { type: "bar", xAxisIndex: 0, yAxisIndex: 0, data: rows.map((r) => ({ value: r.cases, itemStyle: { opacity: r.low ? 0.5 : 1 } })), barMaxWidth: 14, itemStyle: { color: C.cases, borderRadius: [3, 3, 0, 0] }, markArea: shadeC },
        { type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: rows.map((r) => ({ value: r.py, itemStyle: { opacity: r.low ? 0.5 : 1 } })), barMaxWidth: 14, itemStyle: { color: C.py, borderRadius: [3, 3, 0, 0] }, markArea: shadeC },
        bandSeries("asr-band", rows.map((r, i) => ({ x: i, lo: r.lci, hi: r.uci })), C.asr, { xAxisIndex: 2, yAxisIndex: 2 }),
        { type: "line", xAxisIndex: 2, yAxisIndex: 2, data: rows.map((r) => r.asr), showSymbol: true, symbolSize: 4, lineStyle: { width: 2, color: C.asr }, itemStyle: { color: C.asr }, markArea: shadeC },
      ] as any,
    } as EChartsOption;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, view, by, pal]);

  const ratio = (a?: number, b?: number) => (a && b ? b / a : null);
  const method = "Recorded cases only exist where a facility is live on the EMR, so counts grow as facilities go live. The ASR divides by person-years in the catchment of live facilities and standardises age, which removes the roll-out artefact. Indexed view: every measure divided by its base-year value (log scale so equal ratios look equal). Current partial year excluded.";
  const table = <DataTable columns={[{ key: "year", label: "Year", num: true }, { key: "cases", label: "Cases", num: true, fmt: int }, { key: "py", label: "Person-years", num: true, fmt: int },
    { key: "asr", label: "ASR", num: true, fmt: (v) => fmt(v, 1) }, { key: "ci", label: "95% CI", num: true }, { key: "low", label: "Coverage", fmt: (v) => (v ? "low" : "") }]}
    rows={rows.map((r) => ({ ...r, ci: `${fmt(r.lci, 1)}–${fmt(r.uci, 1)}` }))} />;
  return (
    <Card
      title="Counts vs age-standardised rate" icon={<Scale size={16} />}
      detail={{ tabs: chartDetailTabs({ table, method: <><p>National{who ? `, ${who}` : ""}. Recorded cases follow the EMR roll-out; the rate per person-year does not.</p><p className="mt-2">{method}</p></>,
        notes: "Counting raw cases would have told a scary but false story: the extra cases are new facilities joining the EMR, not more cancer." }), defaultTab: "table" }} detailLabel="Counts vs rate: view as table"
      actions={<>
        {view === "index" && years.length > 1 && (
          <label className="flex items-center gap-2 text-label text-muted">Base year
            <select className="bg-tile rounded-full pl-3 pr-1.5 h-9 text-ink text-[13px] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand cursor-pointer" value={by} onChange={(e) => setBaseYear(+e.target.value)} aria-label="Base year">
              {years.slice(0, -1).map((y) => <option key={y}>{y}</option>)}
            </select>
          </label>
        )}
        <Seg label="View" value={view} onChange={setView} options={[{ value: "index", label: "Indexed" }, { value: "multiples", label: "Side by side" }]} />
      </>}
    >
      {q.error ? <ErrorNote error={q.error} /> : !option ? (q.isLoading ? <Loading h={260} /> : <Empty h={260}>No full years in the selected period.</Empty>) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_240px] gap-6 items-start">
          <div className="min-w-0">
            <EChart option={option} height={280} ariaLabel="Recorded cases, person-years and age-standardised rate indexed to a base year" />
            <div className="flex items-center gap-5 flex-wrap mt-2">
              <Key color={C.cases} kind={view === "index" ? "line" : "box"} label="Recorded cases" />
              <Key color={C.py} kind={view === "index" ? "line" : "box"} label="Person-years on EMR" />
              <Key color={C.asr} label="ASR ± 95% CI" />
            </div>
          </div>
          <aside className="flex flex-col gap-2.5" aria-label={`Change ${by} to ${cmpYear}`}>
            <div className="text-label text-muted tabular">From {by} to {cmpYear}</div>
            <Ratio label="Recorded cases" color={C.cases} v={ratio(b0?.cases, b1?.cases)} />
            <Ratio label="Person-years on EMR" color={C.py} v={ratio(b0?.py, b1?.py)} />
            <Ratio label="Age-standardised rate" color={C.asr} v={ratio(b0?.asr, b1?.asr)} />
          </aside>
        </div>
      )}
    </Card>
  );
}

function Ratio({ label, color, v }: { label: string; color: string; v: number | null }) {
  return (
    <div className="rounded-tile bg-tile px-4 py-3">
      <div className="flex items-center gap-1.5 text-micro text-muted"><span className="w-2 h-2 rounded-full" style={{ background: color }} aria-hidden />{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        {v === null ? <span className="text-[24px] leading-8 font-medium">—</span> : <AnimatedNumber value={v} format={(n) => `×${fmt(n, v >= 10 ? 0 : 1)}`} className="text-[24px] leading-8 font-medium tracking-[-0.01em] tabular" />}
        {v !== null && <span className="text-micro text-muted tabular">{v >= 1 ? `+${int((v - 1) * 100)}%` : `−${int((1 - v) * 100)}%`}</span>}
      </div>
    </div>
  );
}
