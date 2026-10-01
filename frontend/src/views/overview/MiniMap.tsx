import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useGeo, useProvGeo } from "@/api/hooks";
import { ErrorNote, Loading } from "@/components/ui/Panel";
import { useThemeMode } from "@/components/charts/EChart";
import { fmt } from "@/lib/format";
import { useGeoSelection } from "@/state/selection";
import { useMapSeries, usePeriods } from "../geo/data";
import { GeoScene } from "../geo/GeoScene";
import { domainFor, LISA_LABEL, lisaRgb, METRICS, rampColors, rgbCss } from "../geo/model";

/** Mini 3D map for the Overview (click anywhere -> Geo Explorer; click a district -> Geo Explorer focused on it). */
export function MiniMap({ yearTo }: { yearTo: number }) {
  useThemeMode();
  const nav = useNavigate();
  const select = useGeoSelection((s) => s.select);
  const periods = usePeriods("POOLED3");
  const period = useMemo(() => { const ok = periods.filter((p) => p.end <= yearTo); return ok[ok.length - 1] ?? periods[periods.length - 1]; }, [periods, yearTo]);
  const one = useMemo(() => (period ? [period] : []), [period]);
  const series = useMapSeries(one);
  const geo = useGeo(), prov = useProvGeo();
  const rows = (period && series.byPeriod[period.id]) || [];
  const metric = METRICS.asr;
  const domain = useMemo(() => domainFor(metric, rows), [metric, rows]);
  const national = period ? series.national[period.id] ?? null : null;
  const top = [...rows].filter((r) => r.asr !== null && !r.suppressed).sort((a, b) => (b.asr ?? 0) - (a.asr ?? 0)).slice(0, 4);
  const go = (code: string | null) => { select(code); nav("/geo"); };
  return (
    <div className="flex flex-col h-full">
      <div className="relative rounded-lg overflow-hidden border border-line/50 h-[290px] cursor-pointer" onClick={() => !rows.length && go(null)}
           style={{ background: "radial-gradient(70% 70% at 50% 45%, rgb(var(--ridge2) / 0.7), rgb(var(--basalt)) 100%)" }}>
        {(geo.error || series.error) ? <div className="p-3"><ErrorNote error={geo.error ?? series.error} /></div>
          : !(geo.data && prov.data && rows.length) ? <Loading h={290} label="Raising the map" />
          : <GeoScene variant="mini" districts={geo.data} provinces={prov.data} rows={rows} metric={metric} domain={domain} onSelect={go} labels={0} />}
        <button onClick={(e) => { e.stopPropagation(); go(null); }}
                className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium bg-ridge/90 border border-line/60 hover:border-kivu text-mist focus-visible:ring-2 ring-kivu">
          Open Geo Explorer <ArrowUpRight size={12} />
        </button>
        <div className="absolute left-2 bottom-2 z-10 rounded-md bg-ridge/90 border border-line/60 px-2 py-1.5 text-[10px] text-fog w-[150px] pointer-events-none">
          <div className="flex justify-between"><span>ASR · {period?.id}</span></div>
          <div className="h-1.5 rounded-sm mt-1" style={{ background: `linear-gradient(90deg, ${rampColors("heat").join(",")})` }} />
          <div className="flex justify-between tabular mt-0.5"><span>{fmt(domain.lo)}</span><span>{fmt(domain.hi)}+</span></div>
          <div className="mt-0.5">Height = ASR</div>
        </div>
      </div>
      <ol className="mt-2.5 flex flex-col divide-y divide-line/40 text-xs" aria-label="Highest-rate districts">
        {top.map((r, i) => (
          <li key={r.geo_code}>
            <button onClick={() => go(r.geo_code)} className="w-full flex items-center gap-2 py-1.5 px-1 rounded hover:bg-ridge2/50 text-left focus-visible:ring-2 ring-kivu">
              <span className="text-fog tabular w-4">{i + 1}</span>
              <span className="font-medium flex-1 truncate">{r.name}</span>
              {r.lisa_quadrant && r.lisa_quadrant !== "NS" && (
                <span className="chip bg-ridge2 text-mist !py-0" title={LISA_LABEL[r.lisa_quadrant]}><span className="w-1.5 h-1.5 rounded-sm" style={{ background: rgbCss(lisaRgb(r.lisa_quadrant)) }} aria-hidden />{r.lisa_quadrant}</span>
              )}
              <span className="tabular font-semibold w-10 text-right">{fmt(r.asr)}</span>
              <span className="tabular text-fog w-[74px] text-right">{fmt(r.asr_lci)}–{fmt(r.asr_uci)}</span>
              <span className="tabular text-fog w-10 text-right">{national ? `${fmt((r.asr ?? 0) / national, 1)}×` : ""}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="text-[10px] text-fog mt-1">ASR per 100,000 (95% CI) · × = ratio to national {fmt(national)} · HH = High–High LISA cluster</div>
    </div>
  );
}
