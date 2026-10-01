import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { DataTable, ErrorNote, Loading, Panel } from "@/components/ui/Panel";
import { fmt, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { alpha, tipHead, tipRow, usePalette, chartBase } from "./kit";
import { AGE_LABEL, Band, specKey, useJp, useSeries } from "./api";

const BANDS: Band[] = ["<50", "50-64", "65+", "ALL"];

/** INS-2: is the trend driven by the young? Latest-segment APC and 10-year AAPC per national age band. */
export function AgeContrastPanel() {
  const f = useFilters();
  const pal = usePalette();
  const { series } = useSeries();
  const qs = [useJp(`NATIONAL|ALL|<50|${f.caseDef}`), useJp(`NATIONAL|ALL|50-64|${f.caseDef}`), useJp(`NATIONAL|ALL|65+|${f.caseDef}`), useJp(`NATIONAL|ALL|ALL|${f.caseDef}`)];
  const rows = BANDS.map((b, i) => {
    const jp = qs[i].data?.data;
    const last = jp?.segments[jp.segments.length - 1];
    const spec = series.find((s) => specKey(s) === specKey({ level: "NATIONAL", geo: "RW", sex: "ALL", age: b }));
    return { band: b, label: AGE_LABEL[b], jp, last, color: spec ? pal.series[spec.slot] : pal.ink.secondary };
  });
  const ready = rows.every((r) => r.jp);
  const err = qs.find((q) => q.error)?.error;

  const option = useMemo<EChartsOption>(() => {
    const b = chartBase();
    const k = pal.ink;
    const cats = rows.map((r) => r.label);
    const data = rows.flatMap((r, i) => [
      r.last ? { value: [i, r.last.apc, r.last.apc_lci, r.last.apc_uci, 0], row: r } : null,
      r.jp?.aapc_last10.value !== null && r.jp ? { value: [i, r.jp.aapc_last10.value, r.jp.aapc_last10.lci, r.jp.aapc_last10.uci, 1], row: r } : null,
    ]).filter(Boolean) as any[];
    const xs = data.flatMap((d) => [d.value[2], d.value[3]]).filter((v: any) => v !== null);
    const m0 = Math.max(12, ...xs.map((v: number) => Math.abs(v)));
    const lim = m0 > 20 ? Math.ceil(m0 / 10) * 10 : Math.ceil(m0 / 5) * 5;
    return {
      ...b,
      grid: { left: 64, right: 16, top: 10, bottom: 34 },
      xAxis: { ...b.xAxis, type: "value", min: -lim, max: lim, interval: lim > 20 ? 10 : 5, name: "% change per year", nameLocation: "middle", nameGap: 22, nameTextStyle: { color: k.muted, fontSize: 10 },
        splitLine: { show: true, lineStyle: { color: k.grid } }, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => signed(v, 0) } },
      yAxis: { ...b.yAxis, type: "category", data: cats, inverse: true, splitLine: { show: false }, axisLabel: { color: k.secondary, fontSize: 11.5 } },
      tooltip: {
        ...b.tooltip, trigger: "item",
        formatter: (p: any) => {
          const r = p.data.row;
          const s = r.last;
          const a = r.jp.aapc_last10;
          return tipHead(`National · ${r.label}`) +
            tipRow(r.color, `Latest segment ${s.start_year}–${s.end_year}`, `${signed(s.apc, 1, "%")}/yr`, `[${fmt(s.apc_lci, 1)}, ${fmt(s.apc_uci, 1)}]`) +
            tipRow(null, "AAPC, last 10 years", `${signed(a.value, 1, "%")}/yr`, `[${fmt(a.lci, 1)}, ${fmt(a.uci, 1)}]`);
        },
      },
      series: [{
        type: "custom", name: "apc", data,
        encode: { x: [1, 2, 3], y: 0 },
        renderItem: (_p: any, api: any) => {
          const i = api.value(0), kind = api.value(4);
          const row = rows[i];
          const off = kind === 0 ? -6 : 6;
          const [cx, cy] = api.coord([api.value(1), i]);
          const lo = api.coord([api.value(2), i])[0], hi = api.coord([api.value(3), i])[0];
          const y = cy + off;
          const c = row.color;
          const st = { stroke: kind === 0 ? c : alpha(c.startsWith("#") ? c : "#8696a2", 0.7), lineWidth: kind === 0 ? 2 : 1.5 };
          return {
            type: "group", children: [
              { type: "rect", shape: { x: lo - 4, y: y - 9, width: Math.max(8, hi - lo + 8), height: 18 }, style: { fill: "transparent" } },
              { type: "line", shape: { x1: lo, y1: y, x2: hi, y2: y }, style: st },
              { type: "line", shape: { x1: lo, y1: y - 3, x2: lo, y2: y + 3 }, style: st },
              { type: "line", shape: { x1: hi, y1: y - 3, x2: hi, y2: y + 3 }, style: st },
              kind === 0
                ? { type: "circle", shape: { cx, cy: y, r: 4.5 }, style: { fill: c, stroke: k.surface, lineWidth: 2 } }
                : { type: "polygon", shape: { points: [[cx, y - 5], [cx + 5, y], [cx, y + 5], [cx - 5, y]] }, style: { fill: k.surface, stroke: c, lineWidth: 1.75 } },
            ],
          } as any;
        },
        markLine: { silent: true, symbol: "none", lineStyle: { color: k.axis, width: 1, type: "solid" }, label: { show: false }, data: [{ xAxis: 0 }] },
      } as any],
    } as EChartsOption;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs.map((q) => q.dataUpdatedAt).join(), pal, series]);

  const young = rows[0];
  return (
    <Panel
      title="Who is driving the trend?"
      subtitle="National joinpoint by age band · all sexes"
      method="For each national age-band series: the APC of the most recent joinpoint segment (filled dot) and the average annual percent change over the last 10 years (hollow diamond), both with 95% CIs. A CI that crosses 0 is not a significant trend."
      table={ready ? <DataTable columns={[{ key: "label", label: "Age band" }, { key: "seg", label: "Latest segment" }, { key: "apc", label: "APC", num: true }, { key: "aapc", label: "AAPC (10 y)", num: true }]}
        rows={rows.map((r) => ({ label: r.label, seg: `${r.last!.start_year}–${r.last!.end_year}`, apc: `${signed(r.last!.apc, 1, "%")} [${fmt(r.last!.apc_lci, 1)}, ${fmt(r.last!.apc_uci, 1)}]`,
          aapc: `${signed(r.jp!.aapc_last10.value, 1, "%")} [${fmt(r.jp!.aapc_last10.lci, 1)}, ${fmt(r.jp!.aapc_last10.uci, 1)}]` }))} /> : undefined}
    >
      {err ? <ErrorNote error={err} /> : !ready ? <Loading h={210} /> : (
        <>
          <EChart option={option} height={200} ariaLabel="Annual percent change by age band with 95% confidence intervals" />
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-fog">
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-fog" aria-hidden />Latest-segment APC</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rotate-45 border-[1.5px] border-fog" aria-hidden />AAPC, 10 years</span>
          </div>
          {young.last && (
            <p className="text-[12px] leading-relaxed mt-2.5 border-t border-line/50 pt-2.5">
              Under-50 rates have changed <b className="tabular">{signed(young.last.apc, 1, "%")}</b> a year since <b>{young.last.start_year}</b>{" "}
              <span className="text-fog tabular">(95% CI {fmt(young.last.apc_lci, 1)} to {fmt(young.last.apc_uci, 1)})</span>, while the 65+ band is{" "}
              {rows[2].last?.significant ? "changing" : "flat"} <span className="text-fog tabular">({signed(rows[2].last?.apc, 1, "%")}/yr)</span>.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
