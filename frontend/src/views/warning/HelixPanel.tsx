import { lazy, Suspense, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Dna, MousePointer2 } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Card, chartDetailTabs, Loading, Seg } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { detectWebGL } from "@/components/three/body/util";
import { CATEGORICAL } from "@/lib/viz";
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
  // seven event kinds: the validated categorical palette (fixed order); the 3D stage follows the theme
  const themeColor = useMemo(() => Object.fromEntries(KINDS.map((k, i) => [k.id, CATEGORICAL[pal.mode][i]])), [pal]);
  const stageColor = themeColor;
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
      <caption className="text-left text-label text-muted mb-1.5">Events per month before diagnosis, {nCases} sampled cases</caption>
      <thead className="sticky top-0 bg-tile"><tr><th className="text-left py-2 px-2 text-muted font-medium">Month</th>{KINDS.map((k) => <th key={k.id} className="text-right px-2 text-muted font-medium">{k.label}</th>)}<th className="text-right px-2 text-muted font-medium">Total</th></tr></thead>
      <tbody>{byMonth.map((r) => (
        <tr key={r.month} className="border-b border-hairline"><td className="py-1 px-1.5">{r.month}</td>{KINDS.map((k) => <td key={k.id} className="text-right px-1.5">{r[k.id]}</td>)}
          <td className="text-right px-1.5 font-semibold">{KINDS.reduce((a, k) => a + r[k.id], 0)}</td></tr>
      ))}</tbody>
    </table>
  );
  const method = "A random sample of ~200 diagnosed cases (2017 onward, with at least one GI visit in the 24 months before diagnosis). Every encounter, symptom, prescription, lab, order and working diagnosis in that window is a dot, at month = floor(days before diagnosis / 30.44). Rings narrow toward diagnosis; a patient keeps the same angle, twisting slowly, so each case traces a spiral. Larger dots are abnormal results.";

  return (
    <Card
      title="Patient journeys, last two years" icon={<Dna size={16} />}
      detail={{ tabs: chartDetailTabs({ table, method: <><p>Each ring is one month; each dot one recorded event for {nCases || "about 200"} sampled cases, placed at that patient's angle.</p><p className="mt-2">{method}</p></>,
        notes: "Hover a dot to trace that patient's path; drag to orbit, scroll to zoom. Select an event type to hide it. A working diagnosis is a coded diagnosis such as dyspepsia or gastritis, not the cancer itself." }), defaultTab: "table" }}
      detailLabel="Patient journeys: view as table"
      actions={<Seg label="Render" value={view} onChange={setView} options={[{ value: "3d", label: "3D helix" }, { value: "bars", label: "Bars" }]} />}
    >
      {share6 ? <p className="text-label font-normal text-muted -mt-1 mb-4 tabular">{share6}% of recorded events fall in the final 6 months before diagnosis.</p> : null}
      {q.error ? <ErrorNote error={q.error} /> : q.isLoading ? <Loading h={480} /> : !events.length ? <Empty h={300}>No journey sample published yet.</Empty> : (
        <div className="grid gap-6 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_240px]">
          {view === "3d" && webgl ? (
            <div className="relative h-[500px] rounded-tile overflow-hidden bg-tile">
              <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-label text-muted">Loading the 3D helix</div>}>
                <div className="absolute inset-0">
                  <HelixScene events={events} kindColor={stageColor} hidden={hidden} hoverCase={hover?.case_index ?? null} onHover={setHover} reducedMotion={reduced} light={pal.mode === "light"} />
                </div>
              </Suspense>
              <div className={`absolute top-4 left-4 bg-surface rounded-tile dark:border dark:border-hairline text-ink px-4 py-3 z-10 pointer-events-none ${hover ? "w-[244px]" : ""}`} role="status" aria-live="polite">
                {hover ? (
                  <>
                    <div className="flex gap-3 text-micro text-muted"><span>Sample case {hover.case_index + 1}</span><span>Stage {hover.stage_group}</span></div>
                    <div className="flex items-center gap-1.5 mt-1 text-[13px] font-medium">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: stageColor[hover.kind] }} aria-hidden />
                      {KINDS.find((k) => k.id === hover.kind)?.label ?? hover.kind}{hover.is_abnormal ? <span className="text-tone-warning font-normal text-[12px] ml-1">abnormal</span> : null}
                    </div>
                    <div className="text-micro text-muted tabular">{Math.abs(hover.month_before)} month{Math.abs(hover.month_before) === 1 ? "" : "s"} before diagnosis</div>
                    <div className="text-micro text-muted tabular mt-1">This patient: {caseEvents.length} events, {new Set(caseEvents.filter((e) => e.kind === "VISIT").map((e) => e.month_before)).size} months with a GI visit</div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-micro text-muted">
                    <MousePointer2 size={13} className="shrink-0" aria-hidden />
                    <span>Hover, drag or scroll</span>
                  </div>
                )}
              </div>
            </div>
          ) : <Bars byMonth={byMonth} colors={themeColor} hidden={hidden} />}
          <aside className="flex flex-col" aria-label="Event types (legend and filter)">
            <div className="text-label text-muted mb-2">Event type</div>
            <div className="flex flex-col -mx-3">
              {KINDS.map((k) => {
                const off = hidden.has(k.id);
                return (
                  <button key={k.id} onClick={() => toggle(k.id)} aria-pressed={!off}
                          className="flex items-center gap-3 rounded-tile h-11 px-3 text-left text-[14px] hover:bg-tile transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: off ? "transparent" : themeColor[k.id], boxShadow: `inset 0 0 0 1.5px ${themeColor[k.id]}` }} aria-hidden />
                    <span className={`flex-1 ${off ? "text-faint line-through" : "text-ink"}`}>{k.label}</span>
                    <span className="tabular text-micro text-muted">{int(counts[k.id] ?? 0)}</span>
                  </button>
                );
              })}
            </div>
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
