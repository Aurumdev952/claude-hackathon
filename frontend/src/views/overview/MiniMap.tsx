import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useGeo, useProvGeo } from "@/api/hooks";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Loading } from "@/components/ui/Skeleton";
import { StatusChip } from "@/components/ui/StatusChip";
import { useThemeMode } from "@/components/charts/EChart";
import { fmt } from "@/lib/format";
import { useGeoSelection } from "@/state/selection";
import { useMapSeries, usePeriods } from "../geo/data";
import { GeoScene } from "../geo/GeoScene";
import { domainFor, LISA_LABEL, METRICS, rampColors } from "../geo/model";

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
    <div className="flex flex-col h-full gap-3">
      <div className="relative rounded-tile overflow-hidden border border-border/70 h-[268px] cursor-pointer" onClick={() => !rows.length && go(null)}
           style={{ background: "radial-gradient(70% 70% at 50% 45%, rgb(var(--surface)), rgb(var(--surface-2)) 100%)" }}>
        {(geo.error || series.error) ? <div className="p-3"><ErrorNote error={geo.error ?? series.error} /></div>
          : !(geo.data && prov.data && rows.length) ? <Loading h={268} label="Raising the map" />
          : <GeoScene variant="mini" districts={geo.data} provinces={prov.data} rows={rows} metric={metric} domain={domain} onSelect={go} labels={0} />}
        <div className="absolute left-2.5 bottom-2.5 z-10 glass rounded-[10px] px-2.5 py-1.5 w-[138px] pointer-events-none">
          <div className="text-micro text-fg-muted tabular">ASR · {period?.id}</div>
          <div className="h-1.5 rounded-full mt-1" style={{ background: `linear-gradient(90deg, ${rampColors("heat").join(",")})` }} />
          <div className="flex justify-between text-micro text-fg-muted tabular mt-0.5"><span>{fmt(domain.lo)}</span><span>{fmt(domain.hi)}+</span></div>
        </div>
      </div>
      <ol className="flex flex-col gap-1" aria-label="Highest-rate districts">
        {top.map((r, i) => (
          <li key={r.geo_code}>
            <button onClick={() => go(r.geo_code)} title={`${r.name}: ASR ${fmt(r.asr)} (95% CI ${fmt(r.asr_lci)}–${fmt(r.asr_uci)})`}
                    className="w-full flex items-center gap-2.5 py-1.5 px-2 rounded-[10px] hover:bg-surface-2 text-left text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              <span className="w-5 h-5 rounded-full bg-surface-2 border border-border text-micro text-fg-muted tabular grid place-items-center shrink-0">{i + 1}</span>
              <span className="font-medium flex-1 truncate">{r.name}</span>
              {r.lisa_quadrant && r.lisa_quadrant !== "NS" && <StatusChip status={r.lisa_quadrant === "HH" ? "critical" : "info"} label={r.lisa_quadrant} title={LISA_LABEL[r.lisa_quadrant]} />}
              <span className="tabular font-semibold w-10 text-right">{fmt(r.asr)}</span>
              <span className="tabular text-micro text-fg-muted w-9 text-right">{national ? `${fmt((r.asr ?? 0) / national, 1)}×` : ""}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
