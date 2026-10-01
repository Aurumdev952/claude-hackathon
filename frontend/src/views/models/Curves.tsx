import { useMemo } from "react";
import { EChart, base } from "@/components/charts/EChart";
import { DataTable } from "@/components/ui";
import { fmt } from "@/lib/format";
import { Legend, tooltip, ttHead, ttRow, usePalette, xAxis, yAxis } from "../quality/kit";
import { TIER_META, type Curves } from "./types";

export type ModelCurves = { model_id: string; tier: number; curves: Curves & { lead_cum?: { x: number; y: number }[] } };

/** Cumulative lead time: share of test-period cases first flagged HIGH at least m months before diagnosis.
 * pctEver (from the metrics row) rescales flagged-case counts to all cases; without it, shares are of flagged cases. */
export function withCumulative(m: ModelCurves, pctEver?: number | null): ModelCurves {
  const h = m.curves.lead_time ?? [];
  const tot = h.reduce((s, p) => s + p.y, 0);
  if (!tot) return m;
  const scale = (pctEver ?? 100) / 100;
  const cum = Array.from({ length: 25 }, (_, mm) => ({ x: mm, y: (scale * h.filter((p) => p.x >= mm).reduce((s, p) => s + p.y, 0)) / tot }));
  return { ...m, curves: { ...m.curves, lead_cum: cum } };
}
export type Kind = "roc" | "pr" | "calibration" | "lead_time" | "lead_cum";

const name = (t: number) => TIER_META[t]?.short ?? `Tier ${t}`;

export function CurveLegend({ models, extra = [] }: { models: ModelCurves[]; extra?: { label: string; color: string; shape?: "line" | "dash" | "dot" }[] }) {
  const { series: S } = usePalette();
  return <Legend className="mb-1" items={[...models.map((m) => ({ label: name(m.tier), color: S[TIER_META[m.tier].slot], shape: "line" as const })), ...extra]} />;
}

/** One chart per curve family (never dual-axis). ROC + PR + calibration share the same mechanics. */
export function CurveChart({ kind, models, prevalence, height = 280 }: { kind: Kind; models: ModelCurves[]; prevalence?: number | null; height?: number }) {
  const { series: S, ink: k, mode } = usePalette();
  const option = useMemo(() => {
    const ms = models.filter((m) => (m.curves[kind] ?? []).length);
    const pctFmt = (v: number) => `${Math.round(v * 100)}%`;
    let xMax = 1, yMax = 1;
    if (kind === "calibration") {
      const all = ms.flatMap((m) => m.curves.calibration ?? []);
      const mx = Math.max(0.01, ...all.map((p) => Math.max(p.x, p.y)));
      const step = mx > 0.2 ? 0.1 : mx > 0.1 ? 0.05 : 0.02;
      xMax = yMax = Math.ceil((mx * 1.08) / step) * step;
    }
    if (kind === "pr") yMax = Math.min(1, Math.ceil((Math.max(0.05, ...ms.flatMap((m) => (m.curves.pr ?? []).filter((p) => p.x > 0.02).map((p) => p.y))) * 1.1) * 10) / 10);
    const lead = kind === "lead_time" || kind === "lead_cum";
    const cum = kind === "lead_cum";
    const ref: any[] = [];
    if (kind === "roc" || kind === "calibration")
      ref.push({ name: kind === "roc" ? "Chance" : "Perfect calibration", type: "line", silent: true, showSymbol: false, z: 1, tooltip: { show: false },
                 data: [[0, 0], [xMax, yMax]], lineStyle: { color: k.muted, width: 1, type: [4, 4] } });
    if (kind === "pr" && prevalence)
      ref.push({ name: "Prevalence", type: "line", silent: true, showSymbol: false, z: 1, tooltip: { show: false },
                 data: [[0, prevalence], [1, prevalence]], lineStyle: { color: k.muted, width: 1, type: [4, 4] } });
    const series = ms.map((m) => {
      const c = S[TIER_META[m.tier].slot];
      const pts = (m.curves[kind] ?? []).map((p) => [p.x, p.y]);
      return {
        name: name(m.tier), type: "line", z: 3, data: pts, step: kind === "lead_time" ? "middle" : undefined,
        showSymbol: kind === "calibration", symbol: "circle", symbolSize: 8,
        itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
        lineStyle: { width: 2, color: c, cap: "round", join: "round" },
        areaStyle: undefined,
        emphasis: { focus: "series" },
      };
    });
    const axisNames: Record<Kind, [string, string]> = {
      roc: ["False-positive rate (1 − specificity)", "Sensitivity"], pr: ["Recall (sensitivity)", "Precision (PPV)"],
      calibration: ["Predicted 12-month risk", "Observed cancer rate"], lead_time: ["Months before diagnosis when first flagged HIGH", "Cases"],
      lead_cum: ["Months before diagnosis", "Cases flagged at least this early"],
    };
    return {
      ...base(),
      grid: { left: 60, right: 18, top: 14, bottom: 42 },
      legend: { show: false },
      tooltip: tooltip({
        trigger: "axis",
        formatter: (ps: any[]) => {
          const ps2 = ps.filter((p) => !["Chance", "Perfect calibration", "Prevalence"].includes(p.seriesName));
          if (!ps2.length) return "";
          const head = kind === "roc" ? `FPR ${pctFmt(ps2[0].value[0])}` : kind === "pr" ? `Recall ${pctFmt(ps2[0].value[0])}`
            : kind === "calibration" ? `Predicted ≈ ${fmt(100 * ps2[0].value[0], 1)}%` : cum ? `Flagged ≥ ${ps2[0].value[0]} months before diagnosis` : `First flagged ${ps2[0].value[0]}–${ps2[0].value[0] + 1} months before diagnosis`;
          return ttHead(head) + ps2.map((p) => ttRow(p.color, p.seriesName,
            kind === "lead_time" ? `${p.value[1]} cases` : cum ? `${fmt(100 * p.value[1], 0)}% of cases` : kind === "calibration" ? `observed ${fmt(100 * p.value[1], 1)}% at ${fmt(100 * p.value[0], 1)}%` : pctFmt(p.value[1]), "line")).join("");
        },
      }),
      xAxis: xAxis({ type: "value", min: 0, max: lead ? 24 : xMax, inverse: lead, interval: lead ? 3 : undefined,
                     axisLabel: { color: k.muted, formatter: lead ? (v: number) => (v === 0 ? "dx" : `${v}`) : (v: number) => (kind === "calibration" ? `${Math.round(v * 100)}%` : pctFmt(v)) },
                     name: axisNames[kind][0], nameLocation: "middle", nameGap: 26, nameTextStyle: { color: k.muted, fontSize: 11 } }),
      yAxis: yAxis({ type: "value", min: 0, max: lead ? (cum ? 1 : undefined) : yMax, minInterval: kind === "lead_time" ? 1 : undefined,
                     axisLabel: { color: k.muted, formatter: kind === "lead_time" ? "{value}" : (v: number) => (kind === "calibration" ? `${Math.round(v * 100)}%` : pctFmt(v)) },
                     name: axisNames[kind][1], nameLocation: "middle", nameGap: 44, nameTextStyle: { color: k.muted, fontSize: 11 } }),
      series: [...ref, ...series, ...(cum ? [{ name: "__3m", type: "line", data: [], silent: true, markLine: { silent: true, symbol: "none",
        lineStyle: { color: k.axis, type: "solid", width: 1 }, label: { formatter: "3 months", color: k.muted, fontSize: 10, position: "end" }, data: [{ xAxis: 3 }] } }] : [])],
    } as any;
  }, [kind, models, prevalence, S, k, mode]);
  return <EChart option={option} height={height} ariaLabel={`${kind} curves by model`} />;
}

export function CurveTable({ kind, models }: { kind: Kind; models: ModelCurves[] }) {
  const rows = models.flatMap((m) => (m.curves[kind] ?? []).filter((_, i, a) => kind !== "roc" && kind !== "pr" ? true : i % Math.max(1, Math.floor(a.length / 25)) === 0)
    .map((p) => ({ model: name(m.tier), x: p.x, y: p.y })));
  const lbl: Record<Kind, [string, string]> = { roc: ["FPR", "Sensitivity"], pr: ["Recall", "Precision"], calibration: ["Predicted", "Observed"], lead_time: ["Months before dx", "Cases first flagged"], lead_cum: ["Months before dx", "Flagged at least this early"] };
  const f = (v: number, col: "x" | "y") => (kind === "lead_time" || (kind === "lead_cum" && col === "x") ? String(v) : `${fmt(100 * v, 1)}%`);
  return <DataTable rows={rows} columns={[{ key: "model", label: "Model" }, { key: "x", label: lbl[kind][0], num: true, fmt: (v) => f(v, "x") }, { key: "y", label: lbl[kind][1], num: true, fmt: (v) => f(v, "y") }]} />;
}
