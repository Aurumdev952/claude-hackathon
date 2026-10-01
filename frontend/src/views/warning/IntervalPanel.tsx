import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { Clock } from "lucide-react";
import { Card, chartDetailTabs, DataTable, Loading, Seg, StatTile } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
import { fmt, int } from "@/lib/format";
import { alpha, chartBase, Key, tipHead, tipRow, usePalette } from "../trends/kit";
import { DAYS_PER_MONTH, IntervalRow, MALARIA_ENDEMIC, PROVINCES, useIntervals, useOr } from "./api";

type GV = "province" | "tier" | "age_band" | "malaria_region";
const ORDER: Record<GV, string[]> = {
  province: ["EAS", "SOU", "WES", "NOR", "KGL"],
  tier: ["low", "medium", "high"],
  age_band: ["<50", "50-64", "65+"],
  malaria_region: ["malaria_endemic", "other"],
};
const LABEL = (gv: GV, g: string) => gv === "province" ? PROVINCES[g] ?? g
  : gv === "tier" ? `${g[0].toUpperCase()}${g.slice(1)} HP-testing tier`
  : gv === "malaria_region" ? (g === "malaria_endemic" ? "Malaria-endemic (E + S)" : "Other provinces") : g === "<50" ? "Under 50" : g;
const GROUP_OPTS: { value: GV; label: string }[] = [{ value: "province", label: "Province" }, { value: "tier", label: "Facility tier" }, { value: "age_band", label: "Age band" }, { value: "malaria_region", label: "Malaria region" }];
const m = (d: number) => d / DAYS_PER_MONTH;
const pFmt = (p: number | null) => (p === null ? "—" : p < 0.001 ? "p < 0.001" : `p = ${fmt(p, 3)}`);

/** Diagnostic interval (first GI symptom -> diagnosis) by group: IQR boxes + median (INS-3, INS-6). */
export function IntervalPanel() {
  const q = useIntervals();
  const or = useOr();
  const pal = usePalette();
  const [gv, setGv] = useState<GV>("province");
  const all = q.data?.data ?? [];
  const rows = useMemo(() => ORDER[gv].map((g) => all.find((r) => r.group_var === gv && r.group === g)).filter(Boolean) as IntervalRow[], [all, gv]);
  const overall = or.data && (or.data as any).summary?.find((s: any) => s.metric === "median_diag_interval_months")?.case as number | undefined;
  const mal = all.filter((r) => r.group_var === "malaria_region");
  const endemic = mal.find((r) => r.group === "malaria_endemic"), other = mal.find((r) => r.group === "other");
  const gap = endemic && other ? m(endemic.median_days - other.median_days) : null;
  const isEndemic = (r: IntervalRow) => (gv === "province" && MALARIA_ENDEMIC.includes(r.group)) || (gv === "malaria_region" && r.group === "malaria_endemic");
  const colorOf = (r: IntervalRow) => (gv === "province" || gv === "malaria_region") && isEndemic(r) ? pal.series[1] : pal.series[0];

  const option = useMemo<EChartsOption | null>(() => {
    if (!rows.length) return null;
    const b = chartBase();
    const k = pal.ink;
    const cats = rows.map((r) => r.group);
    const xmax = Math.ceil((Math.max(...rows.map((r) => m(r.q3))) + 0.5) / 2) * 2;
    return {
      ...b,
      grid: { left: 150, right: 96, top: 26, bottom: 34 },
      xAxis: { ...b.xAxis, type: "value", min: 0, max: xmax, interval: 2, name: "Months from first GI symptom to diagnosis", nameLocation: "middle", nameGap: 22,
        nameTextStyle: { color: k.muted, fontSize: 10 }, splitLine: { show: true, lineStyle: { color: k.grid } } },
      yAxis: [
        { ...b.yAxis, type: "category", data: cats, inverse: true, splitLine: { show: false }, axisLabel: { color: k.secondary, fontSize: 11.5, formatter: (v: string) => LABEL(gv, v) } },
        { ...b.yAxis, type: "category", data: cats, inverse: true, position: "right", splitLine: { show: false },
          axisLabel: { color: k.primary, fontSize: 11, align: "left", margin: 10, rich: { n: { color: k.muted, fontSize: 10.5 } },
            formatter: (v: string) => { const r = rows.find((x) => x.group === v)!; return `${fmt(m(r.median_days), 1)} mo {n|n ${int(r.n)}}`; } } },
      ],
      tooltip: { ...b.tooltip, trigger: "item", formatter: (p: any) => {
        const r = rows[p.data.value[3]];
        return tipHead(LABEL(gv, r.group)) + tipRow(colorOf(r), "Median", `${fmt(m(r.median_days), 1)} months`, `${int(r.median_days)} days`) +
          tipRow(null, "Interquartile range", `${fmt(m(r.q1), 1)}–${fmt(m(r.q3), 1)} months`) + tipRow(null, "Cases", int(r.n));
      } },
      series: [{
        type: "custom", name: "box", data: rows.map((r, i) => ({ value: [m(r.q1), m(r.median_days), m(r.q3), i] })), encode: { x: [0, 1, 2], y: 3 },
        renderItem: (_p: any, api: any) => {
          const i = api.value(3);
          const r = rows[i];
          const c = colorOf(r);
          const a = api.coord([api.value(0), i]), md = api.coord([api.value(1), i]), z = api.coord([api.value(2), i]);
          const h = Math.min(22, api.size([0, 1])[1] * 0.56);
          return { type: "group", children: [
            { type: "rect", shape: { x: a[0], y: a[1] - h / 2, width: z[0] - a[0], height: h, r: 4 }, style: { fill: alpha(c, 0.28), stroke: c, lineWidth: 1.5 } },
            { type: "line", shape: { x1: md[0], y1: md[1] - h / 2 - 3, x2: md[0], y2: md[1] + h / 2 + 3 }, style: { stroke: k.primary, lineWidth: 2.5 } },
          ] } as any;
        },
        markLine: overall ? { silent: true, symbol: "none", lineStyle: { color: k.muted, width: 1, type: "solid" },
          label: { formatter: `All cases ${fmt(overall, 1)} mo`, color: k.muted, fontSize: 10, position: "start" }, data: [{ xAxis: overall }] } : undefined,
      } as any],
    } as EChartsOption;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, pal, overall, gv]);

  const method = "Interval = diagnosis date − first recorded GI symptom within the preceding 24 months, per confirmed/probable case. Groups compared with the Mann–Whitney U test. Malaria-endemic = Eastern and Southern provinces, where anaemia from a bleeding tumour is often first treated as malaria or worms (INS-6).";
  return (
    <Card
      title="Diagnostic interval" icon={<Clock size={16} />}
      info={{ about: "First GI symptom in the 24-month window → diagnosis. Box = interquartile range, bar = median; right axis = median and cases.", method }}
      detail={{ tabs: chartDetailTabs({ table: <DataTable columns={[{ key: "group", label: "Group", fmt: (v) => LABEL(gv, v) }, { key: "median_days", label: "Median (months)", num: true, fmt: (v) => fmt(m(v), 1) },
        { key: "iqr", label: "IQR (months)", num: true, fmt: (_v, r) => `${fmt(m(r.q1), 1)}–${fmt(m(r.q3), 1)}` }, { key: "n", label: "Cases", num: true, fmt: int }]} rows={rows} />, method }), defaultTab: "table" }}
      detailLabel="View as table"
      actions={<Seg label="Group by" value={gv} onChange={setGv} options={GROUP_OPTS} />}
    >
      {q.error ? <ErrorNote error={q.error} /> : !option ? <Loading h={240} /> : (
        <>
          <EChart key={gv} option={option} height={Math.max(190, 46 * rows.length + 60)} ariaLabel="Diagnostic interval box plots by group" />
          <div className="flex items-center gap-3 flex-wrap mt-1">
            {(gv === "province" || gv === "malaria_region") ? <>
              <Key color={pal.series[1]} kind="box" label="Malaria-endemic" />
              <Key color={pal.series[0]} kind="box" label="Other provinces" />
            </> : <Key color={pal.series[0]} kind="box" label="Interquartile range" />}
            <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted"><span className="w-[2.5px] h-3 bg-fg" aria-hidden />Median</span>
          </div>
          {gap !== null && (
            <div className="grid grid-cols-3 gap-2 mt-3">
              <StatTile label="Malaria-endemic" value={fmt(m(endemic!.median_days), 1)} unit="mo" />
              <StatTile label="Elsewhere" value={fmt(m(other!.median_days), 1)} unit="mo" />
              <StatTile label="Gap" value={`${gap >= 0 ? "+" : ""}${fmt(gap, 1)}`} unit="mo" info={`Mann–Whitney ${pFmt(endemic!.p_value)}`} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
