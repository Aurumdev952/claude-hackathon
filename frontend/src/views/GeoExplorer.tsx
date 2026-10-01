import { useEffect, useMemo, useRef, useState } from "react";
import { Hexagon, Info, Map as MapIcon, RotateCcw, Route, Scale, Sparkles, Table2, Building2, X, Crosshair } from "lucide-react";
import type { MapRow } from "@/api/types";
import { useGeo, useProvGeo } from "@/api/hooks";
import { DataTable, ErrorNote, Loading, Panel } from "@/components/ui/Panel";
import { useThemeMode } from "@/components/charts/EChart";
import { fmt, int } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { useGeoSelection } from "@/state/selection";
import { type Facility, type Period, type PeriodMode, useCasePoints, useEvents, useFacilities, useMapSeries, usePeriods, useSpatial } from "./geo/data";
import { ageStructureDecoy, cleanName, domainFor, LISA_LABEL, METRIC_ORDER, METRICS, rankBy, type MetricKey } from "./geo/model";
import { type Arc, GeoScene, type HoverInfo, reducedMotion } from "./geo/GeoScene";
import { HoverCard, HUD, Legend, TimeSlider } from "./geo/Hud";
import { DistrictPanel } from "./geo/DistrictPanel";
import { Ranking } from "./geo/Ranking";

const PANEL_W = 384;
const SMALL_BTN = "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium border border-line/70 bg-ridge2/60 hover:bg-ridge2 text-mist focus-visible:ring-2 ring-kivu";

/** V2 Geo Explorer (hero view, SPEC §16.3): extruded district map + hex cases + facilities + referral arcs, time slider, drill-down. */
export default function GeoExplorer() {
  useThemeMode(); // re-render colours on theme change
  const f = useFilters();
  const { district: selected, select } = useGeoSelection();
  const [mode, setMode] = useState<PeriodMode>("POOLED3");
  const periodsAll = usePeriods(mode);
  const periods = useMemo(() => {
    const p = periodsAll.filter((x) => x.end >= f.yearFrom && x.start <= f.yearTo);
    return p.length ? p : periodsAll;
  }, [periodsAll, f.yearFrom, f.yearTo]);
  const [idx, setIdx] = useState(-1);
  const [metricKey, setMetricKey] = useState<MetricKey>(f.metric);
  const [showHex, setHex] = useState(false);
  const [showFac, setFac] = useState(true);
  const [showArcs, setArcs] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [callout, setCallout] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [reset, setReset] = useState(0);
  const [riseToken, setRiseToken] = useState(0);
  const [methodOpen, setMethodOpen] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  // Default period = the latest complete period inside the global filter range; re-anchor when the range or mode changes.
  useEffect(() => {
    if (!periods.length) return;
    const complete = periods.filter((p) => !p.partial && p.end <= f.yearTo);
    setIdx(periods.indexOf(complete[complete.length - 1] ?? periods[periods.length - 1]));
  }, [periods, f.yearTo]);
  // Keep the ASR/crude choice in sync with the global "Rate" filter.
  useEffect(() => { if (f.metric !== metricKey && (metricKey === "asr" || metricKey === "crude_rate")) switchMetric(f.metric); }, [f.metric]); // eslint-disable-line react-hooks/exhaustive-deps

  const period: Period | undefined = periods[Math.max(0, idx)];
  const metric = METRICS[metricKey];
  const geo = useGeo(), prov = useProvGeo();
  const series = useMapSeries(periods);
  const spatialQ = useSpatial(), facQ = useFacilities(), evQ = useEvents();
  const pts = useCasePoints(showHex);
  const rows: MapRow[] = (period && series.byPeriod[period.id]) || [];
  const allRows = useMemo(() => Object.values(series.byPeriod).flat(), [series.byPeriod]);
  const domain = useMemo(() => {
    const src = metric.periodic ? allRows : rows;
    return domainFor(metric, src.length ? src : rows);
  }, [metric, allRows, rows]);
  const national = period ? series.national[period.id] ?? null : null;
  const nationalCrude = useMemo(() => {
    const ok = rows.filter((r) => r.cases && r.population);
    const c = ok.reduce((s, r) => s + (r.cases ?? 0), 0), p = ok.reduce((s, r) => s + r.population, 0);
    return p ? (1e5 * c) / p : null; // approximate (suppressed cells excluded)
  }, [rows]);
  const rankKey = (metricKey === "lisa_quadrant" ? "asr" : metricKey) as keyof MapRow;
  const rank = useMemo(() => rankBy(rows, rankKey), [rows, rankKey]);
  const asrRank = useMemo(() => rankBy(rows, "asr"), [rows]);
  const byCode = useMemo(() => new Map(rows.map((r) => [r.geo_code, r])), [rows]);
  const spatial = useMemo(() => new Map((spatialQ.data?.data.districts ?? []).map((s) => [s.district_code, s])), [spatialQ.data]);
  const decoy = useMemo(() => ageStructureDecoy(rows), [rows]);
  const lowCov = useMemo(() => Object.fromEntries(periods.map((p) => [p.id, (series.byPeriod[p.id] ?? []).filter((r) => r.coverage_flag).length])), [periods, series.byPeriod]);

  // Endoscopy units open at the period end: referral hospitals (always) + ENDOSCOPY_OPENED events.
  const facilities = facQ.data?.data ?? [];
  const endoIds = useMemo(() => {
    const end = period?.end ?? 9999;
    const s = new Set<number>(facilities.filter((x) => x.facility_type === "REFERRAL").map((x) => x.location_id));
    (evQ.data?.data ?? []).forEach((e) => { if (e.event_type === "ENDOSCOPY_OPENED" && e.location_id && Number(e.date.slice(0, 4)) <= end) s.add(e.location_id); });
    return s;
  }, [facilities, evQ.data, period?.end]);
  const arcs = useMemo(() => (showArcs && geo.data ? modelReferrals(geo.data, facilities, endoIds, rows) : null), [showArcs, geo.data, facilities, endoIds, rows]);
  const hexPoints = useMemo(() => (showHex && pts.data && period ? pts.data.data.filter((p) => p.year >= period.start && p.year <= period.end) : null), [showHex, pts.data, period]);

  // Time-slider play: advance a period every 1.5 s; extrusions animate between years.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIdx((i) => { if (i >= periods.length - 1) { setPlaying(false); return i; } return i + 1; }), reducedMotion() ? 1800 : 1500);
    return () => clearInterval(t);
  }, [playing, periods.length]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (selected) select(null); setCallout(false); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selected, select]);

  function switchMetric(k: MetricKey) {
    const crudeAsr = (a: MetricKey, b: MetricKey) => (a === "asr" && b === "crude_rate") || (a === "crude_rate" && b === "asr");
    if (crudeAsr(metricKey, k)) setCallout(true);
    else if (k !== "asr" && k !== "crude_rate") setCallout(false);
    setMetricKey(k);
    if ((k === "asr" || k === "crude_rate") && f.metric !== k) f.set({ metric: k });
  }
  const play = () => {
    if (playing) return setPlaying(false);
    if (idx >= periods.length - 1) setIdx(0);
    setPlaying(true);
  };

  const ready = geo.data && prov.data && rows.length > 0;
  const n = rank.size;
  const w = stage.current?.clientWidth ?? 1000;

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="panel-title">V2 · Geo Explorer</div>
          <h1 className="text-xl font-bold leading-tight">Where gastric cancer concentrates</h1>
        </div>
        <p className="text-xs text-fog max-w-[460px] leading-snug">
          Districts rise by {metric.short === "LISA" ? "age-standardised rate" : metric.label.toLowerCase()}; colour repeats the value on a single-hue ramp.
          {spatialQ.data?.data.global.morans_i !== undefined && spatialQ.data?.data.global.morans_i !== null && <> Global Moran's I <b className="text-mist tabular">{fmt(spatialQ.data.data.global.morans_i, 2)}</b> (p {fmt(spatialQ.data.data.global.p, 3)}, {spatialQ.data.data.global.period}).</>}
        </p>
      </div>

      <div ref={stage} className={`relative rounded-xl border border-line/60 overflow-hidden ${asTable ? "" : "h-[calc(100vh-196px)] min-h-[600px]"}`}
           style={{ background: "radial-gradient(70% 60% at 50% 45%, rgb(var(--ridge) / 0.95), rgb(var(--basalt)) 100%)" }}
           onMouseLeave={() => setHover(null)}>
        {asTable ? (
          <div className="p-4 bg-ridge/80">
            <div className="flex items-center justify-between mb-2">
              <h2 className="panel-title">Districts · {period?.id} · sorted by {metric.short}</h2>
              <button className={SMALL_BTN} onClick={() => setAsTable(false)}><MapIcon size={13} /> Back to 3D map</button>
            </div>
            <DistrictTable rows={rows} rank={rank} spatial={spatial} onSelect={(c) => { select(c); setAsTable(false); }} />
          </div>
        ) : (
          <>
            {(geo.error || series.error) && <div className="absolute inset-0 flex items-center justify-center p-6"><ErrorNote error={geo.error ?? series.error} /></div>}
            {!ready && !geo.error && !series.error && <div className="absolute inset-0 flex items-center justify-center"><Loading h={200} label="Raising the highlands" /></div>}
            {ready && (
              <div role="application" aria-label="3D district map. Use the district list or View as table for keyboard access." className="absolute inset-0">
                <GeoScene districts={geo.data} provinces={prov.data} rows={rows} metric={metric} domain={domain}
                          facilities={facilities} endoIds={endoIds} showFacilities={showFac && !showHex} hexPoints={hexPoints} arcs={arcs}
                          selected={selected} highlight={callout ? decoy?.code ?? null : null} onSelect={(c) => select(c)} onHover={setHover}
                          focusOffsetPx={PANEL_W} resetToken={reset} riseToken={riseToken} />
              </div>
            )}

            {/* Top-left: metric + layers */}
            <div className="absolute top-3 left-3 z-10 flex flex-col gap-2 items-start" style={{ maxWidth: `calc(100% - ${selected ? PANEL_W + 24 : 230}px)` }}>
              <div className={`${HUD} p-1.5 flex items-center gap-1.5 flex-wrap`}>
                <span className="text-[10px] uppercase tracking-[0.14em] text-fog px-1.5">Metric</span>
                <div className="seg" role="group" aria-label="Map metric">
                  {METRIC_ORDER.map((k) => <button key={k} aria-pressed={metricKey === k} onClick={() => switchMetric(k)} title={METRICS[k].label}>{METRICS[k].short}</button>)}
                </div>
                <div className="relative">
                  <button className="p-1 text-fog hover:text-mist rounded focus-visible:ring-2 ring-kivu" aria-label="Method" aria-expanded={methodOpen} onClick={() => setMethodOpen((v) => !v)} onBlur={() => setMethodOpen(false)}><Info size={14} /></button>
                  {methodOpen && <div role="tooltip" className="absolute left-0 top-7 z-30 w-72 panel bg-ridge p-3 text-xs leading-relaxed"><div className="panel-title mb-1">Method · {metric.label}</div>{metric.method}</div>}
                </div>
              </div>
              <div className={`${HUD} p-1.5 flex items-center gap-1`} role="group" aria-label="Layers">
                <span className="text-[10px] uppercase tracking-[0.14em] text-fog px-1.5">Layers</span>
                <LayerBtn on={showHex} onClick={() => setHex((v) => !v)} icon={<Hexagon size={13} />} label="Case hexbins" />
                <LayerBtn on={showFac && !showHex} disabled={showHex} onClick={() => setFac((v) => !v)} icon={<Building2 size={13} />} label="Facilities" />
                <LayerBtn on={showArcs} onClick={() => setArcs((v) => !v)} icon={<Route size={13} />} label="Referral arcs" />
              </div>
              {callout && decoy && (metricKey === "crude_rate" || metricKey === "asr") && (
                <div className={`${HUD} p-3 w-[340px] text-xs border-sorghum/60 animate-rise`} role="status" aria-live="polite">
                  <div className="flex items-start gap-2">
                    <Scale size={15} className="text-sorghum shrink-0 mt-0.5" aria-hidden />
                    <div className="flex-1">
                      <div className="font-semibold text-[13px] leading-snug">Age-structure check: {decoy.name}</div>
                      <p className="text-fog leading-relaxed mt-1">
                        On <b className="text-mist">crude</b> rates {decoy.name} ranks <b className="text-mist">#{decoy.crudeRank}</b>; age-standardised it ranks <b className="text-mist">#{decoy.asrRank}</b> of {decoy.n}.
                        Its crude rate is <b className="text-mist">{Math.round(decoy.ratio * 100)}%</b> of its ASR versus a median of {Math.round(decoy.median * 100)}% — an older population, not a higher risk.
                        {metricKey === "crude_rate" ? " Raw numbers would send resources here." : " Age adjustment puts it back in line."}
                      </p>
                      <div className="flex gap-2 mt-2">
                        <button className={SMALL_BTN} onClick={() => { select(decoy.code); setCallout(false); }}><Crosshair size={12} /> Fly to {decoy.name}</button>
                        <button className={SMALL_BTN} onClick={() => switchMetric(metricKey === "asr" ? "crude_rate" : "asr")}>Show {metricKey === "asr" ? "crude" : "ASR"}</button>
                      </div>
                    </div>
                    <button className="text-fog hover:text-mist" onClick={() => setCallout(false)} aria-label="Dismiss"><X size={14} /></button>
                  </div>
                </div>
              )}
            </div>

            {/* Top-right: view controls (stacked; slides left of the district panel) */}
            <div className="absolute top-3 z-10 flex items-start gap-1.5 transition-[right] duration-300" style={{ right: selected ? PANEL_W + 12 : 12 }}>
              {!selected && (
                <label className={`${HUD} flex items-center gap-1 px-2 py-1 text-xs h-8`}>
                  <span className="sr-only">Jump to district</span>
                  <select className="bg-transparent text-mist text-xs outline-none max-w-[140px]" value="" onChange={(e) => e.target.value && select(e.target.value)} aria-label="Jump to district">
                    <option value="">Jump to district…</option>
                    {[...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.geo_code} value={r.geo_code}>{r.name}</option>)}
                  </select>
                </label>
              )}
              <div className={`flex gap-1.5 ${selected ? "flex-col" : ""}`}>
                <IconBtn label="Replay rise" onClick={() => setRiseToken((x) => x + 1)}><Sparkles size={14} /></IconBtn>
                <IconBtn label="Reset view" onClick={() => { select(null); setReset((x) => x + 1); }}><RotateCcw size={14} /></IconBtn>
                <IconBtn label="View as table" onClick={() => setAsTable(true)}><Table2 size={14} /></IconBtn>
              </div>
            </div>

            {/* Bottom: legend + time slider */}
            <div className="absolute left-3 bottom-[78px] z-10">
              <Legend metric={metric} domain={domain} national={metricKey === "crude_rate" ? nationalCrude : national} period={period?.id ?? ""}
                      showFacilities={showFac && !showHex} showHex={showHex} showArcs={showArcs}
                      hasLowCov={rows.some((r) => r.coverage_flag)} hasSuppressed={rows.some((r) => r.suppressed)} />
            </div>
            <div className="absolute left-3 bottom-3 z-10" style={{ right: selected ? PANEL_W + 12 : 12 }}>
              <TimeSlider periods={periods} idx={Math.max(0, idx)} onIdx={(i) => { setPlaying(false); setIdx(i); }} mode={mode} onMode={(m) => { setPlaying(false); setMode(m); }}
                          playing={playing} onPlay={play} periodic={metric.periodic || showHex} staticNote={metric.staticNote} lowCov={lowCov} compact={!!selected} />
            </div>

            {hover && !(hover.kind === "district" && hover.code === selected) && (
              <HoverCard hover={hover} rows={byCode} metric={metric} rank={rank} n={n} spatial={spatial} w={w - (selected ? PANEL_W : 0)} />
            )}

            {selected && (
              <DistrictPanel code={selected} row={byCode.get(selected)} rank={asrRank.get(selected)} n={n} spatial={spatial.get(selected)} facilities={facilities}
                             events={evQ.data?.data} national={national} period={period?.id ?? ""} onClose={() => select(null)} />
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-3">
        <Panel title={`District ranking · ${metric.short}`} subtitle={`${metric.periodic ? period?.id : metric.staticNote} · dots = estimate, whiskers = 95% CI · click to drill down`}
               method={metric.method} table={<DistrictTable rows={rows} rank={rank} spatial={spatial} onSelect={select} />}>
          {rows.length ? <Ranking rows={rows} metric={metric} spatial={spatial} national={metricKey === "crude_rate" ? nationalCrude : national} selected={selected} highlight={callout ? decoy?.code ?? null : null} onSelect={select} /> : <Loading h={300} />}
        </Panel>
        <div className="flex flex-col gap-3">
          <Panel title="Hotspot read-out" subtitle="LISA, 2019–2025 pooled, EB-smoothed" method={METRICS.lisa_quadrant.method}>
            <HotspotList rows={rows} spatial={spatial} onSelect={select} />
          </Panel>
          {decoy && (
            <Panel title="Crude vs age-standardised" subtitle={`${period?.id} · how age structure moves the ranking`} method="Crude rates rank districts by raw burden; ASR removes differences in age structure. A district whose crude rate is close to its ASR has an older population than average.">
              <CrudeAsrShift rows={rows} onSelect={select} decoy={decoy.code} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function LayerBtn({ on, onClick, icon, label, disabled }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <button aria-pressed={on} onClick={onClick} disabled={disabled}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition focus-visible:ring-2 ring-kivu disabled:opacity-40 ${on ? "bg-kivu/30 text-mist" : "text-fog hover:text-mist hover:bg-ridge2"}`}>
      {icon}{label}
    </button>
  );
}
function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button className={`${HUD} w-8 h-8 flex items-center justify-center text-fog hover:text-mist focus-visible:ring-2 ring-kivu`} onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

function DistrictTable({ rows, rank, spatial, onSelect }: { rows: MapRow[]; rank: Map<string, number>; spatial: Map<string, any>; onSelect: (c: string) => void }) {
  const sorted = [...rows].sort((a, b) => (rank.get(a.geo_code) ?? 99) - (rank.get(b.geo_code) ?? 99));
  return (
    <DataTable rows={sorted} columns={[
      { key: "rank", label: "#", num: true, fmt: (_, r) => rank.get(r.geo_code) ?? "—" },
      { key: "name", label: "District", fmt: (v, r) => <button className="text-kivu hover:underline" onClick={() => onSelect(r.geo_code)}>{v}</button> },
      { key: "cases", label: "Cases", num: true, fmt: (v, r) => (r.suppressed ? "<5" : int(v)) },
      { key: "crude_rate", label: "Crude", num: true, fmt: (v) => fmt(v) },
      { key: "asr", label: "ASR [95% CI]", num: true, fmt: (v, r) => <span>{fmt(v)} <span className="text-fog">[{fmt(r.asr_lci)}–{fmt(r.asr_uci)}]</span></span> },
      { key: "sir", label: "SIR [95% CI]", num: true, fmt: (v, r) => <span>{fmt(v, 2)} <span className="text-fog">[{fmt(spatial.get(r.geo_code)?.sir_lci, 2)}–{fmt(spatial.get(r.geo_code)?.sir_uci, 2)}]</span></span> },
      { key: "lisa_quadrant", label: "LISA", fmt: (v) => (v && v !== "NS" ? v : <span className="text-fog">NS</span>) },
      { key: "hp_test_rate", label: "HP test %", num: true, fmt: (v) => fmt(v) },
      { key: "pct_stage4", label: "Stage IV %", num: true, fmt: (v) => fmt(v) },
      { key: "coverage_flag", label: "Flags", fmt: (v, r) => [v && "low coverage", r.suppressed && "suppressed"].filter(Boolean).join(", ") || "" },
    ]} />
  );
}

function HotspotList({ rows, spatial, onSelect }: { rows: MapRow[]; spatial: Map<string, any>; onSelect: (c: string) => void }) {
  const hh = rows.filter((r) => (r.lisa_quadrant ?? spatial.get(r.geo_code)?.lisa_quadrant) === "HH").sort((a, b) => (spatial.get(b.geo_code)?.sir ?? 0) - (spatial.get(a.geo_code)?.sir ?? 0));
  const other = rows.filter((r) => ["HL", "LH", "LL"].includes(r.lisa_quadrant ?? ""));
  if (!rows.length) return <Loading h={80} />;
  return (
    <div className="text-xs">
      <p className="text-fog mb-2 leading-snug">{hh.length} district{hh.length === 1 ? "" : "s"} form a significant High–High cluster; {other.length} other{other.length === 1 ? " is" : "s are"} spatial outliers or cold spots.</p>
      <ul className="divide-y divide-line/40">
        {hh.map((r) => { const s = spatial.get(r.geo_code); return (
          <li key={r.geo_code}><button className="w-full flex items-center gap-2 py-1.5 text-left hover:bg-ridge2/40 rounded px-1" onClick={() => onSelect(r.geo_code)}>
            <span className="chip bg-ridge2 text-mist">HH</span><span className="font-medium flex-1">{r.name}</span>
            <span className="tabular text-fog">SIR <b className="text-mist">{fmt(s?.sir, 2)}</b> ({fmt(s?.sir_lci, 2)}–{fmt(s?.sir_uci, 2)})</span>
          </button></li>
        ); })}
      </ul>
      <p className="text-[10px] text-fog mt-2">{LISA_LABEL.HH}: high rate surrounded by high-rate neighbours (p &lt; 0.05, 999 permutations).</p>
    </div>
  );
}

function CrudeAsrShift({ rows, onSelect, decoy }: { rows: MapRow[]; onSelect: (c: string) => void; decoy: string }) {
  const ra = rankBy(rows, "asr"), rc = rankBy(rows, "crude_rate");
  const moves = rows.filter((r) => ra.has(r.geo_code) && rc.has(r.geo_code))
    .map((r) => ({ r, d: (ra.get(r.geo_code) ?? 0) - (rc.get(r.geo_code) ?? 0) }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
  return (
    <table className="w-full text-xs tabular">
      <thead><tr className="text-fog"><th className="text-left font-semibold pb-1">District</th><th className="text-right font-semibold">Crude rank</th><th className="text-right font-semibold">ASR rank</th><th className="text-right font-semibold">Shift</th></tr></thead>
      <tbody>
        {moves.map(({ r, d }) => (
          <tr key={r.geo_code} className={`border-t border-line/40 ${r.geo_code === decoy ? "bg-sorghum/10" : ""}`}>
            <td className="py-1"><button className="hover:underline text-left" onClick={() => onSelect(r.geo_code)}>{r.name}</button>{r.geo_code === decoy && <span className="text-[10px] text-sorghum ml-1">oldest age profile</span>}</td>
            <td className="text-right">#{rc.get(r.geo_code)}</td><td className="text-right">#{ra.get(r.geo_code)}</td>
            <td className="text-right font-semibold">{d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${-d}` : "–"}<span className="sr-only">{d > 0 ? " places worse on crude" : " places better on crude"}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Referral flows are not published by the API yet; model them from the generator's pathway rule:
 * in-district endoscopy unit if open → provincial hospital if open → nearest referral hospital. Width = district cases in the period. */
function modelReferrals(geo: any, facilities: Facility[], endoIds: Set<number>, rows: MapRow[]): Arc[] {
  const open = facilities.filter((x) => endoIds.has(x.location_id));
  const d2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const out: Arc[] = [];
  for (const feat of geo.features) {
    const code = feat.properties.district_code as string, c = feat.properties.centroid as [number, number];
    const r = rows.find((x) => x.geo_code === code);
    const n = r?.cases ?? 0;
    if (!n) continue;
    if (open.some((x) => x.district_code === code)) continue; // diagnosed locally
    const provH = open.find((x) => x.facility_type === "PROVINCIAL" && x.province_code === code.slice(0, 3));
    const target = provH ?? open.filter((x) => x.facility_type === "REFERRAL").sort((a, b) => d2(c, [a.lon, a.lat]) - d2(c, [b.lon, b.lat]))[0];
    if (!target) continue;
    out.push({ from: c, to: [target.lon, target.lat], fromCode: code, toId: target.location_id, n, fromName: feat.properties.name, toName: cleanName(target.name) });
  }
  return out;
}
