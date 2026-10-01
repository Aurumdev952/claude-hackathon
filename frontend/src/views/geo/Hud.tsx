import { Pause, Play } from "lucide-react";
import type { MapRow } from "@/api/types";
import { fmt, int } from "@/lib/format";
import type { Facility, Period, PeriodMode, SpatialRow } from "./data";
import { cleanName, LISA_LABEL, LISA_ORDER, lisaRgb, rampColors, rgbCss, theme, tierRgb, TIER_ORDER, tFor, type MetricDef } from "./model";
import type { Arc, HoverInfo } from "./GeoScene";

export const HUD = "rounded-xl border border-line/60 bg-ridge/90 backdrop-blur-md shadow-panel";

export function Legend({ metric, domain, national, period, showFacilities, showHex, showArcs, hasLowCov, hasSuppressed }: {
  metric: MetricDef; domain: { lo: number; hi: number }; national: number | null; period: string; showFacilities: boolean; showHex: boolean; showArcs: boolean;
  hasLowCov: boolean; hasSuppressed: boolean;
}) {
  const t = theme();
  const ramp = rampColors(metric.ramp === "cat" ? "heat" : metric.ramp);
  const natT = metric.ramp === "div" ? 0.5 : national !== null && (metric.key === "asr" || metric.key === "crude_rate") ? tFor(metric, national, domain) : null;
  return (
    <div className={`${HUD} p-3 w-[264px] text-[11px]`} aria-label="Map legend">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-semibold text-mist text-xs">{metric.label}</div>
        <div className="text-fog tabular shrink-0">{metric.periodic ? period : metric.staticNote?.replace(/^.* (\d{4}–\d{4}).*$/, "$1") ?? "all years"}</div>
      </div>
      <div className="text-fog">{metric.unit}</div>
      {showHex ? (
        <div className="mt-2">
          <div className="h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg, ${ramp.slice(1).join(",")})` }} />
          <div className="flex justify-between text-fog mt-1"><span>fewer cases</span><span>more cases</span></div>
          <p className="text-fog mt-1.5 leading-snug">Hex columns: cases within 3 km bins, height and colour = count. Counts follow population (Kigali) — compare with ASR for risk. Points are jittered within sectors, never addresses.</p>
        </div>
      ) : metric.ramp === "cat" ? (
        <ul className="mt-2 grid grid-cols-1 gap-1">
          {LISA_ORDER.map((q) => (
            <li key={q} className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm shrink-0" style={{ background: rgbCss(lisaRgb(q)) }} aria-hidden />
              <span className="font-semibold w-6">{q}</span><span className="text-fog">{LISA_LABEL[q]}</span></li>
          ))}
        </ul>
      ) : (
        <div className="mt-2">
          <div className="relative h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg, ${ramp.join(",")})` }}>
            {natT !== null && <span className="absolute -top-1 -bottom-1 w-[2px] bg-mist rounded" style={{ left: `calc(${Math.max(0, Math.min(1, natT)) * 100}% - 1px)` }} aria-hidden />}
          </div>
          <div className="flex justify-between text-fog mt-1 tabular">
            <span>{metric.format(domain.lo)}</span>
            {natT !== null && <span className="text-mist">{metric.ramp === "div" ? "1.0 = national" : `national ${metric.format(national)}`}</span>}
            <span>{metric.format(domain.hi)}+</span>
          </div>
        </div>
      )}
      {!showHex && (
        <div className="mt-2 pt-2 border-t border-line/50 flex items-center gap-2 text-fog">
          <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden><path d="M2 14V9l3-2v7zM7 14V5l3-2v11zM12 14V2l3-1.5V14z" fill="currentColor" opacity=".8" /></svg>
          <span>Height = {metric.key === "lisa_quadrant" ? "ASR" : metric.short}, from zero — colour is never the only cue</span>
        </div>
      )}
      {(hasLowCov || hasSuppressed) && !showHex && (
        <div className="mt-1.5 flex flex-col gap-1 text-fog">
          {hasLowCov && <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm shrink-0" style={{ background: `repeating-linear-gradient(45deg, ${rgbCss(t.land)} 0 2px, ${rgbCss(t.suppressed)} 2px 4px)` }} aria-hidden />Low EMR coverage — faded, unreliable</div>}
          {hasSuppressed && <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm shrink-0" style={{ background: rgbCss(t.suppressed) }} aria-hidden />Fewer than 5 cases — suppressed</div>}
        </div>
      )}
      {showFacilities && (
        <div className="mt-2 pt-2 border-t border-line/50">
          <div className="text-fog mb-1">Facilities · ring = H. pylori testing tier · size = dyspepsia patients</div>
          <div className="flex items-center gap-3">
            {TIER_ORDER.map((k) => (
              <span key={k} className="flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ boxShadow: `inset 0 0 0 2px ${rgbCss(tierRgb(k))}` }} aria-hidden />{k}</span>
            ))}
            <span className="flex items-center gap-1"><svg width="12" height="12" viewBox="0 0 64 64" aria-hidden><path fill="currentColor" fillRule="evenodd" d="M32 2 L62 32 L32 62 L2 32 Z M32 21 A11 11 0 1 0 32.01 21 Z" /></svg>endoscopy</span>
          </div>
        </div>
      )}
      {showArcs && (
        <div className="mt-2 pt-2 border-t border-line/50 text-fog leading-snug flex gap-2">
          <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden className="shrink-0 mt-0.5"><path d="M1 11 Q11 -4 21 11" fill="none" stroke="#3987e5" strokeWidth="2" /></svg>
          <span>Modelled referral paths to the endoscopy unit open at the period end · width = cases</span>
        </div>
      )}
    </div>
  );
}

export function TimeSlider({ periods, idx, onIdx, mode, onMode, playing, onPlay, periodic, staticNote, lowCov, compact }: {
  periods: Period[]; idx: number; onIdx: (i: number) => void; mode: PeriodMode; onMode: (m: PeriodMode) => void; playing: boolean; onPlay: () => void;
  periodic: boolean; staticNote?: string; lowCov: Record<string, number>; compact?: boolean;
}) {
  const cur = periods[idx];
  const label = (p: Period) => (compact ? `’${String(p.end).slice(2)}` : p.type === "YEAR" ? String(p.end) : `${String(p.start).slice(2)}–${String(p.end).slice(2)}`);
  return (
    <div className={`${HUD} px-3 py-2 flex items-center gap-3`} role="group" aria-label="Time slider">
      <button className="w-8 h-8 rounded-full bg-kivu/85 hover:bg-kivu text-white flex items-center justify-center shrink-0 focus-visible:ring-2 ring-mist disabled:opacity-40"
              onClick={onPlay} aria-label={playing ? "Pause" : "Play through years"} disabled={!periodic || periods.length < 2}>
        {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>
      <div className="w-[118px] shrink-0 leading-tight">
        <div className="text-[10px] uppercase tracking-[0.14em] text-fog">{mode === "YEAR" ? "Single year" : "3-year pooled"}</div>
        <div className="text-base font-bold tabular">{cur ? (cur.type === "YEAR" ? cur.end : `${cur.start}–${cur.end}`) : "—"}{cur?.partial && <span className="text-[10px] font-semibold text-sorghum ml-1 align-middle">YTD</span>}</div>
      </div>
      <div className={`flex-1 min-w-0 ${periodic ? "" : "opacity-45"}`}>
        <input type="range" min={0} max={Math.max(0, periods.length - 1)} step={1} value={idx} onChange={(e) => onIdx(Number(e.target.value))}
               className="w-full accent-[rgb(var(--kivu))]" aria-label="Period" aria-valuetext={cur?.id} disabled={!periodic} />
        <div className="flex justify-between text-[10px] text-fog tabular -mt-0.5 px-[2px]">
          {periods.map((p, i) => (
            <button key={p.id} onClick={() => periodic && onIdx(i)} className={`relative whitespace-nowrap ${i === idx ? "text-mist font-semibold" : "hover:text-mist"}`} tabIndex={-1}
                    title={lowCov[p.id] ? `${lowCov[p.id]} district(s) with low EMR coverage in ${p.id}` : p.partial ? "Year to date (annualised)" : p.id}>
              {label(p)}{(lowCov[p.id] ?? 0) > 0 && <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-fog" aria-hidden />}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <div className="seg" role="group" aria-label="Period type">
          <button aria-pressed={mode === "POOLED3"} onClick={() => onMode("POOLED3")}>3-yr pooled</button>
          <button aria-pressed={mode === "YEAR"} onClick={() => onMode("YEAR")}>Single year</button>
        </div>
        {!periodic && <div className="text-[10px] text-fog">{compact ? "fixed period" : `${staticNote} — slider paused`}</div>}
        {periodic && !compact && Object.values(lowCov).some(Boolean) && <div className="text-[10px] text-fog flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-fog" aria-hidden />= low-coverage districts</div>}
      </div>
    </div>
  );
}

export function HoverCard({ hover, rows, metric, rank, n, spatial, w }: {
  hover: HoverInfo; rows: Map<string, MapRow>; metric: MetricDef; rank: Map<string, number>; n: number; spatial: Map<string, SpatialRow>; w: number;
}) {
  const left = Math.min(hover.x + 16, w - 268);
  const style = { left, top: Math.max(8, hover.y - 12) };
  const box = `${HUD} absolute z-20 pointer-events-none p-3 text-xs w-[252px]`;
  if (hover.kind === "hex") return <div className={box} style={style}><b className="tabular">{hover.count}</b> case{hover.count === 1 ? "" : "s"} in this 3 km cell<div className="text-fog mt-0.5">Jittered within sector; selected period</div></div>;
  if (hover.kind === "arc") return <div className={box} style={style}><div className="font-semibold">{hover.arc.fromName} → {cleanName(hover.arc.toName)}</div><div className="text-fog mt-0.5">Modelled referral path · {int(hover.arc.n)} cases in period</div></div>;
  if (hover.kind === "facility") {
    const f = hover.fac;
    return (
      <div className={box} style={style}>
        <div className="font-semibold leading-snug">{cleanName(f.name)}</div>
        <div className="text-fog">{f.facility_type.replace("_", " ").toLowerCase()}{hover.endo ? " · endoscopy unit" : ""}</div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 mt-1.5 tabular">
          <dt className="text-fog">H. pylori testing</dt><dd>{f.hp_test_rate === null ? "—" : `${fmt(100 * f.hp_test_rate, 1)}%`} <span className="text-fog">({f.tier ?? "—"} tier)</span></dd>
          <dt className="text-fog">Dyspepsia patients</dt><dd>{int(f.n_dyspepsia)}</dd>
          <dt className="text-fog">First-seen cancers</dt><dd>{int(f.n_cases)}</dd>
          <dt className="text-fog">Stage IV</dt><dd>{f.pct_stage4 === null ? "—" : `${fmt(f.pct_stage4, 0)}%`}</dd>
        </dl>
      </div>
    );
  }
  const r = rows.get(hover.code);
  if (!r) return null;
  const s = spatial.get(hover.code);
  const q = r.lisa_quadrant ?? s?.lisa_quadrant ?? "NS";
  return (
    <div className={box} style={style}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-semibold text-sm">{r.name}</div>
        <div className="text-fog tabular">#{rank.get(r.geo_code) ?? "—"} of {n}</div>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 mt-1.5 tabular">
        {metric.key !== "asr" && metric.key !== "lisa_quadrant" && (<><dt className="text-fog">{metric.short}</dt><dd className="font-semibold">{r.suppressed && !["sir", "hp_test_rate", "pct_stage4"].includes(metric.key) ? "—" : metric.format(r[metric.key] as number | null)}</dd></>)}
        <dt className="text-fog">ASR (95% CI)</dt><dd>{r.suppressed ? "—" : <><b>{fmt(r.asr)}</b> <span className="text-fog">{fmt(r.asr_lci)}–{fmt(r.asr_uci)}</span></>}</dd>
        {metric.key !== "crude_rate" && (<><dt className="text-fog">Crude rate</dt><dd>{r.suppressed ? "—" : fmt(r.crude_rate)}</dd></>)}
        <dt className="text-fog">Cases</dt><dd>{r.suppressed ? "<5" : int(r.cases)}</dd>
        <dt className="text-fog">LISA</dt><dd><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: rgbCss(lisaRgb(q)) }} aria-hidden />{q === "NS" ? "not significant" : `${q}${s?.lisa_p !== null && s?.lisa_p !== undefined ? ` · p ${fmt(s.lisa_p, 3)}` : ""}`}</dd>
      </dl>
      {r.coverage_flag && <div className="mt-1.5 text-[11px] text-sorghum">⚑ Low EMR coverage — rate unreliable</div>}
      {r.suppressed && <div className="mt-1.5 text-[11px] text-fog">Fewer than 5 cases — suppressed</div>}
      <div className="text-[10px] text-fog mt-1.5">Click to explore the district</div>
    </div>
  );
}

export type { Arc, Facility };
