import { useMemo } from "react";
import { EChart, base } from "@/components/charts/EChart";
import { DataTable } from "@/components/ui";
import { fmt, int } from "@/lib/format";
import { Legend, tooltip, ttHead, ttRow, usePalette, xAxis, yAxis } from "./kit";
import { PROVINCE, TIER_LABEL, type KmRow, type SurvSummary } from "./types";

export type GroupVar = "facility_tier" | "stage" | "age_band" | "province" | "hp_status" | "sex" | "period";
export const GROUPS: Record<GroupVar, { label: string; order: string[]; name?: (v: string) => string; missing?: string[] }> = {
  facility_tier: { label: "Testing tier", order: ["low", "medium", "high", "unknown"], name: (v) => TIER_LABEL[v] ?? v, missing: ["unknown"] },
  stage: { label: "Stage", order: ["I", "II", "III", "IV", "Unknown"], name: (v) => (v === "Unknown" ? "Stage unknown" : `Stage ${v}`), missing: ["Unknown"] },
  hp_status: { label: "HP status", order: ["Positive", "Negative", "Never tested"], name: (v) => `HP ${v.toLowerCase()}`, missing: ["Never tested"] },
  age_band: { label: "Age band", order: ["<50", "50-64", "65+"], name: (v) => (v === "<50" ? "Under 50" : v === "65+" ? "65 and over" : "50–64") },
  province: { label: "Province", order: ["KGL", "NOR", "SOU", "EAS", "WES"], name: (v) => PROVINCE[v] ?? v },
  sex: { label: "Sex", order: ["F", "M"], name: (v) => (v === "F" ? "Female" : "Male") },
  period: { label: "Period", order: ["2015-2019", "2020+"], name: (v) => `Diagnosed ${v.replace("-", "–")}` },
};

const MO = 30.4375;
const GRID = { left: 122, right: 132 };
const RISK_T = [0, 360, 720, 1080, 1440, 1800];

export function useGroupColors(gv: GroupVar, values: string[]) {
  const { series: S, ink: k } = usePalette();
  const g = GROUPS[gv];
  let slot = 0;
  const out: Record<string, string> = {};
  // testing tiers keep the tier colours used on the funnel plot (low = signal, medium = grey, high = sky)
  if (gv === "facility_tier") { [...g.order, ...values].forEach((v) => { out[v] = v === "low" ? S[1] : v === "medium" ? S[3] : v === "high" ? S[0] : k.muted; }); return out; }
  [...g.order, ...values.filter((v) => !g.order.includes(v))].forEach((v) => {
    out[v] = g.missing?.includes(v) ? k.muted : S[slot++ % S.length];
  });
  return out;
}

const groupsOf = (rows: KmRow[], gv: GroupVar) => {
  const vals = Array.from(new Set(rows.map((r) => r.group_value)));
  const order = GROUPS[gv].order;
  return vals.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
};

/** Direct end labels only when there are <= 4 curves and their end values sit >= 6 points apart (otherwise legend + risk table). */
export function endLabelsFit(rows: KmRow[], groups: string[]) {
  if (groups.length > 4) return false;
  const ends = groups.map((g) => { const p = rows.filter((r) => r.group_value === g); return 100 * (p[p.length - 1]?.surv ?? 0); }).sort((a, b) => a - b);
  return ends.every((v, i) => i === 0 || v - ends[i - 1] >= 6);
}

/** Kaplan-Meier curves with 95% CI bands (Greenwood), 1-year guide and direct end labels when ≤ 4 groups. */
export function KmChart({ rows, gv }: { rows: KmRow[]; gv: GroupVar }) {
  const { ink: k, mode } = usePalette();
  const groups = groupsOf(rows, gv);
  const colors = useGroupColors(gv, groups);
  const option = useMemo(() => {
    const name = GROUPS[gv].name ?? ((v: string) => v);
    const series: any[] = [];
    const direct = endLabelsFit(rows, groups);
    groups.forEach((g) => {
      const pts = rows.filter((r) => r.group_value === g);
      const c = colors[g];
      // CI band as one step-shaped polygon (upper edge forward, lower edge back) - no stacking tricks
      const up: number[][] = [], lo: number[][] = [];
      pts.forEach((p, i) => {
        const x0 = p.t_days / MO, x1 = i + 1 < pts.length ? pts[i + 1].t_days / MO : x0;
        up.push([x0, 100 * p.uci], [x1, 100 * p.uci]);
        lo.push([x0, 100 * p.lci], [x1, 100 * p.lci]);
      });
      const poly = [...up, ...lo.reverse()];
      series.push({ name: `__band_${g}`, type: "custom", silent: true, z: 1, tooltip: { show: false }, data: [0],
        renderItem: (_: any, api: any) => ({ type: "polygon", shape: { points: poly.map((q) => api.coord(q)) },
          style: { fill: c, opacity: mode === "dark" ? 0.13 : 0.1 } }) });
      series.push({
        name: name(g), type: "line", step: "end", symbol: "none", z: 3, data: pts.map((p) => [p.t_days / MO, 100 * p.surv, p.n_at_risk, 100 * p.lci, 100 * p.uci]),
        lineStyle: { width: 2, color: c, cap: "round", join: "round" }, itemStyle: { color: c },
        labelLayout: { moveOverlap: "shiftY" },
        endLabel: direct ? { show: true, color: k.secondary, fontSize: 10, distance: 6,
          formatter: (p: any) => `${name(g)}  ${Math.round(p.value[1])}%` } : undefined,
        emphasis: { focus: "series" },
      });
    });
    return {
      ...base(),
      grid: { left: GRID.left, right: GRID.right, top: 22, bottom: 34 },
      legend: { show: false },
      tooltip: tooltip({
        trigger: "axis",
        formatter: (ps: any[]) => {
          const main = ps.filter((p) => !String(p.seriesName).startsWith("__"));
          if (!main.length) return "";
          const t = main[0].value[0];
          return ttHead(`${fmt(t, 0)} months after diagnosis`) + main.map((p) =>
            ttRow(p.color, p.seriesName, `${fmt(p.value[1], 0)}% <span style="opacity:.6;font-weight:400">(${fmt(p.value[3], 0)}–${fmt(p.value[4], 0)}), ${int(p.value[2])} at risk</span>`, "line")).join("");
        },
      }),
      xAxis: xAxis({ type: "value", min: 0, max: 60, interval: 12, axisLabel: { color: k.muted, formatter: (v: number) => `${v}` },
                     name: "Months since diagnosis", nameLocation: "middle", nameGap: 22, nameTextStyle: { color: k.muted, fontSize: 11 } }),
      yAxis: yAxis({ type: "value", min: 0, max: 100, interval: 25, axisLabel: { color: k.muted, formatter: "{value}%" } }),
      series: [
        ...series,
        { name: "__1y", type: "line", silent: true, data: [], tooltip: { show: false },
          markLine: { silent: true, symbol: "none", lineStyle: { color: k.axis, type: "solid", width: 1 },
                      label: { formatter: "1 year", color: k.muted, fontSize: 10, position: "end" }, data: [{ xAxis: 12 }] } },
      ],
    } as any;
  }, [rows, gv, groups.join("|"), colors, k, mode]);
  const nm = GROUPS[gv].name ?? ((v: string) => v);
  return (
    <div>
      <Legend className="mb-1 pl-[122px]" items={groups.map((g) => ({ label: nm(g), color: colors[g], shape: "line" as const }))} />
      <EChart option={option} height={300} ariaLabel={`Kaplan-Meier survival curves by ${GROUPS[gv].label.toLowerCase()}`} />
    </div>
  );
}

/** Numbers-at-risk table aligned with the KM x-axis; summary columns sit under the end-label gutter. */
export function RiskTable({ rows, gv, summary }: { rows: KmRow[]; gv: GroupVar; summary: SurvSummary[] }) {
  const groups = groupsOf(rows, gv);
  const colors = useGroupColors(gv, groups);
  const name = GROUPS[gv].name ?? ((v: string) => v);
  const at = (g: string, t: number) => {
    const pts = rows.filter((r) => r.group_value === g && r.t_days <= t);
    return pts.length ? pts[pts.length - 1].n_at_risk : null;
  };
  return (
    <div className="text-[11px] tabular" role="table" aria-label="Numbers at risk">
      <div className="flex items-end border-b border-hairline pb-1.5 mb-1.5 text-[11px] text-muted" role="row">
        <div style={{ width: GRID.left }} className="shrink-0" role="columnheader">Number at risk</div>
        <div className="relative flex-1 h-3">{RISK_T.map((t) => (
          <span key={t} role="columnheader" className="absolute -translate-x-1/2" style={{ left: `${(t / MO / 60) * 100}%` }}>{Math.round(t / MO / 12) * 12}</span>))}</div>
        <div style={{ width: GRID.right }} className="shrink-0 grid grid-cols-2 text-right pl-3" role="row">
          <span role="columnheader">1-yr</span><span role="columnheader">Median</span></div>
      </div>
      {groups.map((g) => {
        const s = summary.find((x) => x.group_value === g);
        return (
          <div key={g} className="flex items-center h-[18px]" role="row">
            <div style={{ width: GRID.left }} className="shrink-0 flex items-center gap-1.5 truncate pr-2" role="rowheader">
              <span className="w-3.5 h-[2px] rounded shrink-0" style={{ background: colors[g] }} aria-hidden /><span className="truncate">{name(g)}</span>
            </div>
            <div className="relative flex-1 h-full">{RISK_T.map((t) => (
              <span key={t} role="cell" className="absolute top-0.5 -translate-x-1/2 text-fg" style={{ left: `${(t / MO / 60) * 100}%` }}>{at(g, t) ?? "—"}</span>))}</div>
            <div style={{ width: GRID.right }} className="shrink-0 grid grid-cols-2 text-right pl-3" role="cell">
              <span className="font-semibold">{s ? `${fmt(100 * s.surv_1y, 0)}%` : "—"}</span>
              <span className="text-muted">{s?.median_surv_days ? `${fmt(s.median_surv_days / MO, 1)} mo` : "—"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function KmTable({ rows, gv, summary }: { rows: KmRow[]; gv: GroupVar; summary: SurvSummary[] }) {
  const name = GROUPS[gv].name ?? ((v: string) => v);
  const pick = rows.filter((r) => r.t_days % 180 === 0);
  return (
    <div className="flex flex-col gap-3">
      <DataTable rows={summary} columns={[
        { key: "group_value", label: GROUPS[gv].label, fmt: name }, { key: "n", label: "Patients", num: true, fmt: int },
        { key: "surv_1y", label: "1-yr survival", num: true, fmt: (v) => `${fmt(100 * v, 1)}%` },
        { key: "surv_2y", label: "2-yr survival", num: true, fmt: (v) => `${fmt(100 * v, 1)}%` },
        { key: "median_surv_days", label: "Median (months)", num: true, fmt: (v) => (v ? fmt(v / MO, 1) : "—") },
      ]} />
      <DataTable rows={pick} columns={[
        { key: "group_value", label: GROUPS[gv].label, fmt: name }, { key: "t_days", label: "Months", num: true, fmt: (v) => fmt(v / MO, 0) },
        { key: "surv", label: "Survival", num: true, fmt: (v) => `${fmt(100 * v, 1)}%` },
        { key: "lci", label: "95% CI", num: true, fmt: (_, r) => `[${fmt(100 * r.lci, 1)}–${fmt(100 * r.uci, 1)}]` },
        { key: "n_at_risk", label: "At risk", num: true, fmt: int }, { key: "n_events", label: "Deaths (cum.)", num: true, fmt: int },
      ]} />
    </div>
  );
}
