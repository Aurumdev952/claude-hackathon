import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { Microscope } from "lucide-react";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { Card, chartDetailTabs, DataTable, Loading, StatTile } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int, monthYear } from "@/lib/format";
import { HUE, ink } from "@/lib/viz";
import { bandSeries, chartBase, tipHead, tipRow } from "../trends/kit";
import { useOperational, type CapacityRow } from "./api";
import { Swatch } from "./kit";

const sum = (xs: { mean: number }[] | undefined) => (xs ?? []).reduce((a, x) => a + (x.mean ?? 0), 0);
const shortMonth = (s: string) => new Date(s).toLocaleDateString("en-GB", { month: "short" });

/** Next 12 months (operational forecast): national endoscopy demand against capacity by month, the 12-month totals,
 * and the districts where expected demand exceeds the current endoscopy capacity. */
export function CapacityCard() {
  const q = useOperational();
  const m = useThemeMode();
  const d = q.data?.data;
  const met = d?.metrics ?? {};
  const demand = met.endoscopy_demand ?? [], cap = met.endoscopy_capacity ?? [];
  const option = useMemo<EChartsOption | null>(() => {
    if (!demand.length) return null;
    const b = chartBase(), k = ink(), h = HUE[m];
    return {
      ...b, grid: { left: 36, right: 12, top: 14, bottom: 24 },
      xAxis: { ...b.xAxis, type: "category", data: demand.map((p) => p.month), boundaryGap: false, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: string) => shortMonth(v), interval: 1 } },
      yAxis: { ...b.yAxis, type: "value", min: 0, splitNumber: 3 },
      tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => {
        const i = ps[0].dataIndex, p = demand[i], c = cap[i];
        return tipHead(monthYear(p.month)) + tipRow(h.sky, "Endoscopies needed", fmt(p.mean, 0), p.lo80 !== null ? `80% ${int(p.lo80)}–${int(p.hi80)}` : "")
          + (c ? tipRow(k.primary, "Capacity", fmt(c.mean, 0)) : "");
      } },
      series: [
        bandSeries("80%", demand.map((p, i) => ({ x: i, lo: p.lo80, hi: p.hi80 })), h.sky, { opacity: m === "dark" ? 0.2 : 0.18 }),
        { type: "line", name: "Needed", data: demand.map((p) => p.mean), showSymbol: false, lineStyle: { width: 2.5, color: h.sky }, z: 4 },
        { type: "line", name: "Capacity", data: cap.map((p) => p.mean), showSymbol: false, step: "middle", lineStyle: { width: 1.75, color: k.primary, type: [5, 4] }, z: 3 },
      ],
    } as EChartsOption;
  }, [demand, cap, m]);
  const short = useMemo(() => [...(d?.capacity_by_district ?? [])].filter((r) => (r.demand_12m ?? 0) - (r.capacity_12m ?? 0) >= 0.5)
    .sort((a, b) => b.gap_12m - a.gap_12m), [d]);
  const top = short.slice(0, 5);
  const maxD = Math.max(1, ...top.map((r) => Math.max(r.demand_12m ?? 0, r.capacity_12m ?? 0)));
  const h = HUE[m], k = ink();
  return (
    <Card title="Next 12 months" icon={<Microscope size={16} />} className="h-full" bodyClassName="flex flex-col"
          info={{ about: "Operational forecast for the coming year: endoscopies the flagged and symptomatic patients will need, against what the units performed recently.",
                  method: d?.method }}
          detail={d ? { tabs: chartDetailTabs({ table: <DataTable ariaLabel="Endoscopy demand and capacity by district" rows={[...d.capacity_by_district].sort((a, b) => b.gap_12m - a.gap_12m)} columns={[
            { key: "name", label: "District" }, { key: "demand_12m", label: "Needed", num: true, fmt: (v) => fmt(v, 0) },
            { key: "capacity_12m", label: "Capacity", num: true, fmt: (v) => fmt(v, 0) }, { key: "gap_12m", label: "Gap", num: true, fmt: (v) => (v > 0.5 ? fmt(v, 0) : "") },
            { key: "high_flags_12m", label: "HIGH flags", num: true, fmt: (v) => fmt(v, 0) }, { key: "gi_visits_12m", label: "GI visits", num: true, fmt: (v) => fmt(v, 0) }]} />,
            method: d.method, notes: "Synthetic EMR. Capacity is a planning reference, not a measured maximum." }), defaultTab: "table" } : undefined}
          detailLabel="Next 12 months: view as table">
      {q.isLoading ? <Loading h={320} /> : q.error ? <ErrorNote error={q.error} /> : d ? (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
            <StatTile label="Endoscopies needed" value={int(sum(demand))} sub="National, 12 months" />
            <StatTile label="Capacity" value={int(sum(cap))} sub="At the recent pace" />
            <StatTile label="GI visits" value={int(sum(met.gi_visits))} sub="Expected" />
            <StatTile label="Care tasks" value={int(sum(met.care_tasks))} sub="Follow-up load" />
          </div>
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mt-4 flex-1">
            <div className="min-w-0">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Swatch kind="line" color={h.sky} label="Needed, 80% band" />
                <Swatch kind="dash" color={k.primary} label="Capacity" />
              </div>
              {option && <EChart option={option} height={190} ariaLabel="Monthly endoscopy demand against capacity, next 12 months" />}
            </div>
            <div className="min-w-0">
              <div className="text-label text-muted mb-2">{short.length ? `${short.length} districts short of endoscopy capacity` : "Every district has enough capacity"}</div>
              <ul className="flex flex-col gap-2.5" aria-label="Districts short of capacity">
                {top.map((r) => <ShortRow key={r.district_code} r={r} max={maxD} />)}
              </ul>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function ShortRow({ r, max }: { r: CapacityRow; max: number }) {
  const m = useThemeMode();
  const h = HUE[m];
  const dem = r.demand_12m ?? 0, cap = r.capacity_12m ?? 0;
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="w-1.5 h-1.5 rounded-full bg-signal shrink-0 -translate-y-0.5" aria-hidden />
        <span className="text-ink truncate flex-1">{r.name}</span>
        <span className="text-ink font-medium tabular whitespace-nowrap">{cap ? `Short by ${fmt(dem - cap, 0)}` : "No unit"}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-tile mt-1.5 ml-3.5" role="img" aria-label={`${r.name}: ${fmt(dem, 0)} endoscopies needed, capacity ${fmt(cap, 0)}`}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(100 * dem) / max}%`, background: h.sky }} />
        {cap > 0 && <div className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-ink" style={{ left: `${(100 * cap) / max}%` }} />}
      </div>
      <div className="text-micro text-muted tabular ml-3.5 mt-0.5">{fmt(dem, 0)} needed, capacity {fmt(cap, 0)}</div>
    </li>
  );
}
