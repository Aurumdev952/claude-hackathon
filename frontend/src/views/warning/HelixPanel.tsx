import { lazy, Suspense, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { MousePointer2 } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { ErrorNote, Loading, Panel, Seg } from "@/components/ui/Panel";
import { detectWebGL } from "@/components/three/body/util";
import { SERIES } from "@/lib/viz";
import { int } from "@/lib/format";
import { chartBase, tipHead, tipRow, usePalette, useReducedMotion } from "../trends/kit";
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
      <caption className="text-left text-[11px] text-fog mb-1.5">Events per month before diagnosis, {nCases} sampled cases</caption>
      <thead className="sticky top-0 bg-ridge"><tr><th className="text-left py-1 px-1.5 text-fog">Month</th>{KINDS.map((k) => <th key={k.id} className="text-right px-1.5 text-fog">{k.label}</th>)}<th className="text-right px-1.5 text-fog">Total</th></tr></thead>
      <tbody>{byMonth.map((r) => (
        <tr key={r.month} className="border-b border-line/40"><td className="py-1 px-1.5">{r.month}</td>{KINDS.map((k) => <td key={k.id} className="text-right px-1.5">{r[k.id]}</td>)}
          <td className="text-right px-1.5 font-semibold">{KINDS.reduce((a, k) => a + r[k.id], 0)}</td></tr>
      ))}</tbody>
    </table>
  );

  return (
    <Panel
      title="Journey helix · the last two years before diagnosis"
      subtitle={<>Each ring is one month; each dot one recorded event for {nCases || "~200"} sampled cases, placed at that patient's angle. {share6 ? <b className="text-mist tabular">{share6}% of events fall in the final 6 months.</b> : null}</>}
      method="A random sample of ~200 diagnosed cases (2017 onward, with at least one GI visit in the 24 months before diagnosis). Every encounter, symptom, prescription, lab, order and working diagnosis in that window is a dot, at month = floor(days before diagnosis / 30.44). Rings narrow toward diagnosis; a patient keeps the same angle, twisting slowly, so each case traces a spiral. Larger dots are abnormal results."
      table={table}
      actions={<Seg label="Render" value={view} onChange={setView} options={[{ value: "3d", label: "3D helix" }, { value: "bars", label: "2D bars" }]} />}
    >
      {q.error ? <ErrorNote error={q.error} /> : q.isLoading ? <Loading h={480} /> : !events.length ? <div className="text-xs text-fog p-6">No journey sample published yet.</div> : (
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_220px]">
          {view === "3d" && webgl ? (
            <div className="relative h-[500px] rounded-lg overflow-hidden case-stage border border-line/50">
              <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-xs text-[#8696a2]">Loading 3D helix…</div>}>
                <div className="absolute inset-0">
                  <HelixScene events={events} kindColor={stageColor} hidden={hidden} hoverCase={hover?.case_index ?? null} onHover={setHover} reducedMotion={reduced} />
                </div>
              </Suspense>
              <div className="absolute top-3 left-3 hud px-3 py-2 w-[236px] z-10 pointer-events-none" role="status" aria-live="polite">
                {hover ? (
                  <>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[#8696a2]">Sample case #{hover.case_index + 1} · stage {hover.stage_group}</div>
                    <div className="flex items-center gap-1.5 mt-1 text-[12.5px] font-semibold">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: stageColor[hover.kind] }} aria-hidden />
                      {KINDS.find((k) => k.id === hover.kind)?.label ?? hover.kind}{hover.is_abnormal ? <span className="text-[#f2a541] font-normal text-[11px]">· abnormal</span> : null}
                    </div>
                    <div className="text-[11px] text-[#b4c0c8] tabular">{Math.abs(hover.month_before)} month{Math.abs(hover.month_before) === 1 ? "" : "s"} before diagnosis</div>
                    <div className="text-[10.5px] text-[#8696a2] tabular mt-1">This patient: {caseEvents.length} events, {new Set(caseEvents.filter((e) => e.kind === "VISIT").map((e) => e.month_before)).size} months with a GI visit</div>
                  </>
                ) : (
                  <div className="flex items-start gap-2 text-[11px] text-[#b4c0c8] leading-snug">
                    <MousePointer2 size={13} className="mt-0.5 shrink-0" aria-hidden />
                    <span>Hover a dot to trace that patient's path to diagnosis. Drag to orbit, scroll to zoom.</span>
                  </div>
                )}
              </div>
            </div>
          ) : <Bars byMonth={byMonth} colors={themeColor} hidden={hidden} />}
          <aside className="flex flex-col gap-1" aria-label="Event types (legend and filter)">
            <div className="panel-title mb-1">Event type</div>
            {KINDS.map((k) => {
              const off = hidden.has(k.id);
              return (
                <button key={k.id} onClick={() => toggle(k.id)} aria-pressed={!off}
                        className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] border transition focus:outline-none focus-visible:ring-2 ring-kivu ${off ? "border-transparent text-fog/60" : "border-line/60 bg-ridge2/40 hover:bg-ridge2"}`}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: off ? "transparent" : (view === "3d" && webgl ? stageColor : themeColor)[k.id], boxShadow: `inset 0 0 0 1.5px ${(view === "3d" && webgl ? stageColor : themeColor)[k.id]}` }} aria-hidden />
                  <span className={`flex-1 ${off ? "line-through" : ""}`}>{k.label}</span>
                  <span className="tabular text-[11px] text-fog">{int(counts[k.id] ?? 0)}</span>
                </button>
              );
            })}
            <p className="text-[10.5px] text-fog leading-snug mt-2">Click a type to hide it. Larger dots = abnormal result. "Working diagnosis" = a coded diagnosis such as dyspepsia or gastritis, not the cancer itself.</p>
          </aside>
        </div>
      )}
    </Panel>
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
