import { lazy, Suspense, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Box, Mountain, MousePointer2, Move3d } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Card, chartDetailTabs, Loading, Seg } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { detectWebGL } from "@/components/three/body/util";
import { DIVERGING, hexToRgb, SEQ_DARK, SEQ_LIGHT } from "@/lib/viz";
import { fmt, int } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { Empty, usePalette, useReducedMotion, chartBase } from "./kit";
import { SurfaceRow, useSurface } from "./api";
import type { Cell } from "./LandscapeScene";

const LandscapeScene = lazy(() => import("./LandscapeScene").then((m) => ({ default: m.LandscapeScene })));

type Mode = "index" | "log" | "rate";
const H = 3.6;
const BASE_YEARS = [2017, 2018];

function lerpHex(stops: string[], t: number): [number, number, number] {
  const c = stops.map(hexToRgb);
  const x = Math.max(0, Math.min(1, t)) * (c.length - 1);
  const i = Math.floor(x), f = x - i, a = c[i], b = c[Math.min(i + 1, c.length - 1)];
  return [0, 1, 2].map((k) => (a[k] + (b[k] - a[k]) * f) / 255) as [number, number, number];
}
const divergingStops = [DIVERGING.neg, DIVERGING.mid, DIVERGING.pos];

type Grid = {
  years: number[]; ages: string[]; youngFrom: number;
  value: (number | null)[][]; raw: (SurfaceRow | undefined)[][];
  heights: number[][]; colors: [number, number, number][][];
  zTicks: { h: number; label: string }[]; refHeight: number | null; ridge: string | null; unit: string; maxV: number;
};

function buildGrid(rows: SurfaceRow[], mode: Mode, y0: number, y1: number, light: boolean): Grid | null {
  const seq = light ? SEQ_LIGHT.slice(1) : SEQ_DARK.slice(1);
  const adult = rows.filter((r) => r.age_index >= 4);
  let years = Array.from(new Set(adult.map((r) => r.year))).sort().filter((y) => y >= y0 && y <= y1);
  if (mode === "index") years = years.filter((y) => y >= BASE_YEARS[0]);
  const ages = Array.from(new Map(adult.map((r) => [r.age_index, r.age_group])).entries()).sort((a, b) => a[0] - b[0]);
  if (years.length < 3 || !ages.length) return null;
  const M = new Map(adult.map((r) => [`${r.year}|${r.age_index}`, r]));
  const raw = ages.map(([ai]) => years.map((y) => M.get(`${y}|${ai}`)));
  const youngFrom = ages.findIndex(([, g]) => parseInt(g, 10) >= 50);
  let value: (number | null)[][], hOf: (v: number) => number, cOf: (v: number) => [number, number, number], zTicks: Grid["zTicks"], refHeight: number | null = null, unit: string;
  const maxRate = Math.max(1, ...adult.filter((r) => years.includes(r.year)).map((r) => r.rate_smoothed));
  if (mode === "index") {
    const baseOf = ages.map(([ai]) => {
      const b = BASE_YEARS.map((y) => M.get(`${y}|${ai}`)?.rate_smoothed ?? 0);
      const m = b.reduce((s, x) => s + x, 0) / b.length;
      return m > 0 ? m : null;
    });
    value = raw.map((r, i) => r.map((x) => (x && baseOf[i] ? (100 * x.rate_smoothed) / baseOf[i]! : null)));
    const top = 250;
    hOf = (v) => (Math.min(top, Math.max(0, v)) / top) * H;
    cOf = (v) => lerpHex(divergingStops, 0.5 + Math.max(-0.5, Math.min(0.5, (v - 100) / 200)));
    zTicks = [50, 100, 150, 200, 250].map((v) => ({ h: hOf(v), label: String(v) }));
    refHeight = hOf(100);
    unit = `index, ${BASE_YEARS.join("–")} = 100`;
  } else if (mode === "log") {
    const top = Math.log10(maxRate + 1);
    value = raw.map((r) => r.map((x) => (x ? x.rate_smoothed : null)));
    hOf = (v) => (Math.log10(Math.max(0, v) + 1) / top) * H;
    cOf = (v) => lerpHex(seq, Math.log10(Math.max(0, v) + 1) / top);
    zTicks = [1, 10, 100, 1000].filter((v) => v <= maxRate * 1.05).map((v) => ({ h: hOf(v), label: String(v) }));
    unit = "per 100,000, log height";
  } else {
    value = raw.map((r) => r.map((x) => (x ? x.rate_smoothed : null)));
    hOf = (v) => (Math.max(0, v) / maxRate) * H;
    cOf = (v) => lerpHex(seq, v / maxRate);
    const step = maxRate > 300 ? 100 : 50;
    zTicks = Array.from({ length: Math.floor(maxRate / step) }, (_, i) => (i + 1) * step).map((v) => ({ h: hOf(v), label: String(v) }));
    unit = "per 100,000";
  }
  const fill = mode === "index" ? 100 : 0;
  const heights = value.map((r) => r.map((v) => hOf(v ?? fill)));
  const colors = value.map((r) => r.map((v) => cOf(v ?? fill)));
  let ridge: string | null = null;
  if (mode === "index") {
    const last = years.length - 1;
    const youngIdx = value.slice(0, youngFrom).map((r) => r[last]).filter((v): v is number => v !== null);
    const oldIdx = value.slice(youngFrom).map((r) => r[last]).filter((v): v is number => v !== null);
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    if (youngIdx.length && oldIdx.length) ridge = `Under 50 ${avg(youngIdx) >= 100 ? "+" : ""}${int(avg(youngIdx) - 100)}% vs 50 and over ${avg(oldIdx) >= 100 ? "+" : ""}${int(avg(oldIdx) - 100)}% since ${BASE_YEARS.join("–")}`;
  }
  const maxV = Math.max(...value.flat().filter((v): v is number => v !== null));
  return { years, ages: ages.map((a) => a[1]), youngFrom, value, raw, heights, colors, zTicks, refHeight, ridge, unit, maxV };
}

export function LandscapePanel() {
  const f = useFilters();
  const q = useSurface(f.caseDef);
  const [mode, setMode] = useState<Mode>("index");
  const webgl = useMemo(detectWebGL, []);
  const [view, setView] = useState<"3d" | "heat">(webgl ? "3d" : "heat");
  const [hover, setHover] = useState<Cell | null>(null);
  const reduced = useReducedMotion();
  const pal = usePalette();
  const light = pal.mode === "light";
  const grid = useMemo(() => (q.data ? buildGrid(q.data.data, mode, f.yearFrom, f.yearTo, light) : null), [q.data, mode, f.yearFrom, f.yearTo, light]);

  const fmtV = (v: number | null) => (v === null ? "—" : mode === "index" ? int(v) : fmt(v, 1));
  const table = grid ? (
    <table className="w-full text-[11px] tabular">
      <caption className="text-left text-label text-muted mb-1.5">{mode === "index" ? `Age-specific rate as an index (${BASE_YEARS.join("–")} = 100)` : "Age-specific rate per 100,000 (3-year smoothed)"}</caption>
      <thead className="sticky top-0 bg-tile"><tr><th className="text-left py-2 px-2 text-muted font-medium">Age</th>{grid.years.map((y) => <th key={y} className="text-right px-2 text-muted font-medium">{y}</th>)}</tr></thead>
      <tbody>{grid.ages.map((a, ai) => (
        <tr key={a} className={`border-b border-hairline ${ai === grid.youngFrom ? "border-t-2 border-t-ink/30" : ""}`}>
          <td className={`py-1.5 px-2 ${ai < grid.youngFrom ? "font-semibold" : ""}`}>{a}</td>
          {grid.value[ai].map((v, yi) => <td key={yi} className="text-right px-2">{fmtV(v)}</td>)}
        </tr>
      ))}</tbody>
    </table>
  ) : undefined;

  const h = hover && grid ? { age: grid.ages[hover.ai], year: grid.years[hover.yi], v: grid.value[hover.ai][hover.yi], r: grid.raw[hover.ai][hover.yi] } : null;

  const method = "Age-specific rates = cases ÷ person-years for each 5-year age group and year (national, current case definition), smoothed over 3 years for the surface; the hover shows the unsmoothed value. The change view divides each age group by its own 2017–18 mean so that young and old ages share one scale: the 3D height is then % change, not absolute risk.";
  const about = mode === "index"
    ? `Each age group's rate relative to its own ${BASE_YEARS.join("–")} level; ridges above the plane are rising. Earlier years (low EMR coverage) are excluded.`
    : "National age-specific incidence per 100,000 person-years, 3-year smoothed. Ages 0–19 are omitted (no cases).";
  const notes = "3D: drag to orbit, scroll to zoom, hover the surface for values. The shaded floor marks the under-50 age groups (bold labels in the heatmap).";
  return (
    <Card
      title="Rate by age and year" icon={<Mountain size={16} />}
      detail={table ? { tabs: chartDetailTabs({ table, method: <><p>{about}</p><p className="mt-2">{method}</p></>, notes }), defaultTab: "table" } : undefined} detailLabel="Rate by age and year: view as table"
      actions={<Seg label="Height" value={mode} onChange={setMode} options={[{ value: "index", label: "Change" }, { value: "log", label: "Rate (log)" }, { value: "rate", label: "Rate" }]} />}
    >
      {grid?.ridge && <p className="text-label font-normal text-muted -mt-1 mb-4 tabular">{grid.ridge}</p>}
      {q.error ? <ErrorNote error={q.error} /> : !grid ? (q.isLoading ? <Loading h={440} /> : <Empty h={300}>Not enough years in the selected period for a surface.</Empty>) : (
        <div className="relative">
          {view === "heat" || !webgl ? <Heatmap grid={grid} mode={mode} /> : (
            <div className="relative h-[460px] rounded-tile overflow-hidden bg-tile">
              <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-label text-muted">Loading the 3D landscape</div>}>
                <div className="absolute inset-0">
                  <LandscapeScene years={grid.years} ages={grid.ages} heights={grid.heights} colors={grid.colors} refHeight={grid.refHeight}
                    refLabel={grid.refHeight !== null ? "100 = no change" : undefined} zTicks={grid.zTicks} youngFrom={grid.youngFrom}
                    ridgeLabel={null} hover={hover} onHover={setHover} reducedMotion={reduced} light={light} />
                </div>
              </Suspense>
              <div className={`absolute top-4 left-4 bg-surface rounded-tile dark:border dark:border-hairline text-ink px-4 py-3 z-10 pointer-events-none ${h ? "w-[232px]" : ""}`} role="status" aria-live="polite">
                {h ? (
                  <>
                    <div className="flex gap-3 text-micro text-muted"><span>Age {h.age}</span><span>{h.year}</span></div>
                    <div className="flex items-baseline gap-1 mt-0.5"><span className="text-[24px] leading-8 font-medium tracking-[-0.01em] tabular">{fmtV(h.v)}</span><span className="text-micro text-muted">{mode === "index" ? "index" : "per 100k"}</span></div>
                    <div className="text-micro text-muted tabular mt-0.5">Rate {fmt(h.r?.rate, 1)}, smoothed {fmt(h.r?.rate_smoothed, 1)}</div>
                    <div className="text-micro text-muted tabular">{int(h.r?.cases)} cases in {int(h.r?.population)} person-years</div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-micro text-muted">
                    <MousePointer2 size={13} className="shrink-0" aria-hidden />
                    <span>Hover, drag or scroll</span>
                  </div>
                )}
              </div>
              <SurfaceLegend grid={grid} mode={mode} light={light} />
              <div className="absolute bottom-4 left-4 bg-surface rounded-full dark:border dark:border-hairline px-3 h-8 text-micro text-muted flex items-center gap-1.5 pointer-events-none"><Move3d size={13} aria-hidden />Year across, age in depth, height {grid.unit}</div>
            </div>
          )}
          {webgl && view === "3d" && (
            <div className="absolute z-10 top-4 right-4">
              <Seg label="Render" variant="glass" value={view} onChange={(v) => setView(v)} options={[{ value: "3d", label: "3D" }, { value: "heat", label: "Heatmap" }]} className="!bg-surface dark:!bg-tile" />
            </div>
          )}
          {webgl && view === "heat" && (
            <div className="flex justify-end mt-2">
              <Seg label="Render" variant="glass" value={view} onChange={(v) => setView(v)} options={[{ value: "3d", label: "3D" }, { value: "heat", label: "Heatmap" }]} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SurfaceLegend({ grid, mode, light }: { grid: Grid; mode: Mode; light: boolean }) {
  const grad = mode === "index"
    ? `linear-gradient(90deg, ${DIVERGING.neg}, ${DIVERGING.mid}, ${DIVERGING.pos})`
    : `linear-gradient(90deg, ${(light ? SEQ_LIGHT : SEQ_DARK).slice(1).join(",")})`;
  const ticks = mode === "index" ? ["0 or less", "100", "200 or more"] : mode === "log" ? ["0", "≈30", fmt(grid.maxV, 0)] : ["0", fmt(grid.maxV / 2, 0), fmt(grid.maxV, 0)];
  return (
    <div className="absolute right-4 bottom-4 bg-surface rounded-tile dark:border dark:border-hairline text-ink px-4 py-3 w-[196px] z-10 pointer-events-none">
      <div className="text-micro text-ink mb-2 flex items-center gap-1.5"><Box size={12} aria-hidden />{mode === "index" ? "Change since 2017–18" : "Rate per 100,000"}</div>
      <div className="h-1.5 rounded-full" style={{ background: grad }} aria-hidden />
      <div className="flex justify-between text-[11px] text-muted mt-1 tabular">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
      <div className="mt-2 text-[11px] text-muted leading-snug flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-ink/10" aria-hidden />Under 50 (shaded floor)</div>
    </div>
  );
}

function Heatmap({ grid, mode }: { grid: Grid; mode: Mode }) {
  const pal = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase();
    const k = pal.ink;
    const data = grid.value.flatMap((r, ai) => r.map((v, yi) => [yi, ai, v === null ? null : mode === "log" ? Math.log10(v + 1) : v]));
    const seq = pal.mode === "dark" ? SEQ_DARK.slice(1) : SEQ_LIGHT;
    const vmax = mode === "index" ? 200 : mode === "log" ? Math.log10(grid.maxV + 1) : grid.maxV;
    return {
      ...b,
      grid: { left: 56, right: 76, top: 12, bottom: 28 },
      xAxis: { ...b.xAxis, type: "category", data: grid.years.map(String), splitArea: { show: false } },
      yAxis: { ...b.yAxis, type: "category", data: grid.ages, splitLine: { show: false },
        axisLabel: { ...b.yAxis.axisLabel, formatter: (v: string, i: number) => (i < grid.youngFrom ? `{y|${v}}` : v), rich: { y: { color: k.primary, fontWeight: 700 } } } },
      visualMap: { type: "continuous", min: mode === "index" ? 0 : 0, max: vmax, calculable: false, orient: "vertical", right: 4, top: "middle", itemHeight: 140, itemWidth: 10,
        text: [mode === "index" ? "≥200" : "high", mode === "index" ? "0" : "0"], textStyle: { color: k.muted, fontSize: 10 },
        inRange: { color: mode === "index" ? [DIVERGING.neg, DIVERGING.mid, DIVERGING.pos] : seq } },
      tooltip: { ...b.tooltip, trigger: "item", formatter: (p: any) => {
        const [yi, ai] = p.data;
        const v = grid.value[ai][yi], r = grid.raw[ai][yi];
        return `<b>Age ${grid.ages[ai]}, ${grid.years[yi]}</b><br/>${mode === "index" ? `Index ${int(v)}<br/>` : ""}Rate ${fmt(r?.rate, 1)} per 100k (smoothed ${fmt(r?.rate_smoothed, 1)})<br/>${int(r?.cases)} cases`;
      } },
      series: [{ type: "heatmap", data, itemStyle: { borderColor: k.surface, borderWidth: 1.5, borderRadius: 2 }, emphasis: { itemStyle: { borderColor: k.primary, borderWidth: 1.5 } } }],
    } as EChartsOption;
  }, [grid, mode, pal]);
  return (
    <div>
      <EChart option={option} height={460} ariaLabel="Heatmap of age-specific incidence by year" />
    </div>
  );
}
