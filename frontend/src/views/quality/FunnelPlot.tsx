import { useMemo } from "react";
import { AlertOctagon, AlertTriangle, ArrowUpCircle, CheckCircle2, CircleDashed, MinusCircle } from "lucide-react";
import { EChart, base } from "@/components/charts/EChart";
import { DataTable } from "@/components/ui/Panel";
import { STATUS } from "@/lib/viz";
import { fmt, int, pct } from "@/lib/format";
import { Legend, cleanName, tooltip, ttHead, ttNote, ttRow, usePalette, xAxis, yAxis } from "./kit";
import { FACILITY_TYPE, PROVINCE, TIER_LABEL, TIERS, type FacilityQ, type Tier } from "./types";

const short = (n: string) => cleanName(n).replace(" Health Centre", " HC").replace(" District Hospital", " DH");

export type TierMode = "tier" | "derived_tier";

export function tierColor(t: string | null | undefined, series: string[], muted: string) {
  const i = TIERS.indexOf(t as Tier);
  return i >= 0 ? series[i] : muted;
}

/** Standardised distance from the target (binomial z) - used to pick which outliers get a direct label. */
const zOf = (f: FacilityQ) => {
  const p0 = f.target_rate, n = f.n_dyspepsia;
  return n > 0 && f.hp_test_rate !== null ? (f.hp_test_rate - p0) / Math.sqrt((p0 * (1 - p0)) / n) : 0;
};

export const FLAG: Record<string, { label: string; short: string; status?: keyof typeof STATUS; Icon: typeof AlertOctagon }> = {
  LOW_OUTLIER: { label: "Below the 99.8% limit", short: "Low outlier (99.8%)", status: "critical", Icon: AlertOctagon },
  low: { label: "Below the 95% limit", short: "Low (95%)", status: "warning", Icon: AlertTriangle },
  within: { label: "Within control limits", short: "Within limits", Icon: MinusCircle },
  high: { label: "Above the 95% limit", short: "High (95%)", status: "good", Icon: CheckCircle2 },
  HIGH_OUTLIER: { label: "Above the 99.8% limit", short: "High outlier (99.8%)", status: "good", Icon: ArrowUpCircle },
  LOW_VOLUME: { label: "Too few dyspepsia patients (< 10) to judge", short: "Low volume", Icon: CircleDashed },
};

export function FlagChip({ flag }: { flag: string }) {
  const f = FLAG[flag] ?? FLAG.within;
  const c = f.status ? STATUS[f.status] : undefined;
  return (
    <span className="chip" style={c ? { background: `${c}22`, color: c, boxShadow: `inset 0 0 0 1px ${c}55` } : undefined}>
      <f.Icon size={11} aria-hidden /> <span className={c ? "" : "text-fog"}>{f.label}</span>
    </span>
  );
}

/** SPEC §12.7 funnel plot: HP testing proportion vs dyspepsia volume, exact binomial 95% / 99.8% limits around the national rate. */
export function FunnelPlot({ rows, tierMode, selected, onSelect, height = 430 }: {
  rows: FacilityQ[]; tierMode: TierMode; selected: number | null; onSelect: (id: number) => void; height?: number;
}) {
  const { series: S, ink: k, mode } = usePalette();
  const option = useMemo(() => {
    const pts = rows.filter((r) => r.outlier_flag !== "LOW_VOLUME" && r.hp_test_rate !== null);
    const lim = [...rows].filter((r) => r.n_dyspepsia >= 10).sort((a, b) => a.n_dyspepsia - b.n_dyspepsia);
    const target = 100 * (rows[0]?.target_rate ?? 0);
    const xMax = Math.ceil((Math.max(...pts.map((p) => p.n_dyspepsia), 100) * 1.04) / 50) * 50;
    // label the most extreme outliers only (never a label on every point)
    const byZ = [...pts].sort((a, b) => zOf(a) - zOf(b));
    const labelled = new Set([...byZ.slice(0, 3), ...byZ.slice(-3)].map((f) => f.location_id));
    const limitLine = (key: keyof FacilityQ, name: string, dashed: boolean, label?: string) => ({
      name, type: "line", silent: true, showSymbol: false, z: 1,
      data: lim.map((r) => [r.n_dyspepsia, Math.max(0, Math.min(100, 100 * (r[key] as number)))]),
      lineStyle: { width: dashed ? 1 : 1.25, color: k.secondary, opacity: dashed ? 0.55 : 0.8, type: dashed ? [4, 4] : "solid" },
      endLabel: label ? { show: true, formatter: label, color: k.muted, fontSize: 10, distance: 6 } : undefined,
      tooltip: { show: false },
    });
    const tierSeries = TIERS.map((t, i) => ({
      name: TIER_LABEL[t], type: "scatter", z: 3,
      data: pts.filter((p) => (p[tierMode] ?? "low") === t).map((p) => {
        const out = p.outlier_flag === "LOW_OUTLIER" || p.outlier_flag === "HIGH_OUTLIER";
        const mid = p.outlier_flag === "low" || p.outlier_flag === "high";
        const isLab = labelled.has(p.location_id) && p.location_id !== selected;
        return {
          value: [p.n_dyspepsia, 100 * (p.hp_test_rate ?? 0)], id: p.location_id, f: p,
          symbolSize: out ? 9 : mid ? 8 : 7,
          itemStyle: { opacity: out ? 0.95 : mid ? 0.75 : 0.45 },
          label: isLab ? { show: true, formatter: short(p.name),
                           position: zOf(p) < 0 ? "bottom" : "top", color: k.primary, fontSize: 10, distance: 6 } : undefined,
        };
      }),
      itemStyle: { color: S[i], borderColor: k.surface, borderWidth: 1 },
      emphasis: { scale: 1.6, itemStyle: { opacity: 1 } },
    }));
    const sel = pts.find((p) => p.location_id === selected);
    return {
      ...base(),
      grid: { left: 46, right: 56, top: 30, bottom: 40 },
      legend: { show: false },
      tooltip: tooltip({
        trigger: "item",
        formatter: (p: any) => {
          const f: FacilityQ | undefined = p.data?.f;
          if (!f) return "";
          return ttHead(cleanName(f.name)) +
            `<div style="opacity:.75;font-size:11px;margin:-2px 0 6px">${FACILITY_TYPE[f.facility_type] ?? f.facility_type} · ${PROVINCE[f.province_code] ?? f.province_code}</div>` +
            ttRow(p.color, "HP tested", `${pct(f.hp_test_rate, 1, 100)} (${int(f.n_hp_tested)}/${int(f.n_dyspepsia)})`) +
            ttRow(k.secondary, "95% limits", `${pct(f.funnel_lower95, 0, 100)}–${pct(f.funnel_upper95, 0, 100)}`, "line") +
            ttRow(k.secondary, "99.8% limits", `${pct(f.funnel_lower998, 0, 100)}–${pct(f.funnel_upper998, 0, 100)}`, "line") +
            ttNote(`${FLAG[f.outlier_flag]?.label ?? f.outlier_flag} · click for details`);
        },
      }),
      xAxis: xAxis({ type: "value", min: 0, max: xMax, axisLabel: { color: k.muted, showMaxLabel: false }, name: "Dyspepsia patients seen (2019 →)", nameLocation: "middle", nameGap: 26,
                     nameTextStyle: { color: k.muted, fontSize: 11 }, splitLine: { show: false } }),
      yAxis: yAxis({ type: "value", min: 0, max: Math.min(100, Math.ceil((Math.max(...pts.map((p) => 100 * (p.hp_test_rate ?? 0))) + 6) / 10) * 10), interval: 10, axisLabel: { color: k.muted, formatter: "{value}%" },
                     name: "% tested for H. pylori ≤ 90 days", nameTextStyle: { color: k.muted, fontSize: 10, align: "left", padding: [0, 0, 0, -38] } }),
      series: [
        limitLine("funnel_upper998", "Upper 99.8%", false, "99.8%"),
        limitLine("funnel_lower998", "Lower 99.8%", false),
        limitLine("funnel_upper95", "Upper 95%", true, "95%"),
        limitLine("funnel_lower95", "Lower 95%", true),
        { name: "National rate", type: "line", silent: true, showSymbol: false, z: 1, data: [[0, target], [xMax, target]],
          lineStyle: { width: 1.5, color: k.primary, opacity: 0.8 }, tooltip: { show: false },
          endLabel: { show: true, formatter: `${fmt(target, 0)}%`, color: k.primary, fontSize: 10, fontWeight: 600, distance: 6 } },
        ...tierSeries,
        ...(sel ? [{ name: "Selected", type: "scatter", z: 5, silent: true, tooltip: { show: false },
          data: [[sel.n_dyspepsia, 100 * (sel.hp_test_rate ?? 0)]], symbolSize: 18,
          label: { show: true, formatter: short(sel.name), position: zOf(sel) < 0 ? "bottom" : "top", distance: 8, color: k.primary, fontSize: 11, fontWeight: 700,
                   backgroundColor: k.surface, padding: [2, 4], borderRadius: 3 },
          itemStyle: { color: "transparent", borderColor: k.primary, borderWidth: 2 } }] : []),
      ],
      labelLayout: { hideOverlap: true },
    } as any;
  }, [rows, tierMode, selected, S, k, mode]);
  const onEvents = useMemo(() => ({ click: (e: any) => { if (e?.data?.id) onSelect(e.data.id); } }), [onSelect]);
  return (
    <div>
      <Legend className="mb-1" items={[
        ...TIERS.map((t, i) => ({ label: TIER_LABEL[t], color: S[i], shape: "dot" as const })),
        { label: "National rate", color: k.primary, shape: "line" },
        { label: "99.8% limits", color: k.secondary, shape: "line" },
        { label: "95% limits", color: k.secondary, shape: "dash" },
      ]} />
      <EChart option={option} height={height} onEvents={onEvents} ariaLabel="Funnel plot of H. pylori testing rate against dyspepsia volume per facility" />
    </div>
  );
}

export function FunnelTable({ rows, onSelect }: { rows: FacilityQ[]; onSelect: (id: number) => void }) {
  const sorted = [...rows].sort((a, b) => (a.hp_test_rate ?? 0) - (b.hp_test_rate ?? 0));
  return (
    <DataTable rows={sorted} columns={[
      { key: "name", label: "Facility", fmt: (v, r) => <button className="text-left hover:text-kivu hover:underline" onClick={() => onSelect(r.location_id)}>{cleanName(v)}</button> },
      { key: "district_code", label: "District" },
      { key: "tier", label: "Tier" },
      { key: "derived_tier", label: "Derived", fmt: (v) => v ?? "—" },
      { key: "n_dyspepsia", label: "Dyspepsia n", num: true, fmt: int },
      { key: "n_hp_tested", label: "Tested", num: true, fmt: int },
      { key: "hp_test_rate", label: "Rate", num: true, fmt: (v) => pct(v, 1, 100) },
      { key: "funnel_lower95", label: "95% limits", num: true, fmt: (_, r) => `${pct(r.funnel_lower95, 1, 100)}–${pct(r.funnel_upper95, 1, 100)}` },
      { key: "funnel_lower998", label: "99.8% limits", num: true, fmt: (_, r) => `${pct(r.funnel_lower998, 1, 100)}–${pct(r.funnel_upper998, 1, 100)}` },
      { key: "outlier_flag", label: "Status", fmt: (v) => FLAG[v]?.short ?? v },
    ]} />
  );
}
