import { useMemo } from "react";
import { EChart, base } from "@/components/charts/EChart";
import { DataTable } from "@/components/ui";
import { fmt } from "@/lib/format";
import { tooltip, ttHead, ttNote, ttRow, usePalette, xAxis, yAxis } from "../quality/kit";
import { featureLabel } from "./labels";
import type { Importance } from "./types";

/** Mean |SHAP| bars for the XGBoost model; the HIV negative control is always shown (pinned below a gap if outside the top N). */
export function ImportanceBars({ rows, hiv, top = 15 }: { rows: Importance[]; hiv?: { rank?: number; mean_abs_shap?: number } | null; top?: number }) {
  const { series: S, ink: k, mode } = usePalette();
  const option = useMemo(() => {
    const head = rows.slice(0, top);
    const pinned = hiv?.rank && hiv.rank > top ? [{ feature: "__gap", mean_abs_shap: 0, rank: 0 }, { feature: "hiv", mean_abs_shap: hiv.mean_abs_shap ?? 0, rank: hiv.rank }] : [];
    const all = [...head, ...pinned];
    const c = S[0]; // data hue (the identity colour of XGBoost is kept for the curve charts)
    const max = Math.max(...all.map((r) => r.mean_abs_shap), 0.001);
    return {
      ...base(),
      grid: { left: 176, right: 54, top: 4, bottom: 38 },
      legend: { show: false },
      tooltip: tooltip({
        trigger: "item",
        formatter: (p: any) => {
          const r = all[p.dataIndex];
          if (!r || r.feature === "__gap") return "";
          return ttHead(featureLabel(r.feature)) + ttRow(p.color, "Mean |SHAP|", fmt(r.mean_abs_shap, 4)) + ttRow(k.secondary, "Rank", `#${r.rank} of ${rows.length >= 30 ? "30+" : rows.length}`) +
            (r.feature === "hiv" ? ttNote("Negative control: should be near zero (rank above 30)") : ttNote(`<code>${r.feature}</code>`));
        },
      }),
      xAxis: xAxis({ type: "value", min: 0, max: max * 1.05, axisLabel: { color: k.muted, formatter: (v: number) => fmt(v, 2) },
                     splitLine: { show: true, lineStyle: { color: k.grid } }, axisLine: { show: false },
                     name: "mean |SHAP| (log-odds)", nameLocation: "middle", nameGap: 24, nameTextStyle: { color: k.muted, fontSize: 10 } }),
      yAxis: yAxis({ type: "category", inverse: true, data: all.map((r) => r.feature), axisLine: { show: false },
        axisLabel: { interval: 0, fontSize: 11, formatter: (f: string) => (f === "__gap" ? "{g|· · ·}" : f === "hiv" ? `{h|${featureLabel(f)}}` : `{n|${featureLabel(f)}}`),
                     rich: { n: { color: k.secondary, fontSize: 11 }, h: { color: k.primary, fontSize: 11, fontWeight: 700 }, g: { color: k.muted } } } }),
      series: [{
        type: "bar", barWidth: 10,
        data: all.map((r) => ({
          value: r.feature === "__gap" ? null : r.mean_abs_shap,
          itemStyle: r.feature === "hiv" ? { color: "transparent", borderColor: k.secondary, borderWidth: 1.25, borderType: "solid", borderRadius: [0, 4, 4, 0] }
                                         : { color: c, borderRadius: [0, 4, 4, 0] },
          label: { show: r.feature !== "__gap", position: "right", color: r.feature === "hiv" ? k.primary : k.secondary, fontSize: 10,
                   formatter: () => (r.feature === "hiv" ? `#${r.rank}` : fmt(r.mean_abs_shap, 3)) },
        })),
        emphasis: { itemStyle: { opacity: 0.85 } },
      }],
    } as any;
  }, [rows, hiv, top, S, k, mode]);
  const n = rows.slice(0, top).length + (hiv?.rank && hiv.rank > top ? 2 : 0);
  return <EChart option={option} height={Math.max(220, n * 22 + 46)} ariaLabel="Feature importance (mean absolute SHAP) for the XGBoost model" />;
}

export function ImportanceTable({ rows }: { rows: Importance[] }) {
  return <DataTable rows={rows} columns={[{ key: "rank", label: "#", num: true }, { key: "feature", label: "Feature", fmt: (v) => featureLabel(v) },
    { key: "_col", label: "Column", fmt: (_, r) => <code className="text-fg-muted">{r.feature}</code> }, { key: "mean_abs_shap", label: "Mean |SHAP|", num: true, fmt: (v) => fmt(v, 4) }]} />;
}
