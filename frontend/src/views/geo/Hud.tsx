import { Pause, Play } from "lucide-react";
import { InfoHint, Seg } from "@/components/ui";
import type { MapRow } from "@/api/types";
import { fmt, int } from "@/lib/format";
import type { Facility, Period, PeriodMode, SpatialRow } from "./data";
import { cleanName, LISA_LABEL, LISA_ORDER, lisaRgb, rampColors, rgbCss, theme, tierRgb, TIER_ORDER, tFor, type MetricDef } from "./model";
import type { Arc, HoverInfo } from "./GeoScene";

const LISA_SHORT: Record<string, string> = { HH: "hotspot", HL: "high outlier", LH: "low outlier", LL: "coldspot", NS: "not sig." };

/** Overlay surface over the map stage: flat white, a hairline only in dark mode. */
export const HUD = "bg-surface rounded-tile text-ink dark:border dark:border-hairline";

export function Legend({ metric, domain, national, period, showFacilities, showHex, showArcs, hasLowCov, hasSuppressed }: {
  metric: MetricDef; domain: { lo: number; hi: number }; national: number | null; period: string; showFacilities: boolean; showHex: boolean; showArcs: boolean;
  hasLowCov: boolean; hasSuppressed: boolean;
}) {
  const t = theme();
  const ramp = rampColors(metric.ramp === "cat" ? "heat" : metric.ramp);
  const natT = metric.ramp === "div" ? 0.5 : national !== null && (metric.key === "asr" || metric.key === "crude_rate") ? tFor(metric, national, domain) : null;
  const notes = [
    showHex ? "Hex columns: cases within 3 km bins; height and colour show the count. Counts follow population (Kigali), so compare with the ASR for risk. Points are jittered within sectors, never addresses." : null,
    !showHex ? `Height shows ${metric.key === "lisa_quadrant" ? "the ASR" : metric.short}, from zero, so colour is never the only cue.` : null,
    showFacilities ? "Facilities: ring colour shows the H. pylori testing tier and size the number of dyspepsia patients; a diamond is an endoscopy unit." : null,
    showArcs ? "Arcs: modelled referral paths to the endoscopy unit open at the period end; width shows cases." : null,
    hasLowCov && !showHex ? "Faded districts have low EMR coverage, so their rates are unreliable." : null,
    hasSuppressed && !showHex ? "Grey districts have fewer than 5 cases and are suppressed." : null,
  ].filter(Boolean) as string[];
  return (
    <div className={`${HUD} pl-4 pr-2 py-3 w-[256px] text-[12px]`} aria-label="Map legend">
      <div className="flex items-center gap-1">
        <div className="font-medium text-[13px] truncate flex-1">{metric.label}</div>
        <span className="text-muted tabular shrink-0">{metric.periodic ? period.replace("-", "–") : metric.staticNote?.replace(/^.* (\d{4}–\d{4}).*$/, "$1") ?? "all years"}</span>
        <InfoHint title={metric.label} about={metric.unit} notes={<ul className="flex flex-col gap-1">{notes.map((n) => <li key={n}>{n}</li>)}</ul>} label="About the map legend" size={13} placement="top-start" className="!w-6 !h-6 !min-w-6" />
      </div>
      <div className="pr-2">
      {showHex ? (
        <div className="mt-2">
          <div className="h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${ramp.slice(1).join(",")})` }} />
          <div className="flex justify-between text-muted mt-1"><span>fewer cases</span><span>more cases</span></div>
        </div>
      ) : metric.ramp === "cat" ? (
        <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
          {LISA_ORDER.map((q) => (
            <li key={q} className="flex items-center gap-1.5" title={LISA_LABEL[q]}><span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: rgbCss(lisaRgb(q)) }} aria-hidden />
              <span className="font-semibold">{q}</span><span className="text-muted truncate">{LISA_SHORT[q]}</span></li>
          ))}
        </ul>
      ) : (
        <div className="mt-2">
          <div className="relative h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${ramp.join(",")})` }}>
            {natT !== null && <span className="absolute -top-1 -bottom-1 w-[2px] bg-ink rounded-full" style={{ left: `calc(${Math.max(0, Math.min(1, natT)) * 100}% - 1px)` }} aria-hidden />}
          </div>
          <div className="flex justify-between text-muted mt-1.5 tabular">
            <span>{metric.format(domain.lo)}</span>
            {natT !== null && <span className="text-ink">{metric.ramp === "div" ? "1.0 is national" : `National ${metric.format(national)}`}</span>}
            <span>{metric.format(domain.hi)}+</span>
          </div>
        </div>
      )}
      {(showFacilities || ((hasLowCov || hasSuppressed) && !showHex) || showArcs) && (
        <div className="mt-2.5 pt-2.5 border-t border-hairline flex flex-wrap gap-x-3 gap-y-1 text-muted">
          {showFacilities && TIER_ORDER.map((k) => (
            <span key={k} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ boxShadow: `inset 0 0 0 2px ${rgbCss(tierRgb(k))}` }} aria-hidden />{k}</span>
          ))}
          {showFacilities && <span className="flex items-center gap-1"><svg width="11" height="11" viewBox="0 0 64 64" aria-hidden><path fill="currentColor" fillRule="evenodd" d="M32 2 L62 32 L32 62 L2 32 Z M32 21 A11 11 0 1 0 32.01 21 Z" /></svg>endoscopy</span>}
          {hasLowCov && !showHex && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: `repeating-linear-gradient(45deg, ${rgbCss(t.land)} 0 2px, ${rgbCss(t.suppressed)} 2px 4px)` }} aria-hidden />low coverage</span>}
          {hasSuppressed && !showHex && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: rgbCss(t.suppressed) }} aria-hidden />&lt;5 cases</span>}
          {showArcs && <span className="flex items-center gap-1"><svg width="18" height="10" viewBox="0 0 22 12" aria-hidden className="shrink-0"><path d="M1 11 Q11 -4 21 11" fill="none" stroke="#3987e5" strokeWidth="2" /></svg>referral</span>}
        </div>
      )}
      </div>
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
    <div className={`${HUD} !rounded-[20px] pl-2.5 pr-3 py-2.5 flex items-center gap-4`} role="group" aria-label="Time slider">
      <button className="w-10 h-10 rounded-full bg-ink text-ink-on flex items-center justify-center shrink-0 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-40"
              onClick={onPlay} aria-label={playing ? "Pause" : "Play through years"} disabled={!periodic || periods.length < 2}>
        {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
      </button>
      <div className="w-[118px] shrink-0 leading-tight">
        <div className="text-micro text-muted">{mode === "YEAR" ? "Single year" : "3-year pooled"}{cur?.partial ? ", to date" : ""}</div>
        <div className="text-[18px] leading-6 font-medium tabular tracking-[-0.01em]">{cur ? (cur.type === "YEAR" ? cur.end : `${cur.start}–${cur.end}`) : "—"}</div>
      </div>
      <div className={`flex-1 min-w-0 ${periodic ? "" : "opacity-45"}`} title={periodic ? undefined : staticNote ? `${staticNote}; the slider is paused` : "Fixed period"}>
        <input type="range" min={0} max={Math.max(0, periods.length - 1)} step={1} value={idx} onChange={(e) => onIdx(Number(e.target.value))}
               className="block w-full h-6 cursor-pointer appearance-none bg-transparent focus:outline-none focus-visible:[&::-webkit-slider-thumb]:outline focus-visible:[&::-webkit-slider-thumb]:outline-2 focus-visible:[&::-webkit-slider-thumb]:outline-signal
                          [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:[background:linear-gradient(to_right,rgb(var(--ink))_0_var(--fill),rgb(var(--hairline))_var(--fill)_100%)]
                          [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-hairline [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-ink
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface
                          [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface"
               style={{ ["--fill" as string]: `${periods.length > 1 ? (100 * idx) / (periods.length - 1) : 100}%` }}
               aria-label="Period" aria-valuetext={cur?.id} disabled={!periodic} />
        <div className="flex justify-between text-[11px] text-muted tabular -mt-0.5 px-[2px]">
          {periods.map((p, i) => (
            <button key={p.id} onClick={() => periodic && onIdx(i)} className={`relative whitespace-nowrap ${i === idx ? "text-ink font-semibold" : "hover:text-ink"}`} tabIndex={-1}
                    title={lowCov[p.id] ? `${lowCov[p.id]} district(s) with low EMR coverage in ${p.id}` : p.partial ? "Year to date (annualised)" : p.id}>
              {label(p)}{(lowCov[p.id] ?? 0) > 0 && <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-faint" aria-hidden />}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!periodic && <span className="text-micro text-muted mr-1" title={staticNote ? `${staticNote}; the slider is paused` : undefined}>Fixed period</span>}
        <Seg label="Period type" variant="glass" value={mode} onChange={onMode} options={[{ value: "POOLED3", label: compact ? "3-yr" : "3-yr pooled" }, { value: "YEAR", label: compact ? "1-yr" : "Single year" }]} />
        {periodic && !compact && Object.values(lowCov).some(Boolean) && <InfoHint mode="tooltip" size={13} label="About the period markers" content="A dot under a period marks districts with low EMR coverage in that period." className="!w-6 !h-6 !min-w-6" />}
      </div>
    </div>
  );
}

export function HoverCard({ hover, rows, metric, rank, n, spatial, w }: {
  hover: HoverInfo; rows: Map<string, MapRow>; metric: MetricDef; rank: Map<string, number>; n: number; spatial: Map<string, SpatialRow>; w: number;
}) {
  const left = Math.min(hover.x + 16, w - 268);
  const style = { left, top: Math.max(8, hover.y - 12) };
  const box = `bg-surface shadow-float rounded-tile dark:border dark:border-hairline absolute z-20 pointer-events-none px-4 py-3 text-[12px] w-[252px]`;
  if (hover.kind === "hex") return <div className={box} style={style}><b className="tabular">{hover.count}</b> case{hover.count === 1 ? "" : "s"} in this 3 km cell<div className="text-muted mt-0.5">Jittered within the sector, selected period</div></div>;
  if (hover.kind === "arc") return <div className={box} style={style}><div className="font-semibold">{hover.arc.fromName} to {cleanName(hover.arc.toName)}</div><div className="text-muted mt-0.5">Modelled referral path, {int(hover.arc.n)} cases in the period</div></div>;
  if (hover.kind === "facility") {
    const f = hover.fac;
    return (
      <div className={box} style={style}>
        <div className="font-semibold leading-snug">{cleanName(f.name)}</div>
        <div className="text-muted">{f.facility_type.replace("_", " ").toLowerCase()}{hover.endo ? ", endoscopy unit" : ""}</div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 mt-1.5 tabular">
          <dt className="text-muted">H. pylori testing</dt><dd>{f.hp_test_rate === null ? "—" : `${fmt(100 * f.hp_test_rate, 1)}%`} <span className="text-muted">({f.tier ?? "—"} tier)</span></dd>
          <dt className="text-muted">Dyspepsia patients</dt><dd>{int(f.n_dyspepsia)}</dd>
          <dt className="text-muted">First-seen cancers</dt><dd>{int(f.n_cases)}</dd>
          <dt className="text-muted">Stage IV</dt><dd>{f.pct_stage4 === null ? "—" : `${fmt(f.pct_stage4, 0)}%`}</dd>
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
        <div className="text-muted tabular">#{rank.get(r.geo_code) ?? "—"} of {n}</div>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 mt-1.5 tabular">
        {metric.key !== "asr" && metric.key !== "lisa_quadrant" && (<><dt className="text-muted">{metric.short}</dt><dd className="font-semibold">{r.suppressed && !["sir", "hp_test_rate", "pct_stage4"].includes(metric.key) ? "—" : metric.format(r[metric.key] as number | null)}</dd></>)}
        <dt className="text-muted">ASR (95% CI)</dt><dd>{r.suppressed ? "—" : <><b>{fmt(r.asr)}</b> <span className="text-muted">{fmt(r.asr_lci)}–{fmt(r.asr_uci)}</span></>}</dd>
        {metric.key !== "crude_rate" && (<><dt className="text-muted">Crude rate</dt><dd>{r.suppressed ? "—" : fmt(r.crude_rate)}</dd></>)}
        <dt className="text-muted">Cases</dt><dd>{r.suppressed ? "<5" : int(r.cases)}</dd>
        <dt className="text-muted">LISA</dt><dd><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: rgbCss(lisaRgb(q)) }} aria-hidden />{q === "NS" ? "not significant" : `${q}${s?.lisa_p !== null && s?.lisa_p !== undefined ? `, p ${fmt(s.lisa_p, 3)}` : ""}`}</dd>
      </dl>
      {r.coverage_flag && <div className="mt-1.5 text-[11px] text-tone-warning">Low EMR coverage: the rate is unreliable</div>}
      {r.suppressed && <div className="mt-1.5 text-[11px] text-muted">Fewer than 5 cases, suppressed</div>}
      <div className="text-[11px] text-muted mt-1.5">Select to explore the district</div>
    </div>
  );
}

export type { Arc, Facility };
