import { useMemo } from "react";
import { Button } from "@heroui/react";
import { motion } from "framer-motion";
import { ChevronRight, Sparkles, X } from "lucide-react";
import type { Insight, MapRow } from "@/api/types";
import { aiInsightCards, useInsights } from "@/api/hooks";
import { AnimatedNumber, DeltaChip, DetailModal, InfoHint, Loading, StatTile, useDetailModal } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
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
    <motion.aside initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}
      className="absolute top-5 right-5 bottom-5 w-[372px] z-20 flex flex-col overflow-hidden rounded-card bg-surface dark:border dark:border-hairline" aria-label={`${row?.name ?? code} district details`}>
      <header className="px-6 pt-5 pb-5">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-h1 truncate">{row?.name ?? code}</h2>
            <div className="flex items-center gap-3 text-label font-normal text-muted tabular mt-0.5"><span>District {code}</span><span>{period.replace("-", "–")}</span></div>
          </div>
          <Button isIconOnly size="sm" radius="full" variant="light" onPress={onClose} aria-label="Close district panel"
                  className="min-w-9 w-9 h-9 border border-hairline text-ink data-[hover=true]:bg-tile"><X size={16} /></Button>
        </div>
        <div className="flex items-baseline gap-1.5 mt-5">
          {row?.suppressed ? <span className="text-display">&lt;5</span> : <AnimatedNumber value={row?.asr ?? null} decimals={1} className="text-display tabular" />}
          <span className="text-[15px] text-muted">{row?.suppressed ? "cases" : "per 100k"}</span>
          <InfoHint size={14} label="About this rate" title={`Age-standardised rate, ${period.replace("-", "–")}`}
                    content={row?.suppressed ? "Suppressed for this period (fewer than 5 cases)." : `95% CI ${fmt(row?.asr_lci)}–${fmt(row?.asr_uci)} per 100,000. Crude rate ${fmt(row?.crude_rate)}.`} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-label font-normal text-muted">
          <span>Age-standardised rate</span>
          {ratio && <DeltaChip delta={{ text: `${fmt(ratio, 2)}× national`, dir: ratio > 1.05 ? 1 : ratio < 0.95 ? -1 : 0, tone: ratio > 1.1 ? "bad" : ratio < 0.9 ? "good" : "neutral" }} className="!font-normal" />}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-label">
          <span className="inline-flex items-center gap-1.5 text-ink" title={spatial?.lisa_p !== null && spatial?.lisa_p !== undefined && q !== "NS" ? `LISA p ${fmt(spatial.lisa_p, 3)}` : undefined}>
            <span className="w-2 h-2 rounded-full" style={{ background: rgbCss(lisaRgb(q)), boxShadow: q === "NS" ? "inset 0 0 0 1px rgb(var(--faint))" : undefined }} aria-hidden />{LISA_LABEL[q] ?? q}
          </span>
          {row?.coverage_flag && <span className="text-tone-warning">Low EMR coverage</span>}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-4">
          <StatTile label="Rank" value={rank ? `#${rank}` : "—"} unit={`of ${n}`} />
          <StatTile label="SIR" value={spatial?.sir ?? null} decimals={2} info={`95% CI ${fmt(spatial?.sir_lci, 2)}–${fmt(spatial?.sir_uci, 2)}. Observed ÷ expected cases (1.0 is the national level).`} />
          <StatTile label="Cases" value={row?.suppressed ? "<5" : row?.cases ?? null} />
        </div>
      </header>
      <div className="flex-1 overflow-auto px-6 pb-6 flex flex-col gap-6">
        <section>
          <SubHead title="Trend" info="Age-standardised rate with joinpoint segments; all ages, both sexes, confirmed and probable cases (district joinpoints are fitted for this series only)." />
          {jp.isLoading ? <Loading h={170} /> : jp.error ? <ErrorNote error={jp.error} /> : jp.data ? (
            <>
              <AsrTrend obs={jp.data.observed} fitted={jp.data.fitted} segments={jp.data.segments} events={ann.endo} emrSpan={ann.emrSpan} emrLabel={ann.emrLabel}
                        height={190} compact ariaLabel={`ASR trend for ${row?.name}`} />
              <SegmentList segments={jp.data.segments} aapc={jp.data.aapc_last10} />
            </>
          ) : <p className="text-label font-normal text-muted">No joinpoint series for this district.</p>}
        </section>
        <section>
          <SubHead title="Stage at diagnosis" info="Share of cancers with a known stage in the selected period; unstaged cases are counted separately." />
          {stage.isLoading || natStage.isLoading ? <Loading h={60} /> : (
            <StageBars rows={[{ label: row?.name ?? code, data: pool(stage.data?.data ?? [], period) }, { label: "Rwanda", data: pool(natStage.data?.data ?? [], period) }]} />
          )}
        </section>
        <section>
          <SubHead title="Top facilities" info="By first-seen cancers, all years. The ring shows the H. pylori testing tier (low, medium, high)." />
          {fac.length ? (
            <ul className="flex flex-col">
              {fac.map((f) => (
                <li key={f.location_id} className="flex items-center gap-3 py-2.5 border-t border-hairline first:border-t-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ boxShadow: `inset 0 0 0 2px ${rgbCss(tierRgb(f.tier))}` }} title={`${f.tier ?? "unknown"} testing tier`} aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14px] text-ink truncate" title={cleanName(f.name)}>{cleanName(f.name).replace("District Hospital", "DH").replace("Health Centre", "HC")}</span>
                    <span className="flex gap-3 text-micro text-muted tabular"><span>HP tested {f.hp_test_rate === null ? "—" : `${fmt(100 * f.hp_test_rate, 0)}%`}</span><span>Stage IV {f.pct_stage4 === null ? "—" : `${fmt(f.pct_stage4, 0)}%`}</span></span>
                  </span>
                  <span className="text-right"><span className="block text-[15px] font-medium text-ink tabular">{int(f.n_cases)}</span><span className="block text-micro text-muted">cases</span></span>
                </li>
              ))}
            </ul>
          ) : <p className="text-label font-normal text-muted">No facility data.</p>}
        </section>
        <InsightCard source={card.source} title={card.title} body={card.body} />
      </div>
    </motion.aside>
  );
}

function SubHead({ title, info }: { title: string; info?: string }) {
  return (
    <div className="flex items-center gap-0.5 mb-2">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {info && <InfoHint size={13} content={info} title={title} label={`About ${title}`} className="!w-6 !h-6 !min-w-6" />}
    </div>
  );
}

/** Insight teaser: title on the card, the full text in a DetailModal. */
function InsightCard({ source, title, body }: { source: string; title: string; body: string }) {
  const d = useDetailModal();
  return (
    <>
      <button onClick={d.open} className="text-left rounded-tile bg-tile px-4 py-3.5 hover:bg-tile-hover transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal group">
        <div className="flex items-center gap-1.5 text-micro text-muted"><Sparkles size={12} aria-hidden />{source}<ChevronRight size={14} className="ml-auto opacity-60 group-hover:opacity-100" aria-hidden /></div>
        <div className="text-[14px] font-medium leading-snug mt-1 text-ink">{title}</div>
      </button>
      <DetailModal {...d.modalProps} title={title} icon={<Sparkles size={17} />} subtitle={source} size="lg">
        <p className="text-[14px] leading-[22px] text-ink/90">{body}</p>
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
          <div key={r.label} className="grid grid-cols-[72px_1fr] items-center gap-2 text-[12px]">
            <div className="truncate text-muted">{r.label}</div>
            {known === 0 ? <div className="text-muted">No staged cases</div> : (
              <div>
                <div className="flex h-2.5 gap-[2px] rounded-full overflow-hidden" role="img" aria-label={`${r.label} stage mix: ${STAGES.map((k) => `stage ${k} ${Math.round((100 * (r.data[k] ?? 0)) / known)}%`).join(", ")}`}>
                  {STAGES.map((k, i) => { const p = (100 * (r.data[k] ?? 0)) / known; return p > 0 ? <div key={k} style={{ width: `${p}%`, background: col(i) }} title={`Stage ${k}: ${p.toFixed(1)}% (${r.data[k] ?? 0})`} /> : null; })}
                </div>
                <div className="flex gap-3 text-[11px] text-muted tabular mt-1"><span>Stage IV {Math.round((100 * (r.data.IV ?? 0)) / known)}%</span><span>n = {known}</span>{unk ? <span>{unk} unstaged</span> : null}</div>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-3 text-[11px] text-muted mt-1 pl-[80px]">
        {STAGES.map((k, i) => <span key={k} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: col(i) }} aria-hidden />Stage {k}</span>)}
      </div>
    </div>
  );
}

function pickInsight(cards: Insight[], row: MapRow | undefined, sp: SpatialRow | undefined, ratio: number | null, q: string) {
  const name = row?.name ?? "";
  const hit = cards.find((c) => name && (c.body.includes(name) || c.title.includes(name)));
  if (hit) return { source: `AI insight, ${hit.generated_by}`, title: hit.title, body: hit.body };
  const lvl = ratio === null ? "" : ratio >= 1.3 ? "well above" : ratio >= 1.1 ? "above" : ratio <= 0.77 ? "well below" : ratio <= 0.9 ? "below" : "close to";
  const sirTxt = sp?.sir ? ` Observed cases are ${fmt(sp.sir, 2)}× the number expected from national age–sex rates (2019–2025, 95% CI ${fmt(sp.sir_lci, 2)}–${fmt(sp.sir_uci, 2)}).` : "";
  const ageTxt = row?.asr && row?.crude_rate && row.crude_rate / row.asr > 0.8 ? " Its crude rate sits unusually close to its ASR: an older population, so raw counts overstate risk." : "";
  return {
    source: "Template summary",
    title: q === "HH" ? `${name} sits inside a hotspot cluster` : `${name}: rate ${lvl || "close to"} national`,
    body: `${name}'s age-standardised rate is ${fmt(row?.asr)} per 100,000${ratio ? ` (${fmt(ratio, 2)}× national)` : ""}.${sirTxt}${q !== "NS" ? ` Local Moran's I classes it ${LISA_LABEL[q]?.toLowerCase()}.` : ""}${ageTxt}`,
  };
}
