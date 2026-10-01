import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useGeo, useProvGeo } from "@/api/hooks";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Loading } from "@/components/ui/Skeleton";
import { useThemeMode } from "@/components/charts/EChart";
import { fmt } from "@/lib/format";
import { useGeoSelection } from "@/state/selection";
import { useMapSeries, usePeriods } from "../geo/data";
import { GeoScene } from "../geo/GeoScene";
import { domainFor, LISA_LABEL, METRICS, rampColors } from "../geo/model";

/** Latest pooled 3-year district rates for the Overview (the hero map and the "highest rates" list share it). */
export function useOverviewMap(yearTo: number) {
  const periods = usePeriods("POOLED3");
  const period = useMemo(() => { const ok = periods.filter((p) => p.end <= yearTo); return ok[ok.length - 1] ?? periods[periods.length - 1]; }, [periods, yearTo]);
  const one = useMemo(() => (period ? [period] : []), [period]);
  const series = useMapSeries(one);
  const rows = (period && series.byPeriod[period.id]) || [];
  const metric = METRICS.asr;
  const domain = useMemo(() => domainFor(metric, rows), [metric, rows]);
  const national = period ? series.national[period.id] ?? null : null;
  const top = useMemo(() => [...rows].filter((r) => r.asr !== null && !r.suppressed).sort((a, b) => (b.asr ?? 0) - (a.asr ?? 0)), [rows]);
  return { period, rows, metric, domain, national, top, error: series.error };
}

/** Hero stage (design v3, reference "Sportcenter" photo card): the 3D district map on a sky stage, a quiet pill naming
 * the measure, a small white legend tile and one big round white arrow to the Geo Explorer. The stats strip that sits
 * along the bottom edge is rendered by the Overview (it belongs to the headline-indicator list). */
export function MapHero({ yearTo, compact = false }: { yearTo: number; compact?: boolean }) {
  useThemeMode();
  const nav = useNavigate();
  const select = useGeoSelection((s) => s.select);
  const { period, rows, metric, domain, error } = useOverviewMap(yearTo);
  const geo = useGeo(), prov = useProvGeo();
  const go = (code: string | null) => { select(code); nav("/geo"); };
  const range = period ? `${period.start}–${period.end}` : "";
  return (
    <div className="absolute inset-0">
      {(geo.error || error) ? <div className="p-6"><ErrorNote error={geo.error ?? error} /></div>
        : !(geo.data && prov.data && rows.length) ? <div className="absolute inset-0 grid place-items-center"><Loading h={240} label="Raising the map" /></div>
        : <GeoScene variant="mini" districts={geo.data} provinces={prov.data} rows={rows} metric={metric} domain={domain} onSelect={go} labels={3}
                    fitPad={compact ? { top: 64, bottom: 110, left: 8, right: 8 } : { top: 36, bottom: 104, left: 60, right: 60 }} zoomOffset={compact ? 0.08 : 0.18} />}
      <div className="absolute left-5 top-5 z-10 pointer-events-none">
        <span className="inline-flex items-center h-8 px-3.5 rounded-full bg-surface text-label text-ink tabular">Age-standardised rate, {range}</span>
      </div>
      {!compact && (
        <div className="absolute right-5 top-5 z-10 w-[176px] rounded-tile bg-surface px-4 py-3 pointer-events-none" aria-hidden>
          <div className="text-micro text-muted">Per 100,000 people</div>
          <div className="h-1.5 rounded-full mt-2" style={{ background: `linear-gradient(90deg, ${rampColors("heat").join(",")})` }} />
          <div className="flex justify-between text-micro text-muted tabular mt-1.5"><span>{fmt(domain.lo)}</span><span>{fmt(domain.hi)}+</span></div>
        </div>
      )}
      <button type="button" onClick={() => go(null)} aria-label="Open the map explorer"
              className={`absolute z-10 grid place-items-center rounded-full bg-surface text-ink transition-colors hover:bg-tile focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal
                          ${compact ? "right-4 top-4 w-12 h-12" : "right-5 bottom-5 w-[72px] h-[72px]"}`}>
        <ArrowUpRight size={compact ? 20 : 26} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

/** Highest-rate districts as plain reference-style rows (56px, no borders): name with the ratio to the national rate
 * underneath, the rate right-aligned, a small signal dot + "Hotspot" for High–High clusters. */
export function TopDistricts({ yearTo, n = 5 }: { yearTo: number; n?: number }) {
  const nav = useNavigate();
  const select = useGeoSelection((s) => s.select);
  const { top, national } = useOverviewMap(yearTo);
  const go = (code: string | null) => { select(code); nav("/geo"); };
  if (!top.length) return <Loading h={280} />;
  return (
    <ol className="flex flex-col -mx-3" aria-label="Highest-rate districts">
      {top.slice(0, n).map((r) => {
        const hot = r.lisa_quadrant === "HH";
        return (
          <li key={r.geo_code}>
            <button onClick={() => go(r.geo_code)} title={`${r.name}: 95% CI ${fmt(r.asr_lci)}–${fmt(r.asr_uci)} per 100,000`}
                    className="w-full h-14 flex items-center gap-3 px-3 rounded-tile hover:bg-tile text-left transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] leading-5 font-medium text-ink truncate">{r.name}</span>
                <span className="flex items-center gap-3 text-micro text-muted tabular mt-0.5">
                  {national ? <span>{fmt((r.asr ?? 0) / national, 1)}× national</span> : null}
                  {hot && <span className="inline-flex items-center gap-1.5 text-signal-text" title={LISA_LABEL.HH}><span className="w-1.5 h-1.5 rounded-full bg-signal" aria-hidden />Hotspot</span>}
                </span>
              </span>
              <span className="text-[17px] leading-6 font-medium text-ink tabular">{fmt(r.asr)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** v2 export name kept for any external import: the hero stage. */
export const MiniMap = MapHero;
