import { useMemo } from "react";
import { Sparkles, X } from "lucide-react";
import type { Insight, MapRow } from "@/api/types";
import { useInsights } from "@/api/hooks";
import { ErrorNote, Loading } from "@/components/ui/Panel";
import { useThemeMode } from "@/components/charts/EChart";
import { fmt, int } from "@/lib/format";
import { SEQ_DARK, SEQ_LIGHT } from "@/lib/viz";
import { districtSeriesId, type EventRow, type Facility, type SpatialRow, type StageRow, useJoinpointSafe, useStageMix } from "./data";
import { AsrTrend, annotationsFor, SegmentList } from "./AsrTrend";
import { cleanName, LISA_LABEL, lisaRgb, rgbCss, tierRgb } from "./model";
import { HUD } from "./Hud";

const STAGES = ["I", "II", "III", "IV"] as const;

/** District drill-down (SPEC §16.3 V2): ASR trend + CI with joinpoint, stage mix, top facilities, insight card. */
export function DistrictPanel({ code, row, rank, n, spatial, facilities, events, national, period, onClose }: {
  code: string; row: MapRow | undefined; rank: number | undefined; n: number; spatial: SpatialRow | undefined; facilities: Facility[]; events: EventRow[] | undefined;
  national: number | null; period: string; onClose: () => void;
}) {
  const jp = useJoinpointSafe(districtSeriesId(code));
  const stage = useStageMix(code);
  const natStage = useStageMix("RW");
  const ins = useInsights("geo");
  const ann = useMemo(() => annotationsFor(events, code), [events, code]);
  const fac = facilities.filter((f) => f.district_code === code).sort((a, b) => b.n_cases - a.n_cases || b.n_dyspepsia - a.n_dyspepsia).slice(0, 5);
  const q = row?.lisa_quadrant ?? spatial?.lisa_quadrant ?? "NS";
  const ratio = row?.asr && national ? row.asr / national : null;
  const card = pickInsight(ins.data?.data ?? [], row, spatial, ratio, q);
  return (
    <aside className={`${HUD} absolute top-3 right-3 bottom-3 w-[372px] z-20 flex flex-col overflow-hidden animate-rise`} aria-label={`${row?.name ?? code} district details`}>
      <header className="px-4 pt-3.5 pb-3 border-b border-line/50">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="panel-title">District · {code}</div>
            <h2 className="text-xl font-bold leading-tight">{row?.name ?? code}</h2>
          </div>
          <button className="p-1.5 rounded-lg text-fog hover:text-mist hover:bg-ridge2 focus-visible:ring-2 ring-kivu" onClick={onClose} aria-label="Close district panel"><X size={16} /></button>
        </div>
        <div className="flex items-end gap-4 mt-2">
          <div>
            <div className="text-[11px] text-fog">ASR · {period}</div>
            <div className="text-[30px] font-bold leading-none mt-0.5">{fmt(row?.asr)}</div>
            <div className="text-[11px] text-fog tabular mt-1">95% CI {fmt(row?.asr_lci)}–{fmt(row?.asr_uci)} per 100k</div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[11px] tabular ml-auto">
            <dt className="text-fog">Rank</dt><dd className="text-right font-semibold">#{rank ?? "—"} of {n}</dd>
            <dt className="text-fog">vs national</dt><dd className="text-right font-semibold">{ratio ? `${fmt(ratio, 2)}×` : "—"}</dd>
            <dt className="text-fog">SIR</dt><dd className="text-right">{fmt(spatial?.sir, 2)} <span className="text-fog">({fmt(spatial?.sir_lci, 2)}–{fmt(spatial?.sir_uci, 2)})</span></dd>
            <dt className="text-fog">Cases</dt><dd className="text-right">{row?.suppressed ? "<5" : int(row?.cases)}</dd>
          </dl>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <span className="chip bg-ridge2 text-mist"><span className="w-2 h-2 rounded-sm" style={{ background: rgbCss(lisaRgb(q)) }} aria-hidden />{LISA_LABEL[q] ?? q}{spatial?.lisa_p !== null && spatial?.lisa_p !== undefined && q !== "NS" ? ` · p ${fmt(spatial.lisa_p, 3)}` : ""}</span>
          <span className="chip bg-ridge2 text-fog">Crude {fmt(row?.crude_rate)}</span>
          {row?.coverage_flag && <span className="chip bg-sorghum/15 text-sorghum">⚑ low EMR coverage</span>}
        </div>
      </header>
      <div className="flex-1 overflow-auto px-4 py-3 flex flex-col gap-4">
        <section>
          <h3 className="panel-title mb-1">ASR trend · joinpoint</h3>
          {jp.isLoading ? <Loading h={170} /> : jp.error ? <ErrorNote error={jp.error} /> : jp.data ? (
            <>
              <AsrTrend obs={jp.data.observed} fitted={jp.data.fitted} segments={jp.data.segments} events={ann.endo} emrSpan={ann.emrSpan} emrLabel={ann.emrLabel}
                        height={190} compact ariaLabel={`ASR trend for ${row?.name}`} />
              <div className="text-[10px] text-fog mb-1.5">All ages, both sexes, confirmed + probable (district joinpoints are fitted for this series only).</div>
              <SegmentList segments={jp.data.segments} aapc={jp.data.aapc_last10} />
            </>
          ) : <p className="text-xs text-fog">No joinpoint series for this district.</p>}
        </section>
        <section>
          <h3 className="panel-title mb-1.5">Stage at diagnosis · {period}</h3>
          {stage.isLoading || natStage.isLoading ? <Loading h={60} /> : (
            <StageBars rows={[{ label: row?.name ?? code, data: pool(stage.data?.data ?? [], period) }, { label: "Rwanda", data: pool(natStage.data?.data ?? [], period) }]} />
          )}
        </section>
        <section>
          <h3 className="panel-title mb-1.5">Top facilities by first-seen cancers</h3>
          {fac.length ? (
            <table className="w-full text-[11px] tabular">
              <thead><tr className="text-fog"><th className="text-left font-semibold pb-1">Facility</th><th className="text-right font-semibold">Cases</th><th className="text-right font-semibold">HP test</th><th className="text-right font-semibold">Stage IV</th></tr></thead>
              <tbody>
                {fac.map((f) => (
                  <tr key={f.location_id} className="border-t border-line/40">
                    <td className="py-1 pr-2"><span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ boxShadow: `inset 0 0 0 2px ${rgbCss(tierRgb(f.tier))}` }} aria-hidden />
                      <span className="truncate max-w-[150px]" title={cleanName(f.name)}>{cleanName(f.name).replace("District Hospital", "DH").replace("Health Centre", "HC")}</span></span></td>
                    <td className="text-right">{int(f.n_cases)}</td>
                    <td className="text-right">{f.hp_test_rate === null ? "—" : `${fmt(100 * f.hp_test_rate, 0)}%`}</td>
                    <td className="text-right">{f.pct_stage4 === null ? "—" : `${fmt(f.pct_stage4, 0)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-xs text-fog">No facility data.</p>}
          <div className="text-[10px] text-fog mt-1">Ring = H. pylori testing tier (low / medium / high); all years.</div>
        </section>
        <section className="panel p-3 border-l-[3px] border-kivu/70">
          <div className="flex items-center gap-1.5 panel-title mb-1"><Sparkles size={12} /> {card.source}</div>
          <h4 className="text-sm font-semibold leading-snug mb-1">{card.title}</h4>
          <p className="text-xs text-fog leading-relaxed">{card.body}</p>
        </section>
      </div>
    </aside>
  );
}

function pool(rows: StageRow[], period: string) {
  const [a, b] = period.split("-").map(Number);
  const inP = rows.filter((r) => { const y = Number(r.year); return y >= a && y <= (b || a); });
  const n: Record<string, number> = {};
  inP.forEach((r) => { n[r.stage_group] = (n[r.stage_group] ?? 0) + r.n; });
  return n;
}

function StageBars({ rows }: { rows: { label: string; data: Record<string, number> }[] }) {
  const m = useThemeMode();
  const ramp = m === "dark" ? SEQ_DARK : SEQ_LIGHT;
  const col = (i: number) => ramp[[1, 3, 4, 6][i]];
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const known = STAGES.reduce((s, k) => s + (r.data[k] ?? 0), 0);
        const unk = r.data.Unknown ?? 0;
        return (
          <div key={r.label} className="grid grid-cols-[72px_1fr] items-center gap-2 text-[11px]">
            <div className="truncate text-fog">{r.label}</div>
            {known === 0 ? <div className="text-fog">No staged cases</div> : (
              <div>
                <div className="flex h-3.5 gap-[2px] rounded-sm overflow-hidden" role="img" aria-label={`${r.label} stage mix: ${STAGES.map((k) => `stage ${k} ${Math.round((100 * (r.data[k] ?? 0)) / known)}%`).join(", ")}`}>
                  {STAGES.map((k, i) => { const p = (100 * (r.data[k] ?? 0)) / known; return p > 0 ? <div key={k} style={{ width: `${p}%`, background: col(i) }} title={`Stage ${k}: ${p.toFixed(1)}% (${r.data[k] ?? 0})`} /> : null; })}
                </div>
                <div className="text-[10px] text-fog tabular mt-0.5">IV {Math.round((100 * (r.data.IV ?? 0)) / known)}% · n={known}{unk ? ` · ${unk} unstaged` : ""}</div>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-3 text-[10px] text-fog mt-0.5 pl-[80px]">
        {STAGES.map((k, i) => <span key={k} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: col(i) }} aria-hidden />Stage {k}</span>)}
      </div>
    </div>
  );
}

function pickInsight(cards: Insight[], row: MapRow | undefined, sp: SpatialRow | undefined, ratio: number | null, q: string) {
  const name = row?.name ?? "";
  const hit = cards.find((c) => name && (c.body.includes(name) || c.title.includes(name)));
  if (hit) return { source: `AI insight · ${hit.generated_by}`, title: hit.title, body: hit.body };
  const lvl = ratio === null ? "" : ratio >= 1.3 ? "well above" : ratio >= 1.1 ? "above" : ratio <= 0.77 ? "well below" : ratio <= 0.9 ? "below" : "close to";
  const sirTxt = sp?.sir ? ` Observed cases are ${fmt(sp.sir, 2)}× the number expected from national age–sex rates (2019–2025, 95% CI ${fmt(sp.sir_lci, 2)}–${fmt(sp.sir_uci, 2)}).` : "";
  const ageTxt = row?.asr && row?.crude_rate && row.crude_rate / row.asr > 0.8 ? " Its crude rate sits unusually close to its ASR — an older population, so raw counts overstate risk." : "";
  return {
    source: "Template summary",
    title: q === "HH" ? `${name} sits inside a hotspot cluster` : `${name}: rate ${lvl || "—"} national`,
    body: `${name}'s age-standardised rate is ${fmt(row?.asr)} per 100,000${ratio ? ` (${fmt(ratio, 2)}× national)` : ""}.${sirTxt}${q !== "NS" ? ` Local Moran's I classes it ${LISA_LABEL[q]?.toLowerCase()}.` : ""}${ageTxt}`,
  };
}
