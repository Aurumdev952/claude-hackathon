import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { Layers } from "lucide-react";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { Card, chartDetailTabs, DataTable, Loading } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int, signed } from "@/lib/format";
import { HUE, ink } from "@/lib/viz";
import { chartBase, tipHead, tipRow } from "../trends/kit";
import { useDrivers, type Drivers } from "./api";

const LABEL = { population: "Population growth", ageing: "Ageing", risk: "Risk change" } as const;
const SHORT = { population: "Population", ageing: "Ageing", risk: "Risk" } as const;

/** Plain-language reading of the decomposition ("why will cases rise"). */
export function driversSentence(d: Drivers): string {
  const pct = (100 * d.total_change) / d.cases_from;
  const share = (v: number) => `${Math.round((100 * Math.abs(v)) / (Math.abs(d.total_change) || 1))}%`;
  const verb = (c: Drivers["components"][number]) => {
    const n = int(Math.abs(c.cases));
    if (c.component === "population") return `${c.cases >= 0 ? "population growth adds" : "a shrinking population removes"} ${n} cases (${share(c.cases)})`;
    if (c.component === "ageing") return `${c.cases >= 0 ? "an older population adds" : "a younger population removes"} ${n} (${share(c.cases)})`;
    return `${c.cases >= 0 ? "higher age-specific rates add" : "lower age-specific rates remove"} ${n} (${share(c.cases)})`;
  };
  const parts = d.components.map(verb);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  return `Expected cases ${d.total_change >= 0 ? "rise" : "fall"} from ${int(d.cases_from)} in ${d.from_year} to ${int(d.cases_to)} in ${d.to_year} (${signed(pct, 0, "%")}): `
    + `${list}.`;
}

/** Waterfall from the base-year cases through population, ageing and risk to the horizon year (Das Gupta). */
export function DriversCard() {
  const q = useDrivers();
  const m = useThemeMode();
  const d = q.data?.data;
  const option = useMemo<EChartsOption | null>(() => {
    if (!d) return null;
    const b = chartBase(), k = ink(), h = HUE[m];
    const cats = [String(d.from_year), ...d.components.map((c) => SHORT[c.component]), String(d.to_year)];
    let run = d.cases_from;
    const baseVals: (number | string)[] = ["-"], upVals: (number | string)[] = [d.cases_from], dnVals: (number | string)[] = ["-"];
    d.components.forEach((c) => {
      if (c.cases >= 0) { baseVals.push(run); upVals.push(c.cases); dnVals.push("-"); run += c.cases; }
      else { run += c.cases; baseVals.push(run); upVals.push("-"); dnVals.push(-c.cases); }
    });
    baseVals.push("-"); upVals.push(d.cases_to); dnVals.push("-");
    const total = (i: number) => i === 0 || i === cats.length - 1;
    return {
      ...b, grid: { left: 8, right: 8, top: 30, bottom: 28, containLabel: false },
      xAxis: { ...b.xAxis, type: "category", data: cats, axisLabel: { ...b.xAxis.axisLabel, color: k.secondary, interval: 0 } },
      yAxis: { ...b.yAxis, type: "value", show: false, min: 0 },
      tooltip: { ...b.tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: m === "dark" ? "rgba(242,243,245,0.04)" : "rgba(21,23,28,0.04)" } },
        formatter: (ps: any) => {
          const i = ps[0].dataIndex;
          if (total(i)) return tipHead(cats[i]) + tipRow(k.secondary, "Expected cases", int(i === 0 ? d.cases_from : d.cases_to));
          const c = d.components[i - 1];
          return tipHead(LABEL[c.component]) + tipRow(h.sky, "Change", `${signed(c.cases, 0)} cases`) + tipRow(null, `Share of ${d.from_year} cases`, signed(c.pct, 1, "%"));
        } },
      series: [
        { type: "bar", stack: "w", data: baseVals, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, silent: true, barWidth: "56%" },
        { type: "bar", stack: "w", data: upVals, barWidth: "56%",
          itemStyle: { color: (p: any) => (total(p.dataIndex) ? (m === "dark" ? "#5A5F6B" : "#C9CCD5") : h.sky), borderRadius: 6 },
          label: { show: true, position: "top", color: k.primary, fontSize: 12, fontWeight: 600,
                   formatter: (p: any) => (total(p.dataIndex) ? int(p.value) : `+${int(p.value)}`) } },
        { type: "bar", stack: "w", data: dnVals, barWidth: "56%", itemStyle: { color: h.skySoft, borderColor: h.sky, borderWidth: 1.5, borderRadius: 6 },
          label: { show: true, position: "bottom", color: k.primary, fontSize: 12, fontWeight: 600, formatter: (p: any) => `−${int(p.value)}` } },
      ],
    } as EChartsOption;
  }, [d, m]);
  const table = d ? (
    <DataTable ariaLabel="Driver decomposition" rows={[{ k: `Expected cases ${d.from_year}`, v: d.cases_from, p: null }, ...d.components.map((c) => ({ k: LABEL[c.component], v: c.cases, p: c.pct })),
      { k: `Expected cases ${d.to_year}`, v: d.cases_to, p: null }]}
      columns={[{ key: "k", label: "Component" }, { key: "v", label: "Cases", num: true, fmt: (v, r) => (r.p === null ? int(v) : signed(v, 0)) },
        { key: "p", label: `% of ${d.from_year}`, num: true, fmt: (v) => (v === null ? "" : signed(v, 1, "%")) }]} />
  ) : null;
  return (
    <Card title="Why cases rise" icon={<Layers size={16} />} className="h-full" bodyClassName="flex flex-col"
          detail={d ? { tabs: chartDetailTabs({ table, method: <><p>{d.method}.</p><p className="mt-2">Population growth: more people at the same age structure and rates. Ageing: the shift towards older ages, where gastric cancer is far more common. Risk change: the change in age-specific rates projected by the forecast model.</p></>, notes: "Synthetic data. The base year uses model-fitted cases, so it can differ slightly from the recorded count." }), defaultTab: "table" } : undefined}
          detailLabel="Why cases rise: details">
      {q.isLoading ? <Loading h={300} /> : q.error ? <ErrorNote error={q.error} /> : d && option ? (
        <>
          <p className="text-[15px] leading-[22px] text-ink/90">{driversSentence(d)}</p>
          <div className="mt-auto pt-3 -mx-1">
            <EChart option={option} height={270} ariaLabel={`Waterfall: ${int(d.cases_from)} cases in ${d.from_year}, ${d.components.map((c) => `${LABEL[c.component]} ${signed(c.cases, 0)}`).join(", ")}, ${int(d.cases_to)} in ${d.to_year}`} />
          </div>
          <div className="text-micro text-muted tabular mt-1">Decomposition of the forecast change, {d.from_year} to {d.to_year}; {fmt((100 * d.total_change) / d.cases_from, 0)}% in total.</div>
        </>
      ) : null}
    </Card>
  );
}
