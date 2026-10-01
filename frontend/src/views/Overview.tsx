import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Activity, Clock, FlaskConical, Layers, MapPin, Microscope, Scale, TrendingUp, Users } from "lucide-react";
import type { RateRow } from "@/api/types";
import { useFiltersMeta, useKpis } from "@/api/hooks";
import { AnimatedNumber, BentoGrid, Card, chartDetailTabs, DataTable, GridItem, Loading, PageHeader, Skeleton, StatTile } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { useThemeMode } from "@/components/charts/EChart";
import { SERIES } from "@/lib/viz";
import { cardEnter } from "@/lib/motion";
import { fmt, int, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { nationalSeriesId, useEvents, useJoinpointSafe, useNationalRates } from "./geo/data";
import { AsrTrend, annotationsFor, type Obs } from "./geo/AsrTrend";
import { HeroStat, KpiCard, type KpiDef, type KpiPoint } from "./overview/KpiStrip";
import { MapHero, TopDistricts } from "./overview/MiniMap";
import { CountsVsAsr, countsVsAsrSummary } from "./overview/CountsVsAsr";

/** Narrow screens move the hero's arrow to the top and drop its legend tile. */
function useNarrow(px = 640) {
  const q = `(max-width: ${px - 1}px)`;
  const [n, setN] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const h = () => setN(m.matches);
    m.addEventListener?.("change", h);
    return () => m.removeEventListener?.("change", h);
  }, [q]);
  return n;
}

const SEX = { ALL: "both sexes", M: "men", F: "women" } as const;
const BAND = { ALL: "all ages", "<50": "under 50", "50-64": "50–64", "65+": "65 and over" } as const;

/** V1 National Overview (SPEC §16.3), design v3: the 3D district map is the hero (sky stage, white stats strip, one
 * round arrow to the Geo Explorer), the national trend beside it, three indicator cards, then counts vs rate and the
 * highest-rate districts. The hero strip and the three cards together form the "Headline indicators" list (6 items). */
export default function Overview() {
  const f = useFilters();
  const mode = useThemeMode();
  const narrow = useNarrow();
  const meta = useFiltersMeta();
  const years: number[] = meta.data?.data?.years ?? [];
  const lastYear = years.length ? years[years.length - 1] : 2026;
  const year = Math.max(2016, Math.min(f.yearTo, lastYear));
  const kq = useKpis(year);
  const rq = useNationalRates();
  const jpId = nationalSeriesId(f.sex, f.ageBand, f.caseDef);
  const jp = useJoinpointSafe(jpId);
  const ev = useEvents();
  const ann = useMemo(() => annotationsFor(ev.data?.data, null), [ev.data]);
  const crude = f.metric === "crude_rate";
  const filtered = f.sex !== "ALL" || f.ageBand !== "ALL" || f.caseDef !== "CONFIRMED_PROBABLE";
  const rates = (rq.data?.data ?? []).filter((r) => r.period_type === "YEAR").map((r) => ({ ...r, y: Number(r.period) }));
  const ratesInRange = rates.filter((r) => r.y >= f.yearFrom && r.y <= f.yearTo);

  const kpis = useMemo<KpiDef[] | null>(() => {
    const k = kq.data?.data;
    if (!k || !rates.length) return null;
    const cur = rates.find((r) => r.y === year), prev = rates.find((r) => r.y === year - 1);
    const annual = (r: (typeof rates)[number] | undefined) => {
      if (!r) return null;
      const p = rates.find((x) => x.y === r.y - 1);
      return r.partial_year && p?.population ? ((r.cases ?? 0) * p.population) / (r.population || 1) : r.cases;
    };
    const flagOf = (r: RateRow): KpiPoint["flag"] => (r.partial_year ? "partial" : r.coverage_flag ? "low" : null);
    const spark = (vals: { year: number; value: number | null }[]): KpiPoint[] =>
      vals.filter((p) => p.year <= year && p.year >= f.yearFrom).map((p) => ({ ...p, flag: p.year === k.years[k.years.length - 1] && k.partial_year ? "partial" : null }));
    const sp = k.sparklines;
    const prevOf = (key: string) => sp[key]?.find((p) => p.year === year - 1)?.value ?? null;
    const tone = (d: number | null, upIsGood: boolean, eps: number) => (d === null || Math.abs(d) < eps ? "neutral" : (d > 0) === upIsGood ? "good" : "bad") as "good" | "bad" | "neutral";
    const dir = (d: number | null) => (d === null || d === 0 ? 0 : d > 0 ? 1 : -1) as -1 | 0 | 1;
    const vs = `vs ${year - 1}`;
    const scope = filtered ? "All patients: the sex and age filters do not apply to this indicator." : undefined;

    const cAnn = annual(cur), cPrev = prev?.cases ?? null;
    const cD = cAnn !== null && cAnn !== undefined && cPrev ? (100 * (cAnn - cPrev)) / cPrev : null;
    const aD = cur?.asr !== null && cur?.asr !== undefined && prev?.asr !== null && prev?.asr !== undefined ? cur.asr - prev.asr : null;
    const aSig = aD !== null && prev?.asr !== null && cur?.asr_lci !== null && cur?.asr_uci !== null && prev && (prev.asr! < cur!.asr_lci! || prev.asr! > cur!.asr_uci!);
    const s4 = k.pct_stage_iv, s4p = prevOf("pct_stage_iv"), s4D = s4 !== null && s4p !== null ? s4 - s4p : null;
    const di = k.median_diag_interval_days, dip = prevOf("median_diag_interval_days"), diD = di !== null && dip !== null ? di - dip : null;
    const hp = k.hp_testing_rate_dyspepsia, hpp = prevOf("hp_testing_rate_dyspepsia"), hpD = hp !== null && hpp !== null ? 100 * (hp - hpp) : null;
    const partial = !!cur?.partial_year;
    return [
      { id: "cases", label: `Cases ${partial ? `${year} to date` : year}`, value: int(cur?.cases), unit: "cases", partial,
        sub: partial ? `About ${int(cAnn)} over a full year` : `${SEX[f.sex][0].toUpperCase()}${SEX[f.sex].slice(1)}, ${BAND[f.ageBand]}`,
        delta: cD === null ? null : { text: `${signed(cD, 1, "%")} ${vs}`, dir: dir(cD), tone: "neutral", note: partial ? "annualised" : undefined },
        spark: rates.filter((r) => r.y <= year && r.y >= f.yearFrom).map((r) => ({ year: r.y, value: annual(r) ?? null, flag: flagOf(r) })), format: (v) => int(v) },
      { id: "asr", label: "National ASR", short: "National rate", value: fmt(cur?.asr), unit: "per 100k", partial,
        sub: `95% CI ${fmt(cur?.asr_lci)}–${fmt(cur?.asr_uci)}`,
        delta: aD === null ? null : { text: `${signed(aD, 1)} ${vs}`, dir: dir(aD), tone: aSig ? tone(aD, false, 0) : "neutral", note: aSig ? undefined : "within CI" },
        spark: rates.filter((r) => r.y <= year && r.y >= f.yearFrom).map((r) => ({ year: r.y, value: r.asr, flag: flagOf(r) })), format: (v) => fmt(v) },
      { id: "s4", label: "Stage IV at diagnosis", short: "Stage IV at diagnosis", value: fmt(s4, 0), unit: "%", partial, sub: "Of cases with a known stage",
        delta: s4D === null ? null : { text: `${signed(s4D, 1)} pts ${vs}`, dir: dir(s4D), tone: tone(s4D, false, 2) },
        spark: spark(sp.pct_stage_iv ?? []), format: (v) => `${fmt(v, 0)}%`, scope },
      { id: "di", label: "Time to diagnosis", value: int(di), unit: "days", partial, sub: di !== null ? `Median, about ${fmt(di / 30.44, 1)} months from first symptom` : undefined,
        delta: diD === null ? null : { text: `${signed(diD, 0)} d ${vs}`, dir: dir(diD), tone: tone(diD, false, 7) },
        spark: spark(sp.median_diag_interval_days ?? []), format: (v) => `${int(v)} days`, scope },
      { id: "hp", label: "H. pylori testing", value: hp === null ? "—" : fmt(100 * hp, 0), unit: "%", partial, sub: "Of dyspepsia patients tested",
        delta: hpD === null ? null : { text: `${signed(hpD, 1)} pts ${vs}`, dir: dir(hpD), tone: tone(hpD, true, 1) },
        spark: spark((sp.hp_testing_rate_dyspepsia ?? []).map((p) => ({ ...p, value: p.value === null ? null : 100 * p.value }))), format: (v) => `${fmt(v, 1)}%`, scope },
      { id: "await", label: "Awaiting endoscopy", short: "High risk, not yet scoped", value: k.high_risk_awaiting_endoscopy === null ? "—" : int(k.high_risk_awaiting_endoscopy), unit: "patients", partial: false,
        missing: k.high_risk_awaiting_endoscopy === null ? "Not published this run" : "High-risk (HIGH band) patients not yet scoped", delta: null, spark: [], format: (v) => int(v),
        scope: k.high_risk_awaiting_endoscopy === null ? "Needs risk scores in the KPI mart" : "Current snapshot (no history)" },
    ];
  }, [kq.data, rates, year, f.yearFrom, f.sex, f.ageBand, filtered]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trend: joinpoint series when the pipeline models this filter combination; otherwise observed rates only.
  const obs: Obs[] = crude
    ? ratesInRange.map((r) => ({ year: r.y, asr: r.crude_rate, lci: null, uci: null, cases: r.cases, coverage_flag: r.coverage_flag, partial_year: r.partial_year }))
    : jp.data ? jp.data.observed.filter((o) => o.year >= f.yearFrom && o.year <= f.yearTo)
    : ratesInRange.map((r) => ({ year: r.y, asr: r.asr, lci: r.asr_lci, uci: r.asr_uci, cases: r.cases, coverage_flag: r.coverage_flag, partial_year: r.partial_year }));
  const fit = !crude && jp.data ? jp.data.fitted.filter((x) => x.year >= f.yearFrom && x.year <= f.yearTo) : null;
  const segs = !crude && jp.data ? jp.data.segments : null;
  const aapc = jp.data?.aapc_last10;
  const sub = `Per 100,000, ${SEX[f.sex]}, ${BAND[f.ageBand]}, ${f.caseDef === "CONFIRMED" ? "confirmed cases" : "confirmed and probable cases"}, ${f.yearFrom}–${f.yearTo}`;

  const lastSeg = segs?.length ? segs[segs.length - 1] : null;
  const ytd = !!kq.data?.data.partial_year && year === lastYear;
  const pair = countsVsAsrSummary(ratesInRange);
  const trendTable = (
    <DataTable rows={obs} columns={[
      { key: "year", label: "Year" }, { key: "asr", label: crude ? "Crude" : "ASR", num: true, fmt: (v) => fmt(v) },
      { key: "lci", label: "95% CI", num: true, fmt: (_, r) => (r.lci === null ? "—" : `${fmt(r.lci)}–${fmt(r.uci)}`) },
      { key: "cases", label: "Cases", num: true, fmt: (v) => int(v) },
      { key: "coverage_flag", label: "Flag", fmt: (v, r) => (r.partial_year ? "year to date" : v ? "low EMR coverage" : "") }]} />
  );
  const trendMethod = crude
    ? "Crude rate = cases ÷ live-facility person-years. Not age-adjusted. Dashed years have under 50% of facilities live (EMR roll-out) or are year-to-date."
    : "Annual ASR (WHO World Standard) with 95% Fay–Feuer CI. Joinpoint: weighted log-linear segmented regression (0–2 joinpoints, BIC selection); APC per segment, * = 95% CI excludes 0. Low-coverage and year-to-date points are dashed and excluded from the fit.";
  const trendNotes = <>
    {crude ? "Crude rates are not age-adjusted; switch the filter bar to Age-standardised for the joinpoint model." :
      !jpId || !jp.data ? "No joinpoint model is fitted for this sex and age combination, so only observed rates are shown." :
      jp.data.n_joinpoints ? `${jp.data.n_joinpoints} joinpoint${jp.data.n_joinpoints > 1 ? "s" : ""} detected (diamond). ` : "No joinpoint detected: a single log-linear trend fits best. "}
    {!crude && jp.data && segs?.length ? segs.map((s) => `${s.start_year}–${s.end_year}: APC ${signed(s.apc, 1, "%")} (${fmt(s.apc_lci)} to ${fmt(s.apc_uci)})${s.significant ? "" : ", not significant"}`).join("; ") + "." : ""}
    {" "}Triangles mark endoscopy units opening: local diagnosis rises without more cancer (INS-5).
  </>;
  const trendChart = (h: number) => (
    <AsrTrend obs={obs} fitted={fit} segments={segs} events={ann.endo} emrSpan={ann.emrSpan} height={h} unit="" name={crude ? "Crude rate" : "Observed ASR"}
              ariaLabel={`National ${crude ? "crude" : "age-standardised"} rate trend, ${sub}`} />
  );

  const byId = (id: string) => kpis?.find((k) => k.id === id);
  const lastObs = [...obs].reverse().find((o) => o.asr !== null);
  const ciZero = aapc && aapc.lci !== null && aapc.uci !== null ? aapc.lci <= 0 && aapc.uci >= 0 : null;
  const trendStatus = (s: { apc: number; significant: boolean } | null) => (!s ? "" : !s.significant ? "Not significant" : s.apc > 0 ? "Rising" : "Falling");
  const S = SERIES[mode];

  return (
    <div className="flex flex-col gap-5 min-w-0">
      <PageHeader icon={<Activity size={18} />} title={`Gastric cancer in Rwanda, ${year}${ytd ? " to date" : ""}`}
        info={{
          about: <>Rates are per 100,000 person-years of the population served by live EMR facilities, so the 2015–2019 roll-out does not masquerade as rising cancer.{ytd && <> {year} is year to date and flagged throughout.</>}</>,
          method: <ul className="flex flex-col gap-1.5">
            <li><b>Dashed</b> lines mark years with under half of facilities on the EMR, or the current year to date. Treat them as unreliable.</li>
            <li><b>Bands</b> are 95% confidence intervals; a change inside the band is reported as within the interval, not as a trend.</li>
            <li><b>Joinpoints</b> mark where the trend changes slope; APC is the annual percent change in that segment.</li>
          </ul>,
          notes: "The ministry view shows aggregates only; districts with fewer than 5 cases are suppressed.",
        }} />

      {kq.error && <ErrorNote error={kq.error} />}

      <BentoGrid>
        {/* Hero: the 3D district map */}
        <GridItem span={{ lg: 8 }} className="row-start-1 col-start-1">
          <Card hero padding="none" aria-label="District map, age-standardised rate" className="min-h-[460px] max-sm:min-h-[420px] overflow-hidden !bg-sky-soft dark:!border-transparent">
            <MapHero yearTo={f.yearTo} compact={narrow} />
          </Card>
        </GridItem>

        {/* National trend */}
        <GridItem span={{ lg: 4 }}>
          <Card title={crude ? "National crude rate" : "National trend"} icon={<TrendingUp size={16} />} bodyClassName="flex flex-col"
                detail={{ tabs: chartDetailTabs({ chart: trendChart(420), table: trendTable, method: trendMethod, notes: trendNotes }), subtitle: sub }}
                detailLabel="National trend: details">
            {(jp.isLoading || rq.isLoading) ? <Loading h={300} /> : (rq.error && !jp.data) ? <ErrorNote error={rq.error} /> : (
              <>
                {!crude && aapc && aapc.value !== null ? (
                  <>
                    <div className="flex items-baseline gap-1.5">
                      <AnimatedNumber value={aapc.value} format={(n) => signed(n, 1, "%")} className="text-display text-ink tabular" />
                      <span className="text-[15px] leading-5 text-muted">per year</span>
                    </div>
                    <div className="text-label font-normal text-muted mt-1.5">Average change over 10 years{ciZero ? ", within the 95% CI" : ""}</div>
                  </>
                ) : (
                  <>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-display text-ink tabular">{fmt(lastObs?.asr)}</span>
                      <span className="text-[15px] leading-5 text-muted">per 100k</span>
                    </div>
                    <div className="text-label font-normal text-muted mt-1.5">{crude ? "Crude rate" : "Age-standardised rate"} in {lastObs?.year ?? "the latest year"}</div>
                  </>
                )}
                <div className="mt-4 -mx-1 flex-1 min-h-[170px]">
                  <AsrTrend obs={obs} fitted={fit} segments={segs} emrSpan={ann.emrSpan} height={180} bare unit="" name={crude ? "Crude rate" : "Observed ASR"}
                            ariaLabel={`National ${crude ? "crude" : "age-standardised"} rate trend, ${sub}`} />
                </div>
                {!crude && lastSeg && (
                  <div className="grid grid-cols-2 gap-2.5 mt-3">
                    <StatTile label={`Since ${lastSeg.start_year}`} value={signed(lastSeg.apc, 1, "%")} unit="per year" sub={trendStatus(lastSeg)}
                              info={`Annual percent change ${lastSeg.start_year}–${lastSeg.end_year}, 95% CI ${fmt(lastSeg.apc_lci)} to ${fmt(lastSeg.apc_uci)}.`} />
                    <StatTile label="Joinpoints" value={jp.data?.n_joinpoints ?? 0} sub={jp.data?.n_joinpoints ? "Where the slope changes" : "One straight trend"} />
                  </div>
                )}
              </>
            )}
          </Card>
        </GridItem>

        {/* Headline indicators: three numbers in the hero strip + three cards (six list items) */}
        <div role="list" aria-label="Headline indicators" className="contents">
          {kpis && (
            <motion.div variants={cardEnter} className="row-start-1 col-start-1 col-span-12 lg:col-span-8 self-end relative z-10 p-5 pr-[112px] max-sm:p-3 pointer-events-none">
              <div className="pointer-events-auto flex gap-1 w-full max-w-[660px] rounded-[20px] bg-surface p-1.5">
                <HeroStat k={byId("asr")!} icon={<Activity />} />
                <HeroStat k={byId("s4")!} icon={<Layers />} />
                <HeroStat k={byId("await")!} icon={<Microscope />} attention={!byId("await")?.missing?.startsWith("Not")} />
              </div>
            </motion.div>
          )}
          {kpis ? (
            <>
              <GridItem role="listitem" span={{ md: 4 }} aria-label={`${byId("cases")!.label}: ${byId("cases")!.value}`}>
                <KpiCard k={byId("cases")!} icon={<Users />} visual="dots" />
              </GridItem>
              <GridItem role="listitem" span={{ md: 4 }} aria-label={`${byId("di")!.label}: ${byId("di")!.value} days`}>
                <KpiCard k={byId("di")!} icon={<Clock />} visual="line" />
              </GridItem>
              <GridItem role="listitem" span={{ md: 4 }} aria-label={`${byId("hp")!.label}: ${byId("hp")!.value}%`}>
                <KpiCard k={byId("hp")!} icon={<FlaskConical />} visual="bar" />
              </GridItem>
            </>
          ) : !kq.error && [0, 1, 2].map((i) => (
            <GridItem key={i} span={{ md: 4 }}><Skeleton variant="card" h={300} label="Reading the KPI mart" /></GridItem>
          ))}
        </div>

        {/* Counts vs rate */}
        <GridItem span={{ lg: 8 }}>
          <Card title="Counts vs rate" icon={<Scale size={16} />}
                detail={{ tabs: chartDetailTabs({ chart: <CountsVsAsr rows={ratesInRange} height={380} />, table: <DataTable rows={ratesInRange} columns={[{ key: "y", label: "Year" }, { key: "cases", label: "Cases", num: true, fmt: (v) => int(v) },
                  { key: "asr", label: "ASR", num: true, fmt: (v) => fmt(v) }, { key: "coverage_flag", label: "Flag", fmt: (v, r) => (r.partial_year ? "year to date" : v ? "low EMR coverage" : "") }]} />,
                  method: "Both series are divided by their value in the first year with full EMR coverage (= 100), so they share one axis. Raw counts climb as facilities go live; the person-time-based ASR stays near its baseline (INS-7).",
                  notes: pair ? `From ${pair.from} to ${pair.to}${pair.partial ? " (year to date, annualised)" : ""}, recorded cases multiplied by ${fmt(pair.cases, 1)} while the age-standardised rate moved ×${fmt(pair.asr, 2)}: the extra cases are facilities joining the EMR, not more cancer.` : undefined }),
                  subtitle: `Indexed to the first full-coverage year, ${SEX[f.sex]}, ${BAND[f.ageBand]}` }}
                detailLabel="Counts vs rate: details">
            <div className="flex flex-wrap items-end gap-x-10 gap-y-3 mb-4">
              <div>
                <div className="flex items-baseline gap-1.5"><span className="text-metric text-ink tabular">{pair ? `×${fmt(pair.cases, 1)}` : "—"}</span><span className="text-[15px] text-muted">cases</span></div>
                <div className="text-label font-normal text-muted mt-0.5 tabular">Recorded, {pair ? `${pair.from} to ${pair.to}` : "since full coverage"}</div>
              </div>
              <div>
                <div className="flex items-baseline gap-1.5"><span className="text-metric text-ink tabular">{pair ? `×${fmt(pair.asr, 2)}` : "—"}</span><span className="text-[15px] text-muted">rate</span></div>
                <div className="text-label font-normal text-muted mt-0.5">Age-standardised, same years</div>
              </div>
              <div className="ml-auto flex items-center gap-4 text-micro text-muted pb-1" aria-hidden>
                <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: S[2] }} />Cases</span>
                <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: S[0] }} />Rate</span>
                <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t-2 border-dashed border-faint" />Low coverage</span>
              </div>
            </div>
            {rq.isLoading ? <Loading h={240} /> : rq.error ? <ErrorNote error={rq.error} /> : <CountsVsAsr rows={ratesInRange} height={240} legend={false} />}
          </Card>
        </GridItem>

        {/* Highest-rate districts */}
        <GridItem span={{ lg: 4 }}>
          <Card title="Highest rates" icon={<MapPin size={16} />}
                info={{ about: "District age-standardised rates per 100,000, pooled over the latest three complete years. Select a district to open it in the map explorer.",
                        notes: "Hotspot means a High–High cluster: a high-rate district surrounded by high-rate neighbours (local Moran's I, p < 0.05). Hover a row for its 95% CI." }}>
            <TopDistricts yearTo={f.yearTo} n={5} />
          </Card>
        </GridItem>
      </BentoGrid>
    </div>
  );
}
