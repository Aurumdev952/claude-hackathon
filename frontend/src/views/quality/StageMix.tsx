import { useMemo } from "react";
import { EChart, base } from "@/components/charts/EChart";
import { DataTable, StatusChip } from "@/components/ui";
import { fmt, int } from "@/lib/format";
import { hexToRgb } from "@/lib/viz";
import { Legend, pval, stageRamp, tooltip, ttHead, ttRow, usePalette, xAxis, yAxis } from "./kit";
import { TIER_LABEL, type ChiSquare, type StageTierRow } from "./types";

const STAGES = ["I", "II", "III", "IV"];
const TIER_ROWS = ["low", "medium", "high", "unknown"];

const lum = (hex: string) => { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

export function stageColors(m: "dark" | "light", muted: string) {
  const r = stageRamp(m);
  return { I: r[0], II: r[1], III: r[2], IV: r[3], Unknown: muted } as Record<string, string>;
}

/** Stage at diagnosis by the first-GI facility's H. pylori testing tier: 100% stacked bars with 2px surface gaps. */
export function StageMix({ rows, includeUnknown }: { rows: StageTierRow[]; includeUnknown: boolean }) {
  const { ink: k, mode } = usePalette();
  const option = useMemo(() => {
    const col = stageColors(mode, mode === "dark" ? "#5d6b77" : "#b9c2c9");
    const stages = includeUnknown ? [...STAGES, "Unknown"] : STAGES;
    const tiers = TIER_ROWS.filter((t) => rows.some((r) => r.facility_tier === t));
    const val = (t: string, s: string) => {
      const r = rows.find((x) => x.facility_tier === t && x.stage_group === s);
      return r ? (includeUnknown ? r.pct : r.pct_known ?? 0) : 0;
    };
    const nOf = (t: string) => rows.filter((x) => x.facility_tier === t && (includeUnknown || x.stage_group !== "Unknown")).reduce((s, x) => s + x.n, 0);
    return {
      ...base(),
      grid: { left: 118, right: 12, top: 6, bottom: 26 },
      legend: { show: false },
      tooltip: tooltip({
        trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: k.grid } },
        formatter: (ps: any[]) => {
          const t = tiers[ps[0].dataIndex];
          return ttHead(`${TIER_LABEL[t]} · n = ${int(nOf(t))}`) + ps.map((p) => {
            const r = rows.find((x) => x.facility_tier === t && x.stage_group === p.seriesName);
            return ttRow(p.color, `Stage ${p.seriesName}`, `${fmt(p.value, 1)}% (${int(r?.n ?? 0)})`, "dot");
          }).join("");
        },
      }),
      xAxis: xAxis({ type: "value", min: 0, max: 100, interval: 25, axisLabel: { color: k.muted, formatter: "{value}%" },
                     splitLine: { show: true, lineStyle: { color: k.grid } }, axisLine: { show: false } }),
      yAxis: yAxis({ type: "category", inverse: true, data: tiers, axisLine: { show: false },
        axisLabel: { color: k.secondary, formatter: (t: string) => `{a|${TIER_LABEL[t]}}\n{b|n = ${int(nOf(t))}}`,
                     rich: { a: { color: k.primary, fontSize: 11, fontWeight: 600, lineHeight: 15 }, b: { color: k.muted, fontSize: 10 } } } }),
      series: stages.map((s) => ({
        name: s, type: "bar", stack: "s", barWidth: 22,
        data: tiers.map((t) => ({ value: val(t, s), itemStyle: { opacity: t === "unknown" ? 0.7 : 1 } })),
        itemStyle: { color: col[s], borderColor: k.surface, borderWidth: 2, borderRadius: 0 },
        label: { show: true, position: "inside", fontSize: 10, fontWeight: s === "IV" ? 700 : 500,
                 color: lum(col[s]) > 0.55 ? "#1B2430" : "#FFFFFF",
                 formatter: (p: any) => (p.value >= 9 ? `${Math.round(p.value)}%` : "") },
        emphasis: { focus: "series" },
      })),
    } as any;
  }, [rows, includeUnknown, k, mode]);
  return <EChart option={option} height={210} ariaLabel="Stage at diagnosis by facility testing tier, stacked percentage bars" />;
}

export function StageLegend({ includeUnknown }: { includeUnknown: boolean }) {
  const { mode } = usePalette();
  const col = stageColors(mode, mode === "dark" ? "#5d6b77" : "#b9c2c9");
  return <Legend items={[...STAGES, ...(includeUnknown ? ["Unknown"] : [])].map((s) => ({ label: s === "Unknown" ? "Stage unknown" : `Stage ${s}`, color: col[s], shape: "square" as const }))} />;
}

/** χ² result as chips under the stage bars (the reading sentence lives in the card ⓘ via ChiSquareNote). */
export function ChiSquareChips({ chi, rows }: { chi: ChiSquare; rows: StageTierRow[] }) {
  const iv = (t: string) => rows.find((r) => r.facility_tier === t && r.stage_group === "IV")?.pct_known ?? null;
  const lo = iv("low"), hi = iv("high");
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {chi ? <StatusChip status={chi.p < 0.05 ? "info" : "neutral"} icon={false} label={<span className="tabular">χ² {fmt(chi.chi2, 1)} · df {chi.dof} · {pval(chi.p)}</span>} title="Chi-square test, stage × tier (known stages)" />
           : <StatusChip status="neutral" label="χ² not available" />}
      {lo !== null && hi !== null && <StatusChip status="serious" label={<span className="tabular">Stage IV {fmt(lo, 0)}% low tier vs {fmt(hi, 0)}% high</span>} />}
    </div>
  );
}

export function ChiSquareNote({ chi, rows }: { chi: ChiSquare; rows: StageTierRow[] }) {
  const iv = (t: string) => rows.find((r) => r.facility_tier === t && r.stage_group === "IV")?.pct_known ?? null;
  const lo = iv("low"), hi = iv("high");
  return (
    <span>
      {chi && <>Chi-square test, stage × tier: χ² = {fmt(chi.chi2, 1)}, df = {chi.dof}, {pval(chi.p)}. </>}
      {lo !== null && hi !== null && <>Among cancers with a known stage, {fmt(lo, 0)}% first seen at low-testing facilities were stage IV, versus {fmt(hi, 0)}% at high-testing facilities. </>}
      {chi && chi.p < 0.05 ? "The stage distribution differs by tier more than chance would explain." : chi ? "No clear difference by tier." : ""}
    </span>
  );
}

export function StageTable({ rows }: { rows: StageTierRow[] }) {
  return <DataTable rows={rows} columns={[
    { key: "facility_tier", label: "Tier", fmt: (v) => TIER_LABEL[v] ?? v }, { key: "stage_group", label: "Stage" },
    { key: "n", label: "Cases", num: true, fmt: int }, { key: "pct", label: "% of all", num: true, fmt: (v) => `${fmt(v, 1)}%` },
    { key: "pct_known", label: "% of known stage", num: true, fmt: (v) => (v === null ? "—" : `${fmt(v, 1)}%`) },
  ]} />;
}
