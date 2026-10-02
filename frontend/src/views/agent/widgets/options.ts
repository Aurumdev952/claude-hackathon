/** ECharts option builders for the agent's ChartSpec (line / area / bar / forest). Chrome comes from `base()`; colours
 * from the validated palette in `@/lib/viz` (series slots in fixed order, status colours never used for series). */
import type { ChartSpec, Row, SeriesSpec } from "@agent/widgets";
import { base } from "@/components/charts/EChart";
import { alphaHex, ink } from "@/lib/viz";
import { asNum, cellText, colLabel, fmtNumber, fmtValue } from "./format";

type Line = Extract<ChartSpec, { type: "line" | "area" }>;
type Bar = Extract<ChartSpec, { type: "bar" }>;
type Forest = Extract<ChartSpec, { type: "forest" }>;
type Ink = ReturnType<typeof ink>;

export const seriesLabel = (s: SeriesSpec) => s.label ?? colLabel(s.key);
const xText = (v: Row[string] | undefined) => (v === null || v === undefined ? "" : String(v));

const dot = (c: string) => `<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${c};margin-right:8px"></span>`;
function ttRow(color: string, label: string, value: string, extra = "", k: Ink) {
  return `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between;min-width:170px;line-height:20px">`
    + `<span style="display:flex;align-items:center;color:${k.secondary}">${dot(color)}${label}</span>`
    + `<span style="font-variant-numeric:tabular-nums;font-weight:600;color:${k.primary}">${value}<span style="font-weight:400;color:${k.muted}">${extra}</span></span></div>`;
}
const ttHead = (t: string, k: Ink) => `<div style="font-weight:600;color:${k.primary};margin-bottom:4px">${t}</div>`;
const suppressedNote = (row: Row, k: Ink) =>
  Object.keys(row).some((c) => c.endsWith("_label") && typeof row[c] === "string")
    ? `<div style="margin-top:4px;color:${k.muted};font-size:11px">Small numbers suppressed (${Object.keys(row).filter((c) => c.endsWith("_label")).map((c) => `${colLabel(c.slice(0, -6))} ${row[c]}`).join(", ")})</div>` : "";

function ciText(row: Row, s: SeriesSpec, unit?: string) {
  if (!s.lci || !s.uci) return "";
  const l = asNum(row[s.lci]), u = asNum(row[s.uci]);
  return l === null || u === null ? "" : `  ${cellText(row, s.lci, undefined, unit)}–${cellText(row, s.uci, undefined, unit)}`;
}

const axisValue = (k: Ink, unit?: string) => ({
  axisLabel: { color: k.muted, hideOverlap: true, formatter: (v: number) => fmtValue(v, undefined, unit) },
});

export function lineOption(spec: Line, S: string[], k: Ink, compact = false) {
  const cats = spec.data.map((r) => xText(r[spec.x.key]));
  const area = spec.type === "area";
  const stacked = area && spec.stacked;
  const hasRight = spec.series.some((s) => s.axis === "right");
  const series: any[] = [];
  // forecast fan (v3): dashed continuation series share the colour of the observed series; 95% band lighter, 80% darker
  const fan = spec.fan;
  const solidIdx = Math.max(0, spec.series.findIndex((s) => !s.dashed));
  const colorOf = (i: number) => (fan && spec.series[i].dashed ? S[solidIdx % S.length] : S[i % S.length]);
  if (fan && !stacked) {
    const fc = S[solidIdx % S.length];
    const band = (lo: string, hi: string, name: string, alpha: number) => {
      const l = spec.data.map((r) => asNum(r[lo]));
      const h = spec.data.map((r) => asNum(r[hi]));
      series.push(
        { name: `${name} low`, type: "line", stack: name, data: l.map((v) => v ?? "-"), symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false }, z: 1 },
        { name, type: "line", stack: name, data: h.map((v, j) => (v !== null && l[j] !== null ? v - (l[j] as number) : "-")),
          symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: alphaHex(fc, alpha) }, silent: true, tooltip: { show: false }, z: 1 },
      );
    };
    band(fan.lo95, fan.hi95, "95% interval", 0.13);
    if (fan.lo80 && fan.hi80) band(fan.lo80, fan.hi80, "80% interval", 0.2);
  }
  spec.series.forEach((s, i) => {
    const c = colorOf(i);
    const yAxisIndex = s.axis === "right" ? 1 : 0;
    if (s.lci && s.uci && !stacked) {
      const lo = spec.data.map((r) => asNum(r[s.lci!]));
      const hi = spec.data.map((r) => asNum(r[s.uci!]));
      series.push(
        { name: `${seriesLabel(s)} CI low`, type: "line", stack: `ci${i}`, yAxisIndex, data: lo.map((v) => v ?? "-"), symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false }, z: 1 },
        { name: `${seriesLabel(s)} 95% CI`, type: "line", stack: `ci${i}`, yAxisIndex, data: hi.map((v, j) => (v !== null && lo[j] !== null ? v - (lo[j] as number) : "-")),
          symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: alphaHex(c, 0.16) }, silent: true, tooltip: { show: false }, z: 1 },
      );
    }
    const vals = spec.data.map((r) => asNum(r[s.key]));
    const lastIdx = vals.reduce<number>((acc, v, j) => (v !== null ? j : acc), -1);
    series.push({
      name: seriesLabel(s), type: "line", yAxisIndex, data: vals.map((v) => v ?? "-"), smooth: false, connectNulls: false, z: 3,
      symbol: "circle", symbolSize: compact ? 5 : 7, showSymbol: spec.data.length <= 40,
      stack: stacked ? "total" : undefined,
      lineStyle: { width: 2.25, color: c, type: s.dashed ? "dashed" : "solid" },
      itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
      areaStyle: area ? { color: alphaHex(c, stacked ? 0.2 : 0.12) } : undefined,
      emphasis: { focus: spec.series.length > 1 ? "series" : "none", scale: 1.4 },
      endLabel: spec.series.length <= 3 && lastIdx >= 0 && !compact
        ? { show: true, color: k.primary, fontSize: 11, fontWeight: 600, distance: 6, formatter: () => cellText(spec.data[lastIdx], s.key, undefined, spec.unit) } : undefined,
      markLine: i === 0 && (spec.annotations?.length || spec.referenceLines?.length || fan?.start !== undefined) ? {
        symbol: "none", silent: true, animation: false,
        label: { color: k.muted, fontSize: 10, position: "insideEndTop" },
        lineStyle: { color: k.axis, type: "dashed", width: 1 },
        data: [
          ...(spec.annotations ?? []).filter((a) => cats.includes(String(a.x))).map((a) => ({ xAxis: String(a.x), label: { formatter: a.label, position: "insideEndTop" } })),
          ...(spec.referenceLines ?? []).map((r) => ({ yAxis: r.y, label: { formatter: r.label ?? fmtNumber(r.y), position: "insideEndTop" } })),
          ...(fan?.start !== undefined && cats.includes(String(fan.start)) ? [{ xAxis: String(fan.start), label: { formatter: "Forecast", position: "insideEndTop" } }] : []),
        ],
      } : undefined,
    });
  });
  return {
    ...base(),
    legend: { show: false },
    grid: { left: 8, right: spec.series.length <= 3 && !compact ? 52 : 16, top: 14, bottom: 4, containLabel: true },
    tooltip: {
      ...(base().tooltip as object), trigger: "axis",
      formatter: (ps: any[]) => {
        const j = ps[0]?.dataIndex ?? 0;
        const row = spec.data[j];
        const withValue = spec.series.filter((s) => asNum(row[s.key]) !== null);
        const shown = fan && withValue.length ? withValue : spec.series;
        const bands = fan && asNum(row[fan.lo95]) !== null
          ? `<div style="margin-top:4px;color:${k.muted};font-size:11px;font-variant-numeric:tabular-nums">`
            + (fan.lo80 && fan.hi80 ? `80%: ${cellText(row, fan.lo80, undefined, spec.unit)}–${cellText(row, fan.hi80, undefined, spec.unit)} · ` : "")
            + `95%: ${cellText(row, fan.lo95, undefined, spec.unit)}–${cellText(row, fan.hi95, undefined, spec.unit)}</div>` : "";
        return ttHead(cats[j], k) + shown.map((s) => ttRow(colorOf(spec.series.indexOf(s)), seriesLabel(s), cellText(row, s.key, undefined, spec.unit), ciText(row, s, spec.unit), k)).join("") + bands + suppressedNote(row, k);
      },
    },
    xAxis: { ...(base().xAxis as object), type: "category", data: cats, boundaryGap: false, axisLabel: { color: k.muted, hideOverlap: true } },
    yAxis: [
      { ...(base().yAxis as object), type: "value", scale: false, ...axisValue(k, spec.unit) },
      ...(hasRight ? [{ ...(base().yAxis as object), type: "value", splitLine: { show: false }, ...axisValue(k) }] : []),
    ],
    series,
  } as any;
}

export function isHorizontal(spec: Bar) {
  if (spec.orientation) return spec.orientation === "horizontal";
  const labels = spec.data.map((r) => xText(r[spec.x.key]));
  const avg = labels.reduce((a, l) => a + l.length, 0) / Math.max(1, labels.length);
  return avg > 7 || labels.length > 12;
}

export function barHeight(spec: Bar) {
  return isHorizontal(spec) ? Math.max(150, spec.data.length * (spec.series.length > 1 && !spec.stacked ? 18 * spec.series.length + 10 : 30) + 36) : 260;
}

export function barOption(spec: Bar, S: string[], k: Ink) {
  const horiz = isHorizontal(spec);
  const cats = spec.data.map((r) => xText(r[spec.x.key]));
  const single = spec.series.length === 1;
  const longest = Math.max(4, ...cats.map((c) => c.length));
  const catAxis = {
    ...(base().xAxis as object), type: "category", data: cats, inverse: horiz,
    axisLine: { show: !horiz, lineStyle: { color: k.axis } },
    axisLabel: { color: horiz ? k.secondary : k.muted, fontSize: 11, interval: 0, hideOverlap: !horiz, width: horiz ? 150 : 80, overflow: "truncate" },
  };
  const valAxis = { ...(base().yAxis as object), type: "value", ...axisValue(k, spec.unit), splitLine: { lineStyle: { color: k.grid } } };
  const series: any[] = spec.series.map((s, i) => {
    const c = S[i % S.length];
    return {
      name: seriesLabel(s), type: "bar", stack: spec.stacked ? "total" : undefined, barMaxWidth: horiz ? 16 : 28, barGap: "30%",
      data: spec.data.map((r) => asNum(r[s.key]) ?? "-"),
      itemStyle: { color: c, borderRadius: spec.stacked ? 2 : horiz ? [0, 6, 6, 0] : [6, 6, 0, 0] },
      emphasis: { itemStyle: { color: c } },
      label: single && spec.data.length <= 16 && !spec.stacked ? {
        show: true, position: horiz ? "right" : "top", color: k.secondary, fontSize: 10.5, fontWeight: 500, distance: s.lci ? 4 : 5,
        formatter: (p: any) => cellText(spec.data[p.dataIndex], s.key, undefined, spec.unit),
      } : undefined,
      markLine: i === 0 && spec.referenceLines?.length ? {
        symbol: "none", silent: true, lineStyle: { color: k.axis, type: "dashed" }, label: { color: k.muted, fontSize: 10 },
        data: spec.referenceLines.map((r) => (horiz ? { xAxis: r.y, label: { formatter: r.label ?? fmtNumber(r.y) } } : { yAxis: r.y, label: { formatter: r.label ?? fmtNumber(r.y) } })),
      } : undefined,
    };
  });
  // 95% CI whiskers for a single, unstacked series
  const s0 = spec.series[0];
  if (single && !spec.stacked && s0.lci && s0.uci) {
    series.push({
      type: "custom", name: "95% CI", silent: true, z: 5, tooltip: { show: false },
      data: spec.data.map((r, j) => [j, asNum(r[s0.lci!]), asNum(r[s0.uci!])]),
      renderItem: (_: any, api: any) => {
        const j = api.value(0), lo = api.value(1), hi = api.value(2);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        const a = horiz ? api.coord([lo, j]) : api.coord([j, lo]);
        const b = horiz ? api.coord([hi, j]) : api.coord([j, hi]);
        const cap = 4, style = { stroke: k.secondary, lineWidth: 1.2, opacity: 0.7 };
        return { type: "group", children: horiz ? [
          { type: "line", shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style },
          { type: "line", shape: { x1: a[0], y1: a[1] - cap, x2: a[0], y2: a[1] + cap }, style },
          { type: "line", shape: { x1: b[0], y1: b[1] - cap, x2: b[0], y2: b[1] + cap }, style },
        ] : [
          { type: "line", shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style },
          { type: "line", shape: { x1: a[0] - cap, y1: a[1], x2: a[0] + cap, y2: a[1] }, style },
          { type: "line", shape: { x1: b[0] - cap, y1: b[1], x2: b[0] + cap, y2: b[1] }, style },
        ] };
      },
    });
  }
  return {
    ...base(),
    legend: { show: false },
    grid: horiz ? { left: 8, right: single ? 56 : 20, top: 6, bottom: 4, containLabel: true } : { left: 8, right: 12, top: 22, bottom: 4, containLabel: true },
    tooltip: {
      ...(base().tooltip as object), trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: alphaHex(S[0], 0.06) } },
      formatter: (ps: any[]) => {
        const j = ps[0]?.dataIndex ?? 0;
        const row = spec.data[j];
        return ttHead(cats[j], k) + spec.series.map((s, i) => ttRow(S[i % S.length], seriesLabel(s), cellText(row, s.key, undefined, spec.unit), ciText(row, s, spec.unit), k)).join("") + suppressedNote(row, k);
      },
    },
    xAxis: horiz ? valAxis : catAxis,
    yAxis: horiz ? { ...catAxis, axisLabel: { ...catAxis.axisLabel, width: Math.min(170, longest * 6.6) } } : valAxis,
    series,
  } as any;
}

export function forestOption(spec: Forest, S: string[], k: Ink) {
  const labels = spec.data.map((r) => xText(r[spec.labelKey]));
  const est = spec.data.map((r) => asNum(r[spec.estimateKey]));
  const lcis = spec.data.map((r) => asNum(r[spec.lciKey]));
  const ucis = spec.data.map((r) => asNum(r[spec.uciKey]));
  const vals = [...est, ...lcis, ...ucis].filter((v): v is number => v !== null && (!spec.logScale || v > 0));
  const ref = spec.reference;
  const lo = Math.min(...vals, ref ?? Infinity), hi = Math.max(...vals, ref ?? -Infinity);
  // round the axis out to a "nice" step so the end labels read as normal ticks
  const raw = (hi - lo) / 5 || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step;
  const c = S[0];
  return {
    ...base(),
    legend: { show: false },
    grid: { left: 8, right: 118, top: 10, bottom: 4, containLabel: true },
    tooltip: {
      ...(base().tooltip as object), trigger: "item",
      formatter: (p: any) => {
        const j = p.dataIndex, row = spec.data[j];
        return ttHead(labels[j], k) + ttRow(c, colLabel(spec.estimateKey), cellText(row, spec.estimateKey), `  ${cellText(row, spec.lciKey)}–${cellText(row, spec.uciKey)}`, k);
      },
    },
    xAxis: spec.logScale
      ? { ...(base().yAxis as object), type: "log", logBase: 10, min: Math.max(lo * 0.8, 1e-6), max: hi * 1.2, axisLabel: { color: k.muted, formatter: (v: number) => fmtNumber(v) } }
      : { ...(base().yAxis as object), type: "value", min, max, interval: step, axisLabel: { color: k.muted, formatter: (v: number) => fmtNumber(v) } },
    yAxis: { ...(base().xAxis as object), type: "category", data: labels, inverse: true, axisLine: { show: false }, axisLabel: { color: k.secondary, fontSize: 11, width: 150, overflow: "truncate" } },
    series: [{
      type: "custom", name: colLabel(spec.estimateKey),
      data: spec.data.map((_, j) => [j, est[j], lcis[j], ucis[j]]),
      encode: { x: [1, 2, 3], y: 0 },
      renderItem: (params: any, api: any) => {
        const j = api.value(0), e = api.value(1), l = api.value(2), u = api.value(3);
        const children: any[] = [];
        const y = api.coord([Number.isFinite(e) ? e : (min + max) / 2, j])[1];
        if (Number.isFinite(l) && Number.isFinite(u)) {
          const a = api.coord([l, j]), b = api.coord([u, j]);
          children.push({ type: "line", shape: { x1: a[0], y1: y, x2: b[0], y2: y }, style: { stroke: alphaHex(c, 0.75), lineWidth: 2, lineCap: "round" } });
        }
        if (Number.isFinite(e)) {
          const p = api.coord([e, j]);
          children.push({ type: "rect", shape: { x: p[0] - 5, y: y - 5, width: 10, height: 10, r: 2 }, style: { fill: c, stroke: k.surface, lineWidth: 1.5 } });
        }
        const row = spec.data[j];
        children.push({ type: "text", style: { x: params.coordSys.x + params.coordSys.width + 12, y, text: `${cellText(row, spec.estimateKey)} (${cellText(row, spec.lciKey)}–${cellText(row, spec.uciKey)})`,
          fill: k.secondary, font: '500 12px "Urbanist Variable", Urbanist, sans-serif', verticalAlign: "middle" } });
        return { type: "group", children };
      },
    },
    ...(ref !== undefined ? [{ type: "line", data: [], silent: true, tooltip: { show: false },
      markLine: { symbol: "none", silent: true, animation: false, lineStyle: { color: k.axis, type: "dashed", width: 1.2 }, label: { show: false }, data: [{ xAxis: ref }] } }] : []),
    ],
  } as any;
}
