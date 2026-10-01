import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Tooltip } from "@heroui/react";
import { BarChart3, Building2, Crosshair, Flame, Hexagon, Map as MapIcon, RotateCcw, Route, Scale, Sparkles, Table2 } from "lucide-react";
import type { MapRow } from "@/api/types";
import { useGeo, useProvGeo } from "@/api/hooks";
import { BentoGrid, Card, chartDetailTabs, DataTable, DeltaChip, FloatingGlassCard, GridItem, InfoHint, Loading, PageHeader, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
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
  useEffect(() => setHover(null), [selected]);
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
  const moran = spatialQ.data?.data.global;
  const natRef = metricKey === "crude_rate" ? nationalCrude : national;
  const districtTable = <DistrictTable rows={rows} rank={rank} spatial={spatial} onSelect={select} />;

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <PageHeader icon={<MapIcon size={18} />} title="Where gastric cancer concentrates"
        info={{ about: <>Districts rise by {metric.short === "LISA" ? "age-standardised rate" : metric.label.toLowerCase()}; colour repeats the value on a single-hue ramp.</>,
                method: metric.method,
                notes: moran?.morans_i !== undefined && moran?.morans_i !== null ? <>Global Moran's I {fmt(moran.morans_i, 2)} (p {fmt(moran.p, 3)}, {moran.period}): rates cluster in space more than chance would explain.</> : undefined }}
        right={moran?.morans_i !== undefined && moran?.morans_i !== null ? (
          <StatusChip status="info" size="md" title={`Global Moran's I, ${moran.period} (p ${fmt(moran.p, 3)})`} label={<span className="tabular">Moran's I <b>{fmt(moran.morans_i, 2)}</b> · p {fmt(moran.p, 3)}</span>} />
        ) : undefined} />

      <div ref={stage} className={`relative rounded-card border border-border shadow-card overflow-hidden ${asTable ? "bg-surface" : "h-[calc(100vh-196px)] min-h-[600px]"}`}
           style={asTable ? undefined : { background: "radial-gradient(70% 60% at 50% 45%, rgb(var(--surface)), rgb(var(--surface-2)) 100%)" }}
           onMouseLeave={() => setHover(null)}>
        {asTable ? (
          <div className="p-5">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-title flex-1">Districts · {period?.id} · by {metric.short}</h2>
              <Button size="sm" radius="full" variant="flat" startContent={<MapIcon size={14} />} onPress={() => setAsTable(false)}
                      className="bg-surface-2 border border-border text-fg">Back to 3D map</Button>
            </div>
            <div className="overflow-auto rounded-tile border border-border"><DistrictTable rows={rows} rank={rank} spatial={spatial} onSelect={(c) => { select(c); setAsTable(false); }} /></div>
          </div>
        ) : (
          <>
            {(geo.error || series.error) && <div className="absolute inset-0 flex items-center justify-center p-6"><ErrorNote error={geo.error ?? series.error} /></div>}
            {!ready && !geo.error && !series.error && <div className="absolute inset-0 flex items-center justify-center px-10"><Loading h={200} label="Raising the highlands" /></div>}
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
              <div className={`${HUD} !rounded-full p-1 flex items-center gap-0.5 flex-wrap`}>
                <Seg label="Map metric" value={metricKey} onChange={switchMetric}
                     options={METRIC_ORDER.map((k) => ({ value: k, label: METRICS[k].short, title: METRICS[k].label }))} className="!bg-transparent !border-0" />
                <InfoHint title={`Method · ${metric.label}`} content={metric.method} label="Method" placement="bottom-start" />
              </div>
              <div className={`${HUD} !rounded-full p-1 flex items-center gap-0.5`} role="group" aria-label="Layers">
                <LayerBtn on={showHex} onClick={() => setHex((v) => !v)} icon={<Hexagon size={15} />} label="Case hexbins" />
                <LayerBtn on={showFac && !showHex} disabled={showHex} onClick={() => setFac((v) => !v)} icon={<Building2 size={15} />} label="Facilities" />
                <LayerBtn on={showArcs} onClick={() => setArcs((v) => !v)} icon={<Route size={15} />} label="Referral arcs" />
              </div>
              {decoy && (metricKey === "crude_rate" || metricKey === "asr") && (
                <FloatingGlassCard open={callout} position="none" role="status" ariaLabel="Age-structure check" icon={<Scale size={17} />} className="!w-[330px]"
                  title={<span className="inline-flex items-center">Age-structure check<InfoHint size={13} title={`Age-structure check: ${decoy.name}`} label="About the age-structure check" placement="bottom-start" content={<>
                    On <b>crude</b> rates {decoy.name} ranks <b>#{decoy.crudeRank}</b>; age-standardised it ranks <b>#{decoy.asrRank}</b> of {decoy.n}.
                    Its crude rate is <b>{Math.round(decoy.ratio * 100)}%</b> of its ASR versus a median of {Math.round(decoy.median * 100)}% — an older population, not a higher risk.
                    {metricKey === "crude_rate" ? " Raw numbers would send resources here." : " Age adjustment puts it back in line."}</>} /></span>}
                  body={<span className="flex items-center gap-1.5 flex-wrap"><b className="text-fg mr-0.5">{decoy.name}</b>
                    <StatusChip status="warning" label={<span className="tabular">crude #{decoy.crudeRank}</span>} />
                    <StatusChip status="good" label={<span className="tabular">ASR #{decoy.asrRank} of {decoy.n}</span>} /></span>}
                  cta={{ label: `Fly to ${decoy.name}`, icon: <Crosshair size={15} />, onPress: () => { select(decoy.code); setCallout(false); } }}
                  onDismiss={() => setCallout(false)} />
              )}
            </div>

            {/* Top-right: view controls (stacked; slides left of the district panel) */}
            <div className="absolute top-3 z-10 flex items-start gap-1.5 transition-[right] duration-300" style={{ right: selected ? PANEL_W + 12 : 12 }}>
              {!selected && (
                <label className={`${HUD} !rounded-full flex items-center gap-1.5 pl-3 pr-2 h-9 text-[13px]`}>
                  <Crosshair size={14} className="text-fg-muted" aria-hidden />
                  <span className="sr-only">Jump to district</span>
                  <select className="bg-transparent text-fg text-[13px] outline-none max-w-[150px] cursor-pointer" value="" onChange={(e) => e.target.value && select(e.target.value)} aria-label="Jump to district">
                    <option value="">Jump to district…</option>
                    {[...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.geo_code} value={r.geo_code}>{r.name}</option>)}
                  </select>
                </label>
              )}
              <div className={`flex gap-1.5 ${selected ? "flex-col" : ""}`}>
                <IconBtn label="Replay rise" onClick={() => setRiseToken((x) => x + 1)}><Sparkles size={15} /></IconBtn>
                <IconBtn label="Reset view" onClick={() => { select(null); setReset((x) => x + 1); }}><RotateCcw size={15} /></IconBtn>
                <IconBtn label="View as table" onClick={() => setAsTable(true)}><Table2 size={15} /></IconBtn>
              </div>
            </div>

            {/* Bottom: legend + time slider */}
            <div className="absolute left-3 bottom-[84px] z-10">
              <Legend metric={metric} domain={domain} national={natRef} period={period?.id ?? ""}
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

      <BentoGrid>
        <GridItem span={{ lg: 7 }}>
          <Card title={`District ranking · ${metric.short}`} icon={<BarChart3 size={16} />}
                info={{ about: <>{metric.periodic ? period?.id : metric.staticNote}. Dots = estimate, whiskers = 95% CI. Click a district to drill down.</>, method: metric.method }}
                detail={{ tabs: chartDetailTabs({ table: districtTable, method: metric.method }), defaultTab: "table", subtitle: `${period?.id ?? ""} · sorted by ${metric.short}` }}
                detailLabel="View as table">
            {rows.length ? <Ranking rows={rows} metric={metric} spatial={spatial} national={natRef} selected={selected} highlight={callout ? decoy?.code ?? null : null} onSelect={select} /> : <Loading h={300} />}
          </Card>
        </GridItem>
        <GridItem span={{ lg: 5 }} className="gap-4">
          <Card title="Hotspots" icon={<Flame size={16} />} iconTone="danger" className="!flex-none"
                info={{ about: "LISA, 2019–2025 pooled, EB-smoothed rates.", method: METRICS.lisa_quadrant.method,
                        notes: `${LISA_LABEL.HH}: high rate surrounded by high-rate neighbours (999 permutations). An SIR CI that includes 1.0 means the district alone is not significantly above the national level.` }}>
            <HotspotList rows={rows} spatial={spatial} onSelect={select} />
          </Card>
          {decoy && (
            <Card title="Crude vs age-standardised" icon={<Scale size={16} />} iconTone="warning" className="flex-1"
                  info={{ about: `${period?.id} · how age structure moves the ranking. Highlighted row = oldest age profile.`, method: "Crude rates rank districts by raw burden; ASR removes differences in age structure. A district whose crude rate is close to its ASR has an older population than average. ↗ = places worse on crude than on ASR." }}>
              <CrudeAsrShift rows={rows} onSelect={select} decoy={decoy.code} />
            </Card>
          )}
        </GridItem>
      </BentoGrid>
    </div>
  );
}

function LayerBtn({ on, onClick, icon, label, disabled }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <Tooltip content={label} placement="bottom" delay={200} closeDelay={0} classNames={{ content: "bg-surface text-fg border border-border shadow-float text-xs" }}>
      <button aria-pressed={on} onClick={onClick} disabled={disabled} aria-label={label}
              className={`w-9 h-8 grid place-items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 ${on ? "bg-accent text-white shadow-[0_6px_16px_-6px_rgb(var(--accent)/0.6)]" : "text-fg-muted hover:text-fg hover:bg-fg/5"}`}>
        {icon}
      </button>
    </Tooltip>
  );
}
function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label} placement="bottom" delay={200} closeDelay={0} classNames={{ content: "bg-surface text-fg border border-border shadow-float text-xs" }}>
      <button className={`${HUD} !rounded-full w-9 h-9 grid place-items-center text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`} onClick={onClick} aria-label={label}>{children}</button>
    </Tooltip>
  );
}

function DistrictTable({ rows, rank, spatial, onSelect }: { rows: MapRow[]; rank: Map<string, number>; spatial: Map<string, any>; onSelect: (c: string) => void }) {
  const sorted = [...rows].sort((a, b) => (rank.get(a.geo_code) ?? 99) - (rank.get(b.geo_code) ?? 99));
  return (
    <DataTable rows={sorted} columns={[
      { key: "rank", label: "#", num: true, fmt: (_, r) => rank.get(r.geo_code) ?? "—" },
      { key: "name", label: "District", fmt: (v, r) => <button className="text-accent hover:underline" onClick={() => onSelect(r.geo_code)}>{v}</button> },
      { key: "cases", label: "Cases", num: true, fmt: (v, r) => (r.suppressed ? "<5" : int(v)) },
      { key: "crude_rate", label: "Crude", num: true, fmt: (v, r) => (r.suppressed ? "—" : fmt(v)) },
      { key: "asr", label: "ASR [95% CI]", num: true, fmt: (v, r) => (r.suppressed ? <span className="text-fg-muted">suppressed</span> : <span>{fmt(v)} <span className="text-fg-muted">[{fmt(r.asr_lci)}–{fmt(r.asr_uci)}]</span></span>) },
      { key: "sir", label: "SIR [95% CI]", num: true, fmt: (v, r) => <span>{fmt(v, 2)} <span className="text-fg-muted">[{fmt(spatial.get(r.geo_code)?.sir_lci, 2)}–{fmt(spatial.get(r.geo_code)?.sir_uci, 2)}]</span></span> },
      { key: "lisa_quadrant", label: "LISA", fmt: (v) => (v && v !== "NS" ? v : <span className="text-fg-muted">NS</span>) },
      { key: "hp_test_rate", label: "HP test %", num: true, fmt: (v) => fmt(v) },
      { key: "pct_stage4", label: "Stage IV %", num: true, fmt: (v) => fmt(v) },
      { key: "coverage_flag", label: "Flags", fmt: (v, r) => [v && "low coverage", r.suppressed && "suppressed"].filter(Boolean).join(", ") || "" },
    ]} />
  );
}

function HotspotList({ rows, spatial, onSelect }: { rows: MapRow[]; spatial: Map<string, any>; onSelect: (c: string) => void }) {
  const hh = rows.filter((r) => (r.lisa_quadrant ?? spatial.get(r.geo_code)?.lisa_quadrant) === "HH").sort((a, b) => (spatial.get(b.geo_code)?.sir ?? 0) - (spatial.get(a.geo_code)?.sir ?? 0));
  const other = rows.filter((r) => ["HL", "LH", "LL"].includes(r.lisa_quadrant ?? ""));
  const fdr = hh.filter((r) => spatial.get(r.geo_code)?.lisa_quadrant_fdr === "HH").length;
  if (!rows.length) return <Loading h={80} />;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1.5">
        <StatusChip status="critical" label={<span className="tabular">{hh.length} High–High</span>} title={`${hh.length} district(s) in a High–High cluster at p < 0.05`} />
        <StatusChip status="serious" label={<span className="tabular">{fdr} survive FDR</span>} title="Clusters that survive false-discovery-rate correction" />
        <StatusChip status="neutral" label={<span className="tabular">{other.length} outliers / cold spots</span>} title="Spatial outliers (HL, LH) and cold spots (LL)" />
      </div>
      <ul className="flex flex-col gap-0.5">
        {hh.map((r) => { const s = spatial.get(r.geo_code); return (
          <li key={r.geo_code}><button className="w-full flex items-center gap-2.5 py-1.5 px-2 text-left text-[13px] rounded-[10px] hover:bg-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" onClick={() => onSelect(r.geo_code)}
                    title={`${r.name}: SIR ${fmt(s?.sir, 2)} (95% CI ${fmt(s?.sir_lci, 2)}–${fmt(s?.sir_uci, 2)}), permutation p ${fmt(s?.lisa_p, 3)}`}>
            <StatusChip status="critical" label="HH" /><span className="font-medium flex-1 truncate">{r.name}</span>
            <span className="tabular text-micro text-fg-muted">p {fmt(s?.lisa_p, 3)}</span>
            <span className="tabular w-[84px] text-right text-micro text-fg-muted">SIR <b className="text-fg text-[13px]">{fmt(s?.sir, 2)}</b></span>
          </button></li>
        ); })}
      </ul>
    </div>
  );
}

function CrudeAsrShift({ rows, onSelect, decoy }: { rows: MapRow[]; onSelect: (c: string) => void; decoy: string }) {
  const ra = rankBy(rows, "asr"), rc = rankBy(rows, "crude_rate");
  const moves = rows.filter((r) => ra.has(r.geo_code) && rc.has(r.geo_code))
    .map((r) => ({ r, d: (ra.get(r.geo_code) ?? 0) - (rc.get(r.geo_code) ?? 0) }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
  return (
    <table className="w-full text-[13px] tabular">
      <thead><tr className="text-micro text-fg-muted"><th className="text-left font-medium pb-1.5">District</th><th className="text-right font-medium">Crude</th><th className="text-right font-medium">ASR</th><th className="text-right font-medium">Shift</th></tr></thead>
      <tbody>
        {moves.map(({ r, d }) => (
          <tr key={r.geo_code} className={`border-t border-border/70 ${r.geo_code === decoy ? "bg-warning/10" : ""}`}>
            <td className="py-1.5"><button className="hover:underline text-left font-medium" onClick={() => onSelect(r.geo_code)} title={r.geo_code === decoy ? "Oldest age profile" : undefined}>{r.name}</button>{r.geo_code === decoy && <span className="sr-only"> (oldest age profile)</span>}</td>
            <td className="text-right text-fg-muted">#{rc.get(r.geo_code)}</td><td className="text-right text-fg-muted">#{ra.get(r.geo_code)}</td>
            <td className="text-right py-1"><DeltaChip delta={{ text: String(Math.abs(d)), dir: d > 0 ? 1 : d < 0 ? -1 : 0, tone: d > 0 ? "bad" : d < 0 ? "good" : "neutral" }} />
              <span className="sr-only">{d > 0 ? " places worse on crude" : " places better on crude"}</span></td>
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
