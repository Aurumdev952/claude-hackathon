/** Small chart/UI helpers shared by V5 (Care Quality), V6 (Model Arena) and V8 (Ask the Data).
 * Everything here builds on the shared base() chrome and the validated SERIES / SEQ palettes in lib/viz. */
import { ReactNode } from "react";
import { base, useThemeMode } from "@/components/charts/EChart";
import { SEQ_DARK, SEQ_LIGHT, SERIES, ink, type Mode } from "@/lib/viz";

/** Re-render on theme flips and hand back the theme-correct palettes. */
export function usePalette() {
  const m = useThemeMode() as Mode;
  return { mode: m, series: SERIES[m], ink: ink(), seq: m === "dark" ? SEQ_DARK : SEQ_LIGHT };
}

/** Ordinal 4-step ramp (stage I -> IV) in the laterite hue; validated with the dataviz validator (--ordinal) against each
 * surface: one hue, monotone lightness, light end >= 2:1. Dark mode runs dim -> bright so stage IV is the most salient. */
export function stageRamp(m: Mode) {
  return m === "dark" ? ["#a65a44", "#cd6b4d", "#ec9475", "#fbc4b0"] : ["#e99b85", "#d9704f", "#a8432a", "#722816"];
}

export const xAxis = (extra: Record<string, unknown> = {}) => ({ ...(base().xAxis as object), ...extra }) as any;
export const yAxis = (extra: Record<string, unknown> = {}) => ({ ...(base().yAxis as object), ...extra }) as any;
export const tooltip = (extra: Record<string, unknown> = {}) => ({ ...(base().tooltip as object), ...extra }) as any;

/** Tooltip row: coloured key mark + label in ink + tabular value. */
export function ttRow(color: string, label: string, value: string, shape: "dot" | "line" = "dot") {
  const key = shape === "dot"
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`
    : `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${color};margin-right:6px;vertical-align:middle"></span>`;
  return `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between;min-width:160px"><span>${key}${label}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;
}
export const ttHead = (s: string) => `<div style="font-weight:600;margin-bottom:4px">${s}</div>`;
export const ttNote = (s: string) => `<div style="opacity:.7;font-size:11px;margin-top:4px">${s}</div>`;

/** HTML legend (used where ECharts' built-in legend would collide with direct labels). */
export function Legend({ items, className = "" }: { items: { label: string; color: string; shape?: "dot" | "line" | "square" | "dash" }[]; className?: string }) {
  return (
    <ul className={`flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fog ${className}`} aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          <Key color={i.color} shape={i.shape} />{i.label}
        </li>
      ))}
    </ul>
  );
}

export function Key({ color, shape = "line" }: { color: string; shape?: "dot" | "line" | "square" | "dash" }) {
  if (shape === "dot") return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} aria-hidden />;
  if (shape === "square") return <span className="inline-block w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: color }} aria-hidden />;
  if (shape === "dash") return <span className="inline-block w-3.5 h-0 border-t-2 border-dashed shrink-0" style={{ borderColor: color }} aria-hidden />;
  return <span className="inline-block w-3.5 h-[2px] rounded shrink-0" style={{ background: color }} aria-hidden />;
}

/** Stat tile: label · value · optional sub-line. Text stays in ink tokens. */
export function Stat({ label, value, sub, accent }: { label: ReactNode; value: ReactNode; sub?: ReactNode; accent?: ReactNode }) {
  return (
    <div className="rounded-lg bg-ridge2/50 border border-line/50 px-3 py-2.5 min-w-0">
      <div className="text-[10px] uppercase tracking-[0.12em] text-fog font-semibold flex items-center gap-1.5">{accent}{label}</div>
      <div className="text-xl font-semibold tabular leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-fog mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

export function Empty({ h = 220, children }: { h?: number; children: ReactNode }) {
  return <div className="flex items-center justify-center text-center text-xs text-fog px-6 border border-dashed border-line/60 rounded-lg" style={{ minHeight: h }}>{children}</div>;
}

/** p-value in reporting style. */
export function pval(p: number | null | undefined) {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  if (p < 0.001) return "p < 0.001";
  return `p = ${p.toFixed(p < 0.01 ? 3 : 2)}`;
}

export const cleanName = (s: string | null | undefined) => String(s ?? "").replace(" (Synthetic)", "");
