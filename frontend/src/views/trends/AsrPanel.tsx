import { useMemo, useRef, useState } from "react";
import type { EChartsOption, SeriesOption } from "echarts";
import { Button, Switch } from "@heroui/react";
import { LineChart, Plus, Target, X } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Card, chartDetailTabs, DataTable, InfoHint, Loading, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
import type { RateRow } from "@/api/types";
import { fmt, int } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { bandSeries, Key, tipHead, tipNote, tipRow, usePalette, yearFrac, chartBase } from "./kit";
import {
  AGE_LABEL, Band, EventRow, Level, MAX_SERIES, SeriesSpec, Sex, seriesLabel, specKey, useEvents, useGeoNames, useRateSeries, useSeries,
} from "./api";

const GRID = { left: 48, right: 112, top: 30, bottom: 26 };

type Pt = { year: number; v: number | null; lo: number | null; hi: number | null; cases: number | null; casesLabel?: string; low: boolean; partial: boolean; suppressed: boolean };

function toPts(rows: RateRow[], metric: "asr" | "crude_rate", y0: number, y1: number): Pt[] {
  return rows.filter((r) => +r.period >= y0 && +r.period <= y1).map((r) => ({
    year: +r.period,
    v: r.suppressed ? null : (r[metric] as number | null),
    lo: r.suppressed || metric !== "asr" ? null : r.asr_lci,
    hi: r.suppressed || metric !== "asr" ? null : r.asr_uci,
    cases: r.cases, casesLabel: r.cases_label, low: !!r.coverage_flag, partial: !!r.partial_year, suppressed: r.suppressed,
  }));
}

export function AsrPanel() {
  const f = useFilters();
  const { series, focus, logScale, setLog, setFocus } = useSeries();
  const { names } = useGeoNames();
  const pal = usePalette();
  const qs = useRateSeries(series, f.caseDef);
  const ev = useEvents();
  const [showEvents, setShowEvents] = useState(true);
  const [hoverEv, setHoverEv] = useState<EventRow | null>(null);
  const metric = f.metric;
  const y0 = f.yearFrom, y1 = Math.max(f.yearTo, f.yearFrom + 1);

  const data = useMemo(() => series.map((s, i) => ({ spec: s, key: specKey(s), color: pal.series[s.slot], pts: qs[i]?.data ? toPts(qs[i].data!.data, metric, y0, y1) : [] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, qs.map((q) => q.dataUpdatedAt).join(), metric, y0, y1, pal]);
  const loading = qs.some((q) => q.isLoading);
  const err = qs.find((q) => q.error)?.error;

  const geoEvents = useMemo(() => {
    const evs = (ev.data?.data ?? []).filter((e) => e.event_type === "ENDOSCOPY_OPENED");
    return evs.filter((e) => series.some((s) => s.level !== "NATIONAL" && (s.geo === e.geo_code || s.geo === e.province_code || e.geo_code.startsWith(s.geo + "-"))));
  }, [ev.data, series]);

  const option = useMemo<EChartsOption>(() => {
    const b = chartBase();
    const k = pal.ink;
    const log = logScale;
    const vals = data.flatMap((d) => d.pts.flatMap((p) => [p.v, p.lo, p.hi])).filter((v): v is number => v !== null && v > 0);
    const minV = vals.length ? Math.min(...vals) : 1, maxV = vals.length ? Math.max(...vals) : 100;
    const logMin = Math.pow(10, Math.floor(Math.log10(minV)));
    const lowYears = (data.find((d) => d.spec.level === "NATIONAL") ?? data[0])?.pts.filter((p) => p.low).map((p) => p.year) ?? [];
    const out: SeriesOption[] = [];
    data.forEach((d) => {
      const flagged = (p?: Pt) => !!p && (p.low || p.partial);
      const v = (p: Pt) => (p.v !== null && (!log || p.v > 0) ? p.v : null);
      const solid = d.pts.map((p) => [p.year, flagged(p) ? null : v(p)]);
      const dashed = d.pts.map((p, i) => [p.year, flagged(p) || flagged(d.pts[i - 1]) || flagged(d.pts[i + 1]) ? v(p) : null]);
      if (metric === "asr") out.push(bandSeries(`${d.key}::band`, d.pts.map((p) => ({ x: p.year, lo: p.lo, hi: p.hi })), d.color, { floor: log ? logMin : 0, opacity: d.key === focus ? 0.2 : 0.1 }));
      const emph = d.key === focus;
      out.push({ type: "line", name: `${d.key}::solid`, data: solid, showSymbol: false, symbolSize: 6, connectNulls: false, z: emph ? 5 : 3,
        lineStyle: { width: emph ? 2.5 : 2, color: d.color }, itemStyle: { color: d.color }, emphasis: { disabled: true } } as any);
      out.push({ type: "line", name: `${d.key}::dashed`, data: dashed, showSymbol: false, connectNulls: false, z: 3,
        lineStyle: { width: 2, color: d.color, type: [4, 4] as any, opacity: 0.85 }, itemStyle: { color: d.color }, emphasis: { disabled: true } } as any);
      const isolated = d.pts.filter((p, i) => v(p) !== null && !p.partial && (i === 0 || v(d.pts[i - 1]) === null) && (i === d.pts.length - 1 || v(d.pts[i + 1]) === null));
      if (isolated.length) out.push({ type: "scatter", name: `${d.key}::iso`, data: isolated.map((p) => [p.year, p.v]), symbolSize: 6, z: 5, silent: true,
        itemStyle: { color: d.color, borderColor: k.surface, borderWidth: 1.5 } } as any);
      const partial = d.pts.filter((p) => p.partial && v(p) !== null);
      if (partial.length) out.push({ type: "scatter", name: `${d.key}::partial`, data: partial.map((p) => [p.year, p.v]), symbol: "circle", symbolSize: 7, z: 6,
        itemStyle: { color: k.surface, borderColor: d.color, borderWidth: 2 }, silent: true } as any);
      if (data.length <= 4) {
        const last = [...d.pts].reverse().find((p) => v(p) !== null);
        if (last) out.push({ type: "scatter", name: `${d.key}::label`, data: [[last.year, last.v]], symbolSize: 0, silent: true, z: 7,
          label: { show: true, position: "right", distance: 10, formatter: seriesLabel(d.spec, names, true), color: k.secondary, fontSize: 11, fontWeight: 500 },
          labelLayout: { hideOverlap: false, moveOverlap: "shiftY" } } as any);
      }
    });
    if (lowYears.length && out[0]) {
      const first = out.find((s: any) => s.type === "line") as any;
      first.markArea = { silent: true, itemStyle: { color: pal.mode === "dark" ? "rgba(230,236,238,0.035)" : "rgba(27,36,48,0.04)" },
        label: { color: k.muted, fontSize: 10, position: "insideTop", distance: 4 },
        data: [[{ xAxis: y0, name: "Low EMR coverage" }, { xAxis: Math.max(...lowYears) + 0.5 }]] };
    }
    if (geoEvents.length && first(out)) {
      first(out)!.markLine = { silent: true, symbol: "none", animation: false, lineStyle: { color: k.axis, width: 1, type: "solid" },
        label: { formatter: (p: any) => p.name, color: k.muted, fontSize: 10, position: "insideEndTop" },
        data: geoEvents.filter((e) => yearFrac(e.date) >= y0 && yearFrac(e.date) <= y1).map((e) => ({ xAxis: yearFrac(e.date), name: `Endoscopy · ${names[e.geo_code] ?? e.geo_code}` })) };
    }
    return {
      ...b,
      grid: GRID,
      xAxis: { ...b.xAxis, type: "value", min: y0, max: y1, interval: 1, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => (Number.isInteger(v) ? String(v) : "") } },
      yAxis: log
        ? { ...b.yAxis, type: "log", logBase: 10, min: logMin, max: Math.pow(10, Math.ceil(Math.log10(maxV * 1.05))), name: `per 100,000 · log scale`,
            minorTick: { show: false }, minorSplitLine: { show: true, lineStyle: { color: k.grid, opacity: 0.5 } },
            axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => (v >= 1 ? int(v) : String(v)) } }
        : { ...b.yAxis, type: "value", min: 0, name: "per 100,000" },
      tooltip: {
        ...b.tooltip, trigger: "axis",
        formatter: (ps: any) => {
          const yr = Math.round(Array.isArray(ps) ? ps[0]?.axisValue : ps?.axisValue);
          const rows = data.map((d) => {
            const p = d.pts.find((x) => x.year === yr);
            if (!p) return "";
            const val = p.v === null ? (p.suppressed ? "suppressed" : "—") : fmt(p.v, 1);
            const ci = p.lo !== null && p.hi !== null ? `${fmt(p.lo, 1)}–${fmt(p.hi, 1)}` : "";
            const cases = p.cases !== null ? `${int(p.cases)} cases` : p.casesLabel ? `${p.casesLabel} cases` : "";
            return tipRow(d.color, seriesLabel(d.spec, names), val, [ci && `[${ci}]`, cases].filter(Boolean).join(" · "));
          }).join("");
          const any = data.flatMap((d) => d.pts.filter((x) => x.year === yr));
          const notes = [any.some((p) => p.low) && "Dashed: under 50% of facilities on the EMR this year.", any.some((p) => p.partial) && "Year to date, annualised.", any.some((p) => p.suppressed) && "Cells under 5 cases are suppressed."].filter(Boolean).join(" ");
          return tipHead(String(yr)) + rows + (notes ? tipNote(notes) : "");
        },
      },
      series: out,
    } as EChartsOption;
    function first(o: SeriesOption[]) { return o.find((s: any) => s.type === "line") as any; }
  }, [data, logScale, metric, focus, names, pal, y0, y1, geoEvents]);

  const table = (
    <DataTable
      columns={[{ key: "series", label: "Series" }, { key: "year", label: "Year", num: true }, { key: "v", label: metric === "asr" ? "ASR" : "Crude rate", num: true, fmt: (v) => fmt(v, 1) },
        { key: "ci", label: "95% CI", num: true }, { key: "cases", label: "Cases", num: true }, { key: "flag", label: "Flags" }]}
      rows={data.flatMap((d) => d.pts.map((p) => ({ series: seriesLabel(d.spec, names), year: p.year, v: p.v, ci: p.lo !== null ? `${fmt(p.lo, 1)}–${fmt(p.hi, 1)}` : "—",
        cases: p.cases ?? p.casesLabel ?? "—", flag: [p.low && "low EMR coverage", p.partial && "YTD annualised", p.suppressed && "suppressed"].filter(Boolean).join(", ") || "" })))}
    />
  );

  const subtitle = <>Per 100,000 person-years, {f.caseDef === "CONFIRMED" ? "confirmed cases" : "confirmed + probable"}. Bands = 95% CI. Click a series to fit its joinpoint below.</>;
  const method = "Direct standardisation to the WHO World Standard Population (18 age groups; age bands use their own re-normalised weights). 95% CI: Fay–Feuer gamma. Denominator = person-years in the catchment of facilities live on the EMR, so years with low EMR coverage (under 50% of facilities live) are dashed. On the log scale equal slopes mean equal % change per year.";
  return (
    <Card
      title={metric === "asr" ? "Age-standardised incidence" : "Crude incidence"} icon={<LineChart size={16} />}
      info={{ about: subtitle, method, notes: "Event rug: dots = EMR go-lives, diamonds = endoscopy units opening; hover or focus one to see it on the chart." }}
      detail={{ tabs: chartDetailTabs({ table, method }), defaultTab: "table" }} detailLabel="View as table"
      actions={<>
        <Switch size="sm" isSelected={showEvents} onValueChange={setShowEvents} aria-label="Event annotations" classNames={{ label: "text-label text-fg-muted" }}>Events</Switch>
        <Seg label="Y scale" value={logScale ? "log" : "lin"} onChange={(v) => setLog(v === "log")} options={[{ value: "log", label: "Log" }, { value: "lin", label: "Linear" }]} />
      </>}
    >
      <SeriesChips focus={focus} setFocus={setFocus} />
      {err ? <ErrorNote error={err} /> : loading && !data.some((d) => d.pts.length) ? <Loading h={340} /> : (
        <div className="relative">
          <EChart option={option} height={340} ariaLabel="Multi-series age-standardised incidence with 95% confidence bands" />
          {hoverEv && <EventGuide e={hoverEv} y0={y0} y1={y1} />}
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap mt-1 mb-1">
        <Key color={pal.ink.secondary} label="Observed" />
        <Key color={pal.ink.secondary} dashed label="Low EMR coverage" />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted"><span className="w-2 h-2 rounded-full border-2" style={{ borderColor: pal.ink.secondary }} />Year to date</span>
      </div>
      {showEvents && <EventRug events={ev.data?.data ?? []} y0={y0} y1={y1} names={names} onHover={setHoverEv} />}
    </Card>
  );
}

/** Vertical guide drawn over the chart while an event in the rug is hovered/focused. */
function EventGuide({ e, y0, y1 }: { e: EventRow; y0: number; y1: number }) {
  const t = (yearFrac(e.date) - y0) / (y1 - y0);
  if (t < 0 || t > 1) return null;
  return (
    <div className="absolute pointer-events-none" style={{ left: GRID.left, right: GRID.right, top: GRID.top, bottom: GRID.bottom }} aria-hidden>
      <div className="absolute top-0 bottom-0 w-px bg-fg/40" style={{ left: `${t * 100}%` }} />
    </div>
  );
}

/** Event annotation layer: EMR go-lives and endoscopy openings on the same x-scale as the chart above. */
function EventRug({ events, y0, y1, names, onHover }: { events: EventRow[]; y0: number; y1: number; names: Record<string, string>; onHover: (e: EventRow | null) => void }) {
  const [tip, setTip] = useState<{ e: EventRow; x: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const rows = [
    { type: "EMR_GO_LIVE", label: "EMR go-live", shape: "dot" },
    { type: "ENDOSCOPY_OPENED", label: "Endoscopy opened", shape: "diamond" },
  ] as const;
  const inRange = events.filter((e) => yearFrac(e.date) >= y0 - 0.02 && yearFrac(e.date) <= y1);
  const show = (e: EventRow | null, el?: HTMLElement) => {
    onHover(e);
    if (!e || !el || !ref.current) return setTip(null);
    const r = ref.current.getBoundingClientRect(), b = el.getBoundingClientRect();
    setTip({ e, x: b.left + b.width / 2 - r.left });
  };
  return (
    <div className="relative border-t border-border/70 pt-1.5" ref={ref} onMouseLeave={() => show(null)}>
      {rows.map((row) => {
        const evs = inRange.filter((e) => e.event_type === row.type);
        return (
          <div key={row.type} className="relative h-[18px]">
            <span className="absolute left-0 top-0.5 text-[10px] text-fg-muted" style={{ width: GRID.left - 4 }}>{row.type === "EMR_GO_LIVE" ? "EMR" : "Scope"}</span>
            <div className="absolute top-0 bottom-0" style={{ left: GRID.left, right: GRID.right }}>
              <div className="absolute left-0 right-0 top-1/2 h-px bg-border" />
              {evs.map((e, i) => {
                const t = Math.max(0, (yearFrac(e.date) - y0) / (y1 - y0));
                return (
                  <button key={i} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1 group focus:outline-none" style={{ left: `${t * 100}%` }}
                          aria-label={`${e.label}, ${e.date}`}
                          onMouseEnter={(x) => show(e, x.currentTarget)} onFocus={(x) => show(e, x.currentTarget)} onBlur={() => show(null)}>
                    <span className={`block ${row.shape === "dot" ? "w-[6px] h-[6px] rounded-full bg-fg-muted/70" : "w-[7px] h-[7px] rotate-45 bg-fg"} group-hover:scale-150 group-focus-visible:scale-150 group-focus-visible:ring-2 ring-accent/60 transition-transform`} />
                  </button>
                );
              })}
            </div>
            <span className="absolute top-0.5 text-[10px] text-fg-muted tabular" style={{ right: 0, width: GRID.right - 10 }}>{evs.length} {row.type === "EMR_GO_LIVE" ? "go-lives" : "openings"}</span>
          </div>
        );
      })}
      {tip && (
        <div className="absolute z-20 -translate-x-1/2 bottom-full mb-1 bg-surface border border-border shadow-float rounded-tile px-2.5 py-1.5 text-[11px] whitespace-nowrap pointer-events-none" style={{ left: tip.x }} role="status">
          <div className="font-semibold">{tip.e.label}</div>
          <div className="text-fg-muted tabular">{new Date(tip.e.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · {names[tip.e.geo_code] ?? tip.e.geo_code}</div>
        </div>
      )}
    </div>
  );
}

function SeriesChips({ focus, setFocus }: { focus: string; setFocus: (k: string) => void }) {
  const { series, remove } = useSeries();
  const { names } = useGeoNames();
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-2 relative" role="list" aria-label="Selected series (legend)">
      {series.map((s) => {
        const k = specKey(s);
        const on = k === focus;
        return (
          <div key={k} role="listitem" className={`inline-flex items-center rounded-full border text-[12px] transition-colors ${on ? "border-accent/40 bg-accent-soft" : "border-border bg-surface-2"}`}>
            <button className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 focus:outline-none focus-visible:ring-2 ring-accent/60 rounded-full" onClick={() => setFocus(k)} aria-pressed={on}
                    title="Fit joinpoint for this series">
              <span className="inline-block w-3.5 h-[3px] rounded-full" style={{ background: pal.series[s.slot] }} aria-hidden />
              <span className={on ? "text-fg font-medium" : "text-fg-muted"}>{seriesLabel(s, names)}</span>
              {on && <Target size={11} className="text-fg-muted" aria-label="joinpoint focus" />}
            </button>
            <button className="pr-2 pl-0.5 py-1 text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-2 ring-accent/60 rounded-full" onClick={() => remove(k)} aria-label={`Remove ${seriesLabel(s, names)}`} disabled={series.length <= 1}>
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11.5px] text-fg-muted hover:text-fg hover:border-fg-muted disabled:opacity-40 focus:outline-none focus-visible:ring-2 ring-accent/60"
              onClick={() => setOpen((v) => !v)} disabled={series.length >= MAX_SERIES} aria-expanded={open}>
        <Plus size={12} /> Add series <span className="tabular text-[10px]">{series.length}/{MAX_SERIES}</span>
      </button>
      {open && <SeriesBuilder onClose={() => setOpen(false)} />}
    </div>
  );
}

function SeriesBuilder({ onClose }: { onClose: () => void }) {
  const f = useFilters();
  const { series, add } = useSeries();
  const { districts, provinces } = useGeoNames();
  const [level, setLevel] = useState<Level>("PROVINCE");
  const [geo, setGeo] = useState<string>("");
  const [sex, setSex] = useState<Sex>(f.sex);
  const [age, setAge] = useState<Band>(f.ageBand);
  const g = level === "NATIONAL" ? "RW" : geo || (level === "PROVINCE" ? provinces[0]?.code : districts[0]?.district_code) || "";
  const dup = series.some((s) => specKey(s) === specKey({ level, geo: g, sex, age }));
  return (
    <div className="absolute left-0 top-full mt-1.5 z-30 bg-surface border border-border shadow-float rounded-tile p-3.5 w-[min(560px,100%)] flex flex-col gap-2.5 text-xs animate-rise" role="dialog" aria-label="Add a series">
      <div className="flex items-center gap-2 flex-wrap">
        <Seg label="Level" value={level} onChange={(v) => { setLevel(v); setGeo(""); }} options={[{ value: "NATIONAL", label: "National" }, { value: "PROVINCE", label: "Province" }, { value: "DISTRICT", label: "District" }]} />
        {level !== "NATIONAL" && (
          <select className="bg-surface-2 border border-border rounded-full px-3 py-1 text-fg text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/60" value={g} onChange={(e) => setGeo(e.target.value)} aria-label={level === "PROVINCE" ? "Province" : "District"}>
            {level === "PROVINCE"
              ? provinces.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)
              : provinces.map((p) => (
                <optgroup key={p.code} label={p.name}>
                  {districts.filter((d) => d.province_code === p.code).map((d) => <option key={d.district_code} value={d.district_code}>{d.name}</option>)}
                </optgroup>
              ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Seg label="Sex" value={sex} onChange={setSex} options={[{ value: "ALL", label: "Both sexes" }, { value: "F", label: "Women" }, { value: "M", label: "Men" }]} />
        <Seg label="Age band" value={age} onChange={setAge} options={(["ALL", "<50", "50-64", "65+"] as Band[]).map((a) => ({ value: a, label: AGE_LABEL[a] }))} />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 flex items-center gap-1">
          {dup ? <StatusChip status="neutral" label="Already plotted" /> : level === "DISTRICT" && (sex !== "ALL" || age !== "ALL") ? <StatusChip status="warning" label="Small cells" title="District × age/sex cells are small: expect wide CIs and suppressed (<5) years." /> : null}
          <InfoHint mode="tooltip" size={13} content="Up to 6 series. Colours stay with each series. District × age/sex cells are small: expect wide CIs and suppressed (<5) years." label="About adding series" />
        </span>
        <Button size="sm" radius="full" variant="flat" onPress={onClose} className="bg-surface-2 border border-border">Cancel</Button>
        <Button size="sm" radius="full" color="primary" isDisabled={dup || !g} startContent={<Plus size={13} />} onPress={() => { add({ level, geo: g, sex, age }); onClose(); }}>Add</Button>
      </div>
    </div>
  );
}
