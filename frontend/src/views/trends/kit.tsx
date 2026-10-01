/** Small chart kit shared by V3 Trends Lab and V4 Early Warning (kept local so shared files stay untouched). */
import { ReactNode, useEffect, useMemo, useState } from "react";
import type { CustomSeriesOption } from "echarts";
import { ink, mode, SERIES } from "@/lib/viz";
import { base, useThemeMode } from "@/components/charts/EChart";
import { MetricCard } from "@/components/ui/MetricCard";
import { PageHeader } from "@/components/ui/SectionHeader";

export type XY = { x: number; lo: number | null; hi: number | null };

/** base() without the ECharts legend: our legends are HTML (chips / keys) so they can be focused and read. */
export function chartBase(): any {
  const b = base() as any;
  return { ...b, legend: { show: false } };
}

/** Theme-aware palette + ink, recomputed when the theme flips. */
export function usePalette() {
  const m = useThemeMode();
  return useMemo(() => ({ mode: m, series: SERIES[m], ink: ink() }), [m]);
}

export function useReducedMotion() {
  const [r, setR] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const q = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!q) return;
    const h = () => setR(q.matches);
    q.addEventListener?.("change", h);
    return () => q.removeEventListener?.("change", h);
  }, []);
  return r;
}

export function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** CI band as one polygon per contiguous run (works on log axes and with gaps, unlike stacked areas). */
export function bandSeries(name: string, pts: XY[], color: string, opts: { xAxisIndex?: number; yAxisIndex?: number; floor?: number; opacity?: number; z?: number } = {}): CustomSeriesOption {
  const floor = opts.floor ?? -Infinity;
  const clean = pts.filter((p) => p.lo !== null && p.hi !== null && Number.isFinite(p.lo) && Number.isFinite(p.hi));
  return {
    type: "custom", name, silent: true, z: opts.z ?? 1, xAxisIndex: opts.xAxisIndex ?? 0, yAxisIndex: opts.yAxisIndex ?? 0,
    tooltip: { show: false }, clip: true,
    data: clean.map((p) => [p.x, Math.max(floor, p.lo!), Math.max(floor, p.hi!)]),
    encode: { x: 0, y: [1, 2] },
    renderItem: (params: any, api: any) => {
      if (params.dataIndex !== 0) return null as any;
      const runs: XY[][] = [];
      let cur: XY[] = [];
      pts.forEach((p) => {
        if (p.lo === null || p.hi === null || !Number.isFinite(p.lo) || !Number.isFinite(p.hi)) { if (cur.length) runs.push(cur); cur = []; }
        else cur.push(p);
      });
      if (cur.length) runs.push(cur);
      return {
        type: "group",
        children: runs.filter((r) => r.length > 1).map((r) => ({
          type: "polygon",
          shape: { points: [...r.map((p) => api.coord([p.x, Math.max(floor, p.hi!)])), ...[...r].reverse().map((p) => api.coord([p.x, Math.max(floor, p.lo!)]))] },
          style: { fill: alpha(color, opts.opacity ?? (mode() === "dark" ? 0.16 : 0.13)) },
        })),
      } as any;
    },
  };
}

/** Vertical/horizontal CI whiskers with caps (forest plots, joinpoint observed points). */
export function whiskerSeries(name: string, rows: { a: number | string; lo: number | null; hi: number | null }[], color: string,
  opts: { horizontal?: boolean; cap?: number; width?: number; xAxisIndex?: number; yAxisIndex?: number } = {}): CustomSeriesOption {
  const cap = opts.cap ?? 4;
  return {
    type: "custom", name, silent: true, z: 2, xAxisIndex: opts.xAxisIndex ?? 0, yAxisIndex: opts.yAxisIndex ?? 0, tooltip: { show: false }, clip: true,
    data: rows.filter((r) => r.lo !== null && r.hi !== null).map((r) => (opts.horizontal ? [r.lo, r.hi, r.a] : [r.a, r.lo, r.hi])),
    encode: opts.horizontal ? { x: [0, 1], y: 2 } : { x: 0, y: [1, 2] },
    renderItem: (_p: any, api: any) => {
      const h = !!opts.horizontal;
      const a = h ? api.coord([api.value(0), api.value(2)]) : api.coord([api.value(0), api.value(1)]);
      const b = h ? api.coord([api.value(1), api.value(2)]) : api.coord([api.value(0), api.value(2)]);
      const st = { stroke: color, lineWidth: opts.width ?? 1.5 };
      const capLine = (p: number[]) => (h ? { x1: p[0], y1: p[1] - cap, x2: p[0], y2: p[1] + cap } : { x1: p[0] - cap, y1: p[1], x2: p[0] + cap, y2: p[1] });
      return {
        type: "group", children: [
          { type: "line", shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style: st },
          { type: "line", shape: capLine(a), style: st },
          { type: "line", shape: capLine(b), style: st },
        ],
      } as any;
    },
  };
}

/** Tooltip HTML helpers: values in ink, colour only on the swatch. */
export const tipHead = (t: string) => `<div style="font-weight:600;margin-bottom:4px">${t}</div>`;
export const tipRow = (color: string | null, label: string, value: string, extra = "") => {
  const k = ink();
  const sw = color ? `<span style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${color};margin-right:6px;vertical-align:middle"></span>` : "";
  return `<div style="display:flex;gap:12px;justify-content:space-between;align-items:baseline;font-size:11.5px;line-height:1.55">
    <span style="color:${k.secondary}">${sw}${label}</span><span style="font-variant-numeric:tabular-nums;color:${k.primary};font-weight:600">${value}${extra ? `<span style="color:${k.muted};font-weight:400"> ${extra}</span>` : ""}</span></div>`;
};
export const tipNote = (t: string) => `<div style="color:${ink().muted};font-size:10.5px;margin-top:4px;max-width:260px;white-space:normal">${t}</div>`;

/** Headline figure → v2 MetricCard (the sub-line moves into the ⓘ). Signature unchanged. */
export function StatTile({ label, value, unit, sub, tone, icon }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: "warn" | "ok" | "neutral"; icon?: ReactNode }) {
  return <MetricCard label={label} value={value} unit={unit} info={sub} icon={icon} iconTone={tone === "warn" ? "warning" : tone === "ok" ? "success" : "accent"} />;
}

/** Page header → v2 PageHeader (lede moves into the ⓘ). Signature unchanged. */
export function ViewHeader({ eyebrow, title, lede, right }: { eyebrow: string; title: string; lede: ReactNode; right?: ReactNode }) {
  return <PageHeader eyebrow={eyebrow} title={title} lede={lede} right={right} />;
}

/** Legend key (shape follows the mark: line, band, dot). */
export function Key({ color, label, kind = "line", dashed }: { color: string; label: ReactNode; kind?: "line" | "dot" | "band" | "box"; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted whitespace-nowrap">
      {kind === "line" && <span className="inline-block w-4 h-0" style={{ borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }} aria-hidden />}
      {kind === "dot" && <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} aria-hidden />}
      {kind === "band" && <span className="inline-block w-4 h-2.5 rounded-sm" style={{ background: alpha(color.startsWith("#") ? color : "#8696a2", 0.25) }} aria-hidden />}
      {kind === "box" && <span className="inline-block w-3 h-2.5 rounded-[2px]" style={{ background: alpha(color, 0.35), boxShadow: `inset 0 0 0 1.5px ${color}` }} aria-hidden />}
      {label}
    </span>
  );
}

export function Empty({ h = 200, children }: { h?: number; children: ReactNode }) {
  return <div className="flex items-center justify-center text-center text-xs text-fg-muted px-6 rounded-tile bg-surface-2/60" style={{ height: h }}>{children}</div>;
}

export const yearFrac = (d: string) => {
  const t = new Date(d);
  const y = t.getUTCFullYear();
  return y + (Date.UTC(y, t.getUTCMonth(), t.getUTCDate()) - Date.UTC(y, 0, 1)) / (365.25 * 864e5);
};
