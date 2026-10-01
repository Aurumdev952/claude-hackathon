import { useMemo } from "react";
import { Button } from "@heroui/react";
import { motion } from "framer-motion";
import { ChevronRight, MapPin, Sparkles, X } from "lucide-react";
import type { Insight, MapRow } from "@/api/types";
import { aiInsightCards, useInsights } from "@/api/hooks";
import { AnimatedNumber, DeltaChip, DetailModal, InfoHint, Loading, StatTile, StatusChip, useDetailModal } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
import { SPRING_SOFT } from "@/lib/motion";
import { useThemeMode } from "@/components/charts/EChart";
import { fmt, int } from "@/lib/format";
import { SEQ_DARK, SEQ_LIGHT } from "@/lib/viz";
import { districtSeriesId, type EventRow, type Facility, type SpatialRow, type StageRow, useJoinpointSafe, useStageMix } from "./data";
import { AsrTrend, annotationsFor, SegmentList } from "./AsrTrend";
import { cleanName, LISA_LABEL, lisaRgb, rgbCss, tierRgb } from "./model";

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
  const card = pickInsight(aiInsightCards(ins.data) ?? [], row, spatial, ratio, q);
  return (
    <motion.aside initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={SPRING_SOFT}
      className="absolute top-3 right-3 bottom-3 w-[372px] z-20 flex flex-col overflow-hidden rounded-card bg-surface border border-border shadow-float" aria-label={`${row?.name ?? code} district details`}>
      <header className="px-5 pt-4 pb-4 border-b border-border/80">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-tile bg-accent-soft text-accent grid place-items-center shrink-0" aria-hidden><MapPin size={17} /></span>
          <div className="flex-1 min-w-0">
            <h2 className="text-h1 leading-tight truncate">{row?.name ?? code}</h2>
            <div className="text-micro text-fg-muted tabular">District · {code} · {period}</div>
          </div>
          <Button isIconOnly size="sm" radius="full" variant="flat" onPress={onClose} aria-label="Close district panel"
                  className="min-w-8 w-8 h-8 bg-surface-2 border border-border text-fg-muted data-[hover=true]:text-fg"><X size={15} /></Button>
        </div>
        <div className="flex items-end gap-2 mt-3">
          <div className="flex items-baseline gap-1">
            {row?.suppressed ? <span className="text-metric">&lt;5</span> : <AnimatedNumber value={row?.asr ?? null} decimals={1} className="text-display tabular" />}
            <span className="text-label text-fg-muted">{row?.suppressed ? "cases" : "ASR /100k"}</span>
          </div>
          <InfoHint size={13} label="About this rate" title={`ASR · ${period}`}
                    content={row?.suppressed ? "Suppressed for this period (fewer than 5 cases)." : `95% CI ${fmt(row?.asr_lci)}–${fmt(row?.asr_uci)} per 100,000. Crude rate ${fmt(row?.crude_rate)}.`} />
          <span className="flex-1" />
          {ratio && <DeltaChip delta={{ text: `${fmt(ratio, 2)}× national`, dir: ratio > 1.05 ? 1 : ratio < 0.95 ? -1 : 0, tone: ratio > 1.1 ? "bad" : ratio < 0.9 ? "good" : "neutral" }} className="mb-1.5" />}
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <StatusChip status={q === "HH" ? "critical" : q === "LL" ? "good" : q === "NS" ? "neutral" : "info"} title={spatial?.lisa_p !== null && spatial?.lisa_p !== undefined && q !== "NS" ? `LISA p ${fmt(spatial.lisa_p, 3)}` : undefined}
                      icon={<span className="w-2 h-2 rounded-sm" style={{ background: rgbCss(lisaRgb(q)) }} aria-hidden />} label={LISA_LABEL[q] ?? q} />
          {row?.coverage_flag && <StatusChip status="warning" label="Low EMR coverage" />}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3">
          <StatTile label="Rank" value={rank ? `#${rank}` : "—"} unit={`of ${n}`} />
          <StatTile label="SIR" value={spatial?.sir ?? null} decimals={2} info={`95% CI ${fmt(spatial?.sir_lci, 2)}–${fmt(spatial?.sir_uci, 2)}. Observed ÷ expected cases (1.0 = national).`} />
          <StatTile label="Cases" value={row?.suppressed ? "<5" : row?.cases ?? null} />
        </div>
      </header>
      <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-5">
        <section>
          <SubHead title="ASR trend · joinpoint" info="All ages, both sexes, confirmed + probable (district joinpoints are fitted for this series only)." />
          {jp.isLoading ? <Loading h={170} /> : jp.error ? <ErrorNote error={jp.error} /> : jp.data ? (
            <>
              <AsrTrend obs={jp.data.observed} fitted={jp.data.fitted} segments={jp.data.segments} events={ann.endo} emrSpan={ann.emrSpan} emrLabel={ann.emrLabel}
                        height={190} compact ariaLabel={`ASR trend for ${row?.name}`} />
              <SegmentList segments={jp.data.segments} aapc={jp.data.aapc_last10} />
            </>
          ) : <p className="text-xs text-fg-muted">No joinpoint series for this district.</p>}
        </section>
        <section>
          <SubHead title={`Stage at diagnosis · ${period}`} info="Share of cancers with a known stage; unstaged cases are counted separately." />
          {stage.isLoading || natStage.isLoading ? <Loading h={60} /> : (
            <StageBars rows={[{ label: row?.name ?? code, data: pool(stage.data?.data ?? [], period) }, { label: "Rwanda", data: pool(natStage.data?.data ?? [], period) }]} />
          )}
        </section>
        <section>
          <SubHead title="Top facilities" info="By first-seen cancers, all years. Ring = H. pylori testing tier (low / medium / high)." />
          {fac.length ? (
            <table className="w-full text-[12px] tabular">
              <thead><tr className="text-micro text-fg-muted"><th className="text-left font-medium pb-1">Facility</th><th className="text-right font-medium">Cases</th><th className="text-right font-medium">HP test</th><th className="text-right font-medium">Stage IV</th></tr></thead>
              <tbody>
                {fac.map((f) => (
                  <tr key={f.location_id} className="border-t border-border/70">
                    <td className="py-1.5 pr-2"><span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ boxShadow: `inset 0 0 0 2px ${rgbCss(tierRgb(f.tier))}` }} title={`${f.tier ?? "unknown"} testing tier`} aria-hidden />
                      <span className="truncate max-w-[150px]" title={cleanName(f.name)}>{cleanName(f.name).replace("District Hospital", "DH").replace("Health Centre", "HC")}</span></span></td>
                    <td className="text-right">{int(f.n_cases)}</td>
                    <td className="text-right">{f.hp_test_rate === null ? "—" : `${fmt(100 * f.hp_test_rate, 0)}%`}</td>
                    <td className="text-right">{f.pct_stage4 === null ? "—" : `${fmt(f.pct_stage4, 0)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-xs text-fg-muted">No facility data.</p>}
        </section>
        <InsightCard source={card.source} title={card.title} body={card.body} />
      </div>
    </motion.aside>
  );
}

function SubHead({ title, info }: { title: string; info?: string }) {
  return (
    <div className="flex items-center gap-0.5 mb-1.5">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {info && <InfoHint size={13} content={info} title={title} label={`About ${title}`} className="!w-6 !h-6 !min-w-6" />}
    </div>
  );
}

/** Insight teaser: title on the card, the full text in a DetailModal. */
function InsightCard({ source, title, body }: { source: string; title: string; body: string }) {
  const d = useDetailModal();
  return (
    <>
      <button onClick={d.open} className="text-left rounded-tile bg-accent-soft/60 border border-accent/20 p-3 hover:bg-accent-soft transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group">
        <div className="flex items-center gap-1.5 text-micro font-medium text-accent"><Sparkles size={12} aria-hidden />{source}<ChevronRight size={13} className="ml-auto opacity-60 group-hover:opacity-100" aria-hidden /></div>
        <div className="text-[13px] font-semibold leading-snug mt-1 text-fg">{title}</div>
      </button>
      <DetailModal {...d.modalProps} title={title} icon={<Sparkles size={17} />} subtitle={source} size="lg">
        <p className="text-[13.5px] leading-relaxed text-fg/90">{body}</p>
      </DetailModal>
    </>
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
            <div className="truncate text-fg-muted">{r.label}</div>
            {known === 0 ? <div className="text-fg-muted">No staged cases</div> : (
              <div>
                <div className="flex h-3.5 gap-[2px] rounded-sm overflow-hidden" role="img" aria-label={`${r.label} stage mix: ${STAGES.map((k) => `stage ${k} ${Math.round((100 * (r.data[k] ?? 0)) / known)}%`).join(", ")}`}>
                  {STAGES.map((k, i) => { const p = (100 * (r.data[k] ?? 0)) / known; return p > 0 ? <div key={k} style={{ width: `${p}%`, background: col(i) }} title={`Stage ${k}: ${p.toFixed(1)}% (${r.data[k] ?? 0})`} /> : null; })}
                </div>
                <div className="text-[10px] text-fg-muted tabular mt-0.5">IV {Math.round((100 * (r.data.IV ?? 0)) / known)}% · n={known}{unk ? ` · ${unk} unstaged` : ""}</div>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-3 text-[10px] text-fg-muted mt-0.5 pl-[80px]">
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
