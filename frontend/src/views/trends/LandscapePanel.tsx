import { lazy, Suspense, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Box, Mountain, MousePointer2, Move3d } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Card, chartDetailTabs, Loading, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
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

function buildGrid(rows: SurfaceRow[], mode: Mode, y0: number, y1: number): Grid | null {
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
    cOf = (v) => lerpHex(SEQ_DARK.slice(1), Math.log10(Math.max(0, v) + 1) / top);
    zTicks = [1, 10, 100, 1000].filter((v) => v <= maxRate * 1.05).map((v) => ({ h: hOf(v), label: String(v) }));
    unit = "per 100,000 · log height";
  } else {
    value = raw.map((r) => r.map((x) => (x ? x.rate_smoothed : null)));
    hOf = (v) => (Math.max(0, v) / maxRate) * H;
    cOf = (v) => lerpHex(SEQ_DARK.slice(1), v / maxRate);
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
    if (youngIdx.length && oldIdx.length) ridge = `Young-onset ridge · under 50 ${avg(youngIdx) >= 100 ? "+" : ""}${int(avg(youngIdx) - 100)}% vs 50+ ${avg(oldIdx) >= 100 ? "+" : ""}${int(avg(oldIdx) - 100)}% since ${BASE_YEARS.join("–")}`;
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
  const grid = useMemo(() => (q.data ? buildGrid(q.data.data, mode, f.yearFrom, f.yearTo) : null), [q.data, mode, f.yearFrom, f.yearTo]);

  const fmtV = (v: number | null) => (v === null ? "—" : mode === "index" ? int(v) : fmt(v, 1));
  const table = grid ? (
    <table className="w-full text-[11px] tabular">
      <caption className="text-left text-label text-fg-muted mb-1.5">{mode === "index" ? `Age-specific rate as an index (${BASE_YEARS.join("–")} = 100)` : "Age-specific rate per 100,000 (3-year smoothed)"}</caption>
      <thead className="sticky top-0 bg-surface-2"><tr><th className="text-left py-1.5 px-1.5 text-fg-muted font-medium">Age</th>{grid.years.map((y) => <th key={y} className="text-right px-1.5 text-fg-muted font-medium">{y}</th>)}</tr></thead>
      <tbody>{grid.ages.map((a, ai) => (
        <tr key={a} className={`border-b border-border/70 ${ai === grid.youngFrom ? "border-t-2 border-t-warning/50" : ""}`}>
          <td className={`py-1 px-1.5 ${ai < grid.youngFrom ? "text-tone-warning" : ""}`}>{a}</td>
          {grid.value[ai].map((v, yi) => <td key={yi} className="text-right px-1.5">{fmtV(v)}</td>)}
        </tr>
      ))}</tbody>
    </table>
  ) : undefined;

  const h = hover && grid ? { age: grid.ages[hover.ai], year: grid.years[hover.yi], v: grid.value[hover.ai][hover.yi], r: grid.raw[hover.ai][hover.yi] } : null;

  const method = "Age-specific rates = cases ÷ person-years for each 5-year age group and year (national, current case definition), smoothed over 3 years for the surface; the hover shows the unsmoothed value. Index view divides each age group by its own 2017–18 mean so that young and old ages share one scale — the 3D height is then % change, not absolute risk.";
  return (
    <Card
      title="Rate landscape · year × age" icon={<Mountain size={16} />}
      info={{ about: mode === "index"
        ? <>Each age group's rate relative to its own {BASE_YEARS.join("–")} level — ridges above the plane are rising. Earlier years (low EMR coverage) excluded.</>
        : <>National age-specific incidence per 100,000 person-years, 3-year smoothed. Ages 0–19 omitted (no cases).</>,
        method, notes: "3D: drag to orbit, scroll to zoom, hover the surface for values. Gold floor = under-50 age groups. The heatmap is the 2D equivalent (gold labels = under-50 age groups)." }}
      detail={table ? { tabs: chartDetailTabs({ table, method }), defaultTab: "table" } : undefined} detailLabel="View as table"
      actions={<>
        {grid?.ridge && <StatusChip status="serious" size="md" label={grid.ridge.replace("Young-onset ridge · ", "")} title={grid.ridge} className="hidden xl:inline-flex" />}
        <Seg label="Height" value={mode} onChange={setMode} options={[{ value: "index", label: "Change" }, { value: "log", label: "Rate (log)" }, { value: "rate", label: "Rate" }]} />
        <Seg label="Render" value={view} onChange={(v) => setView(v)} options={[{ value: "3d", label: "3D" }, { value: "heat", label: "Heatmap" }]} />
      </>}
    >
      {q.error ? <ErrorNote error={q.error} /> : !grid ? (q.isLoading ? <Loading h={440} /> : <Empty h={300}>Not enough years in the selected period for a surface.</Empty>) : view === "heat" || !webgl ? (
        <Heatmap grid={grid} mode={mode} />
      ) : (
        <div className="relative h-[460px] rounded-tile overflow-hidden case-stage">
          <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-xs text-[#8696a2]">Loading 3D landscape…</div>}>
            <div className="absolute inset-0">
              <LandscapeScene years={grid.years} ages={grid.ages} heights={grid.heights} colors={grid.colors} refHeight={grid.refHeight}
                refLabel={grid.refHeight !== null ? "100 = no change" : undefined} zTicks={grid.zTicks} youngFrom={grid.youngFrom}
                ridgeLabel={grid.ridge} hover={hover} onHover={setHover} reducedMotion={reduced} />
            </div>
          </Suspense>
          <div className={`absolute top-3 left-3 glass rounded-tile shadow-tile text-fg px-3 py-2 z-10 pointer-events-none ${h ? "w-[220px]" : ""}`} role="status" aria-live="polite">
            {h ? (
              <>
                <div className="text-micro text-fg-muted">Age {h.age} · {h.year}</div>
                <div className="text-[22px] font-semibold tracking-tight leading-tight mt-0.5 tabular">{fmtV(h.v)}<span className="text-[11px] font-normal text-fg-muted ml-1">{mode === "index" ? "index" : "per 100k"}</span></div>
                <div className="text-micro text-fg-muted tabular mt-0.5">Rate {fmt(h.r?.rate, 1)} · {int(h.r?.cases)} cases · smoothed {fmt(h.r?.rate_smoothed, 1)}</div>
                <div className="text-micro text-fg-muted tabular">{int(h.r?.population)} person-years</div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-micro text-fg-muted">
                <MousePointer2 size={13} className="shrink-0" aria-hidden />
                <span>Hover · drag · scroll</span>
              </div>
            )}
          </div>
          <SurfaceLegend grid={grid} mode={mode} />
          <div className="absolute bottom-3 left-3 glass rounded-tile shadow-tile px-2.5 py-1 text-micro text-fg-muted flex items-center gap-1.5 pointer-events-none"><Move3d size={12} aria-hidden /> x year · depth age · height {grid.unit}</div>
        </div>
      )}
    </Card>
  );
}

function SurfaceLegend({ grid, mode }: { grid: Grid; mode: Mode }) {
  const grad = mode === "index"
    ? `linear-gradient(90deg, ${DIVERGING.neg}, ${DIVERGING.mid}, ${DIVERGING.pos})`
    : `linear-gradient(90deg, ${SEQ_DARK.slice(1).join(",")})`;
  const ticks = mode === "index" ? ["≤ 0", "100", "≥ 200"] : mode === "log" ? ["0", "≈30", fmt(grid.maxV, 0)] : ["0", fmt(grid.maxV / 2, 0), fmt(grid.maxV, 0)];
  return (
    <div className="absolute right-3 bottom-3 glass rounded-tile shadow-tile text-fg p-2.5 w-[190px] z-10 pointer-events-none">
      <div className="text-micro font-medium text-fg mb-1.5 flex items-center gap-1.5"><Box size={11} aria-hidden />{mode === "index" ? "Change vs 2017–18" : "Rate per 100,000"}</div>
      <div className="h-2 rounded-full" style={{ background: grad }} aria-hidden />
      <div className="flex justify-between text-[10px] text-fg-muted mt-0.5 tabular">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
      <div className="mt-1.5 text-[10px] text-fg-muted leading-snug flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-[#c9902e]/50" aria-hidden />Under 50 (gold floor)</div>
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
        axisLabel: { ...b.yAxis.axisLabel, formatter: (v: string, i: number) => (i < grid.youngFrom ? `{y|${v}}` : v), rich: { y: { color: pal.mode === "dark" ? "#f2c06b" : "#8a5a0c", fontWeight: 600 } } } },
      visualMap: { type: "continuous", min: mode === "index" ? 0 : 0, max: vmax, calculable: false, orient: "vertical", right: 4, top: "middle", itemHeight: 140, itemWidth: 10,
        text: [mode === "index" ? "≥200" : "high", mode === "index" ? "0" : "0"], textStyle: { color: k.muted, fontSize: 10 },
        inRange: { color: mode === "index" ? [DIVERGING.neg, DIVERGING.mid, DIVERGING.pos] : seq } },
      tooltip: { ...b.tooltip, trigger: "item", formatter: (p: any) => {
        const [yi, ai] = p.data;
        const v = grid.value[ai][yi], r = grid.raw[ai][yi];
        return `<b>Age ${grid.ages[ai]} · ${grid.years[yi]}</b><br/>${mode === "index" ? `Index ${int(v)}<br/>` : ""}Rate ${fmt(r?.rate, 1)} per 100k (smoothed ${fmt(r?.rate_smoothed, 1)})<br/>${int(r?.cases)} cases`;
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
