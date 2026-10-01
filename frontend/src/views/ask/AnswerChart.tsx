import { useMemo, useState } from "react";
import { EChart, base } from "@/components/charts/EChart";
import { useGeo } from "@/api/hooks";
import { seqColor } from "@/lib/viz";
import { tooltip, ttHead, ttRow, usePalette, xAxis, yAxis } from "../quality/kit";
import { colLabel, fmtVal, isNumCol, isPct } from "./format";
import type { AskResult, ChartSpec } from "./store";

/** The API's chart spec (SPEC §15.2 step 7) with a client-side fallback using the same heuristic. */
export function resolveSpec(r: AskResult): ChartSpec | null {
  if (!r.rows.length) return null;
  const num = r.columns.filter((_, i) => isNumCol(r.rows, i));
  // one row is a figure, not a chart (a one-point line says nothing)
  if (r.rows.length === 1 && num.length) {
    const pref = (r.chart as any)?.y ?? (r.chart as any)?.value;
    const v = pref && num.includes(pref) ? pref : num.find((c) => !/_(lci|uci)$/.test(c) && c !== "year") ?? num[0];
    return { type: "kpi", value: v };
  }
  if (r.chart && r.chart.type !== "table") return r.chart;
  const cat = r.columns.filter((c) => !num.includes(c));
  if (r.rows.length === 1 && num.length) return { type: "kpi", value: num[num.length - 1] };
  if (cat.length && num.length) return { type: "bar", x: cat[0], y: num[0] };
  return null;
}

export function AnswerChart({ r, spec }: { r: AskResult; spec: ChartSpec }) {
  if (spec.type === "kpi") return <Kpi r={r} col={spec.value} />;
  if (spec.type === "line" && spec.y) return <Line r={r} x={spec.x} y={spec.y} />;
  if (spec.type === "bar") return <Bar r={r} x={spec.x} y={spec.y} />;
  if (spec.type === "choropleth") return <MiniMap r={r} geo={spec.geo} value={spec.value} />;
  return null;
}

const col = (r: AskResult, c: string) => r.columns.indexOf(c);

function Kpi({ r, col: c }: { r: AskResult; col: string }) {
  const i = col(r, c);
  const row = r.rows[0];
  const labelIdx = r.columns.findIndex((cc, j) => j !== i && typeof row[j] === "string");
  return (
    <div className="flex items-end gap-4 py-2">
      <div>
        <div className="text-[10px] uppercase tracking-[0.12em] text-fog font-semibold">{colLabel(c)}{labelIdx >= 0 ? ` · ${fmtVal(r.columns[labelIdx], row[labelIdx])}` : ""}</div>
        <div className="text-5xl font-semibold tabular leading-none mt-1">{fmtVal(c, row[i])}</div>
        {col(r, `${c}_lci`) >= 0 && col(r, `${c}_uci`) >= 0 && <div className="text-xs text-fog tabular mt-1">95% CI {fmtVal(c, row[col(r, `${c}_lci`)])}–{fmtVal(c, row[col(r, `${c}_uci`)])}</div>}
      </div>
      {r.columns.length > 2 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs pb-1">
          {r.columns.map((cc, j) => (j === i || j === labelIdx || cc === `${c}_lci` || cc === `${c}_uci` ? null : <div key={cc}><dt className="text-fog text-[10px]">{colLabel(cc)}</dt><dd className="tabular font-semibold">{fmtVal(cc, row[j])}</dd></div>))}
        </dl>
      )}
    </div>
  );
}

function Line({ r, x, y }: { r: AskResult; x: string; y: string }) {
  const { series: S, ink: k, mode } = usePalette();
  const option = useMemo(() => {
    const xi = col(r, x), yi = col(r, y), lo = col(r, `${y}_lci`), hi = col(r, `${y}_uci`);
    const numX = r.rows.every((row) => Number.isFinite(Number(row[xi])));
    const xv = (row: unknown[]) => (numX ? Number(row[xi]) : String(row[xi]));
    const data = r.rows.map((row) => [xv(row), row[yi]]);
    const span = numX ? Math.max(...data.map((d) => d[0] as number)) - Math.min(...data.map((d) => d[0] as number)) : 0;
    const c = S[0];
    const band = lo >= 0 && hi >= 0 ? [
      { type: "line", stack: "ci", data: r.rows.map((row) => [xv(row), row[lo]]), symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
      { type: "line", stack: "ci", data: r.rows.map((row) => [xv(row), (row[hi] as number) - (row[lo] as number)]), symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: c, opacity: 0.12 }, silent: true, tooltip: { show: false } },
    ] : [];
    const last = data[data.length - 1];
    return {
      ...base(), grid: { left: 44, right: 56, top: 22, bottom: 28 }, legend: { show: false },
      tooltip: tooltip({ trigger: "axis", formatter: (ps: any[]) => { const p = ps.find((q) => q.seriesName === colLabel(y)); if (!p) return ""; const row = r.rows[p.dataIndex];
        return ttHead(String(row[xi])) + r.columns.filter((cc) => cc !== x).map((cc) => ttRow(cc === y ? c : k.secondary, colLabel(cc), fmtVal(cc, row[col(r, cc)]), "line")).join(""); } }),
      xAxis: numX ? xAxis({ type: "value", min: "dataMin", max: "dataMax", interval: span > 12 ? 4 : span > 6 ? 2 : 1, axisLabel: { color: k.muted, formatter: (v: number) => String(v) } })
                  : xAxis({ type: "category", boundaryGap: false, axisLabel: { color: k.muted } }),
      yAxis: yAxis({ type: "value", min: 0 }),
      series: [...band, {
        name: colLabel(y), type: "line", data, symbol: "circle", symbolSize: 7, z: 3,
        lineStyle: { width: 2, color: c }, itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
        endLabel: { show: true, color: k.primary, fontSize: 11, fontWeight: 600, formatter: () => fmtVal(y, last?.[1]) },
      }],
    } as any;
  }, [r, x, y, S, k, mode]);
  return <EChart option={option} height={230} ariaLabel={`${colLabel(y)} by ${colLabel(x)}`} />;
}

function Bar({ r, x, y }: { r: AskResult; x: string; y: string }) {
  const { series: S, ink: k, mode } = usePalette();
  const nameIdx = col(r, "name") >= 0 ? col(r, "name") : col(r, x);
  const option = useMemo(() => {
    const yi = col(r, y);
    const cats = r.rows.map((row) => fmtVal(r.columns[nameIdx], row[nameIdx]));
    const longest = Math.max(...cats.map((c) => c.length));
    return {
      ...base(), grid: { left: Math.min(200, 16 + longest * 6.2), right: 58, top: 6, bottom: 22 }, legend: { show: false },
      tooltip: tooltip({ trigger: "item", formatter: (p: any) => { const row = r.rows[p.dataIndex];
        return ttHead(cats[p.dataIndex]) + r.columns.filter((_, j) => j !== nameIdx).map((cc) => ttRow(cc === y ? S[0] : k.secondary, colLabel(cc), fmtVal(cc, row[col(r, cc)]), "dot")).join(""); } }),
      xAxis: xAxis({ type: "value", splitLine: { show: true, lineStyle: { color: k.grid } }, axisLine: { show: false }, axisLabel: { color: k.muted, hideOverlap: true, formatter: (v: number) => (isPct(y) ? `${v}%` : v.toLocaleString("en-GB")) } }),
      yAxis: yAxis({ type: "category", inverse: true, data: cats, axisLine: { show: false }, axisLabel: { color: k.secondary, interval: 0, fontSize: 11 } }),
      series: [{ type: "bar", barMaxWidth: 16, data: r.rows.map((row) => row[yi]), itemStyle: { color: S[0], borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: k.secondary, fontSize: 10, formatter: (p: any) => fmtVal(y, p.value) } }],
    } as any;
  }, [r, y, nameIdx, S, k, mode]);
  return <EChart option={option} height={Math.max(140, r.rows.length * 26 + 32)} ariaLabel={`${colLabel(y)} by ${colLabel(r.columns[nameIdx])}`} />;
}

type Feat = { properties: { district_code: string; name: string }; geometry: { type: string; coordinates: any } };

/** Mini choropleth (SPEC §15.2: geo_code -> mini map) beside a ranked list; sequential ramp = magnitude. */
function MiniMap({ r, geo, value }: { r: AskResult; geo: string; value: string }) {
  const g = useGeo();
  usePalette();
  const [hover, setHover] = useState<{ name: string; v: unknown; x: number; y: number } | null>(null);
  const gi = col(r, geo), vi = col(r, value), ni = col(r, "name");
  const vals = new Map(r.rows.map((row) => [String(row[gi]), row[vi] as number]));
  const nums = [...vals.values()].filter((v) => typeof v === "number");
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const t = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 1) * 0.6 + 0.4;
  const shapes = useMemo(() => {
    const feats: Feat[] = g.data?.features ?? [];
    if (!feats.length) return null;
    let minX = 99, maxX = -99, minY = 99, maxY = -99;
    const rings = (f: Feat): number[][][] => (f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat());
    feats.forEach((f) => rings(f).forEach((ring) => ring.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); })));
    const kx = Math.cos(((minY + maxY) / 2) * Math.PI / 180), W = 300, s = W / ((maxX - minX) * kx), H = (maxY - minY) * s;
    return { W, H, paths: feats.map((f) => ({ code: f.properties.district_code, name: f.properties.name,
      d: rings(f).map((ring) => "M" + ring.map(([x, y]) => `${((x - minX) * kx * s).toFixed(1)},${((maxY - y) * s).toFixed(1)}`).join("L") + "Z").join("") })) };
  }, [g.data]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
      <div className="relative">
        {shapes ? (
          <svg viewBox={`0 0 ${shapes.W} ${shapes.H}`} className="w-full" role="img" aria-label={`Map of ${colLabel(value)} by district`}>
            {shapes.paths.map((p) => {
              const v = vals.get(p.code);
              return <path key={p.code} d={p.d} fill={typeof v === "number" ? seqColor(t(v)) : "rgb(var(--ridge2))"} stroke="rgb(var(--ridge))" strokeWidth={0.8}
                onMouseMove={(e) => { const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setHover({ name: p.name, v, x: e.clientX - b.left, y: e.clientY - b.top }); }}
                onMouseLeave={() => setHover(null)} />;
            })}
          </svg>
        ) : <div className="h-40 flex items-center justify-center text-xs text-fog">Loading map…</div>}
        {hover && <div className="absolute z-20 panel bg-ridge px-2.5 py-1.5 text-xs pointer-events-none whitespace-nowrap" style={{ left: hover.x + 10, top: hover.y + 10 }}>
          <b>{hover.name}</b> <span className="tabular text-fog">{typeof hover.v === "number" ? `${colLabel(value)} ${fmtVal(value, hover.v)}` : "not in result"}</span></div>}
      </div>
      <ol className="text-xs flex flex-col gap-1" aria-label="Ranked districts">
        {r.rows.slice(0, 10).map((row, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-4 text-right text-fog tabular">{i + 1}</span>
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: typeof row[vi] === "number" ? seqColor(t(row[vi] as number)) : "transparent" }} aria-hidden />
            <span className="flex-1 truncate">{fmtVal("name", ni >= 0 ? row[ni] : row[gi])}</span>
            <span className="tabular font-semibold">{fmtVal(value, row[vi])}</span>
          </li>
        ))}
        <li className="text-[10px] text-fog mt-2 flex items-center gap-2 tabular" aria-label="Colour scale">
          <span>{fmtVal(value, lo)}</span>
          <span className="flex-1 h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${[0.4, 0.55, 0.7, 0.85, 1].map((x) => seqColor(x)).join(",")})` }} />
          <span>{fmtVal(value, hi)}</span>
        </li>
        <li className="text-[10px] text-fog">{colLabel(value)} · grey = not in result</li>
      </ol>
    </div>
  );
}
