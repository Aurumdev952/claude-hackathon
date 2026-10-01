import { lazy, Suspense, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Dna, MousePointer2 } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Card, chartDetailTabs, Loading, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
import { detectWebGL } from "@/components/three/body/util";
import { SERIES } from "@/lib/viz";
import { int } from "@/lib/format";
import { chartBase, Empty, tipHead, tipRow, usePalette, useReducedMotion } from "../trends/kit";
import { JourneyRow, KINDS, useJourney } from "./api";

const HelixScene = lazy(() => import("./HelixScene").then((m) => ({ default: m.HelixScene })));
const MONTHS = Array.from({ length: 24 }, (_, i) => -24 + i);

export function HelixPanel() {
  const q = useJourney();
  const pal = usePalette();
  const webgl = useMemo(detectWebGL, []);
  const [view, setView] = useState<"3d" | "bars">(webgl ? "3d" : "bars");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<JourneyRow | null>(null);
  const reduced = useReducedMotion();
  const events = q.data?.data ?? [];
  const nCases = useMemo(() => new Set(events.map((e) => e.case_index)).size, [events]);
  // The 3D stage is a dark lightbox in both themes, so it always uses the dark-surface slots.
  const stageColor = useMemo(() => Object.fromEntries(KINDS.map((k, i) => [k.id, SERIES.dark[i]])), []);
  const themeColor = useMemo(() => Object.fromEntries(KINDS.map((k, i) => [k.id, pal.series[i]])), [pal]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    events.forEach((e) => { c[e.kind] = (c[e.kind] ?? 0) + 1; });
    return c;
  }, [events]);
  const byMonth = useMemo(() => MONTHS.map((m) => {
    const r: Record<string, number> = { month: m };
    KINDS.forEach((k) => { r[k.id] = 0; });
    events.forEach((e) => { if (e.month_before === m) r[e.kind] = (r[e.kind] ?? 0) + 1; });
    return r;
  }), [events]);
  const last6 = byMonth.slice(-6).reduce((s, r) => s + KINDS.reduce((a, k) => a + r[k.id], 0), 0);
  const share6 = events.length ? Math.round((100 * last6) / events.length) : 0;
  const caseEvents = hover ? events.filter((e) => e.case_index === hover.case_index) : [];
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const table = (
    <table className="w-full text-[11px] tabular">
      <caption className="text-left text-label text-fg-muted mb-1.5">Events per month before diagnosis, {nCases} sampled cases</caption>
      <thead className="sticky top-0 bg-surface-2"><tr><th className="text-left py-1.5 px-1.5 text-fg-muted font-medium">Month</th>{KINDS.map((k) => <th key={k.id} className="text-right px-1.5 text-fg-muted font-medium">{k.label}</th>)}<th className="text-right px-1.5 text-fg-muted font-medium">Total</th></tr></thead>
      <tbody>{byMonth.map((r) => (
        <tr key={r.month} className="border-b border-border/70"><td className="py-1 px-1.5">{r.month}</td>{KINDS.map((k) => <td key={k.id} className="text-right px-1.5">{r[k.id]}</td>)}
          <td className="text-right px-1.5 font-semibold">{KINDS.reduce((a, k) => a + r[k.id], 0)}</td></tr>
      ))}</tbody>
    </table>
  );
  const method = "A random sample of ~200 diagnosed cases (2017 onward, with at least one GI visit in the 24 months before diagnosis). Every encounter, symptom, prescription, lab, order and working diagnosis in that window is a dot, at month = floor(days before diagnosis / 30.44). Rings narrow toward diagnosis; a patient keeps the same angle, twisting slowly, so each case traces a spiral. Larger dots are abnormal results.";

  return (
    <Card
      title="Journey helix · last two years" icon={<Dna size={16} />}
      info={{ about: <>Each ring is one month; each dot one recorded event for {nCases || "~200"} sampled cases, placed at that patient's angle.{share6 ? <> {share6}% of events fall in the final 6 months.</> : null}</>, method,
              notes: "Hover a dot to trace that patient's path; drag to orbit, scroll to zoom. Click an event type to hide it. “Working diagnosis” = a coded diagnosis such as dyspepsia or gastritis, not the cancer itself." }}
      detail={{ tabs: chartDetailTabs({ table, method }), defaultTab: "table" }} detailLabel="View as table"
      actions={<>
        {share6 ? <StatusChip status="serious" size="md" label={<span className="tabular">{share6}% in final 6 months</span>} /> : null}
        <Seg label="Render" value={view} onChange={setView} options={[{ value: "3d", label: "3D helix" }, { value: "bars", label: "2D bars" }]} />
      </>}
    >
      {q.error ? <ErrorNote error={q.error} /> : q.isLoading ? <Loading h={480} /> : !events.length ? <Empty h={300}>No journey sample published yet.</Empty> : (
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_220px]">
          {view === "3d" && webgl ? (
            <div className="relative h-[500px] rounded-tile overflow-hidden case-stage">
              <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-xs text-[#8696a2]">Loading 3D helix…</div>}>
                <div className="absolute inset-0">
                  <HelixScene events={events} kindColor={stageColor} hidden={hidden} hoverCase={hover?.case_index ?? null} onHover={setHover} reducedMotion={reduced} />
                </div>
              </Suspense>
              <div className={`absolute top-3 left-3 glass rounded-tile shadow-tile text-fg px-3 py-2 z-10 pointer-events-none ${hover ? "w-[236px]" : ""}`} role="status" aria-live="polite">
                {hover ? (
                  <>
                    <div className="text-micro text-fg-muted">Sample case #{hover.case_index + 1} · stage {hover.stage_group}</div>
                    <div className="flex items-center gap-1.5 mt-1 text-[12.5px] font-semibold">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: stageColor[hover.kind] }} aria-hidden />
                      {KINDS.find((k) => k.id === hover.kind)?.label ?? hover.kind}{hover.is_abnormal ? <span className="text-tone-warning font-normal text-[11px]">· abnormal</span> : null}
                    </div>
                    <div className="text-micro text-fg-muted tabular">{Math.abs(hover.month_before)} month{Math.abs(hover.month_before) === 1 ? "" : "s"} before diagnosis</div>
                    <div className="text-micro text-fg-muted tabular mt-1">This patient: {caseEvents.length} events, {new Set(caseEvents.filter((e) => e.kind === "VISIT").map((e) => e.month_before)).size} months with a GI visit</div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-micro text-fg-muted">
                    <MousePointer2 size={13} className="shrink-0" aria-hidden />
                    <span>Hover · drag · scroll</span>
                  </div>
                )}
              </div>
            </div>
          ) : <Bars byMonth={byMonth} colors={themeColor} hidden={hidden} />}
          <aside className="flex flex-col gap-1" aria-label="Event types (legend and filter)">
            <div className="text-label font-medium text-fg-muted mb-1">Event type</div>
            {KINDS.map((k) => {
              const off = hidden.has(k.id);
              return (
                <button key={k.id} onClick={() => toggle(k.id)} aria-pressed={!off}
                        className={`flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${off ? "border-transparent text-fg-muted/60" : "border-border/70 bg-surface-2 hover:bg-surface"}`}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: off ? "transparent" : (view === "3d" && webgl ? stageColor : themeColor)[k.id], boxShadow: `inset 0 0 0 1.5px ${(view === "3d" && webgl ? stageColor : themeColor)[k.id]}` }} aria-hidden />
                  <span className={`flex-1 ${off ? "line-through" : ""}`}>{k.label}</span>
                  <span className="tabular text-[11px] text-fg-muted">{int(counts[k.id] ?? 0)}</span>
                </button>
              );
            })}
          </aside>
        </div>
      )}
    </Card>
  );
}

function Bars({ byMonth, colors, hidden }: { byMonth: Record<string, number>[]; colors: Record<string, string>; hidden: Set<string> }) {
  const pal = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase();
    const kinds = KINDS.filter((k) => !hidden.has(k.id));
    return {
      ...b,
      grid: { left: 44, right: 12, top: 30, bottom: 30 },
      xAxis: { ...b.xAxis, type: "category", data: byMonth.map((r) => String(r.month)), axisLabel: { ...b.xAxis.axisLabel, interval: 2 } },
      yAxis: { ...b.yAxis, type: "value", name: "events (sample)" },
      tooltip: { ...b.tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: (ps: any) => {
        const r = byMonth[ps[0].dataIndex];
        return tipHead(`${Math.abs(r.month)} months before diagnosis`) + [...kinds].reverse().map((k) => tipRow(colors[k.id], k.label, int(r[k.id]))).join("") +
          tipRow(null, "Total", int(kinds.reduce((a, k) => a + r[k.id], 0)));
      } },
      series: kinds.map((k, i) => ({ type: "bar", name: k.label, stack: "e", data: byMonth.map((r) => r[k.id]), barMaxWidth: 20,
        itemStyle: { color: colors[k.id], borderColor: pal.ink.surface, borderWidth: 1, borderRadius: i === kinds.length - 1 ? [3, 3, 0, 0] : 0 } })) as any,
    } as EChartsOption;
  }, [byMonth, colors, hidden, pal]);
  return <EChart option={option} height={460} ariaLabel="Stacked bars of events per month before diagnosis by event type" />;
}
