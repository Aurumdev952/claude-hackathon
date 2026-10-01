import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@heroui/react";
import { Activity, ArrowUpRight, GitCommitHorizontal, Map as MapIcon, Scale, TrendingUp } from "lucide-react";
import type { RateRow } from "@/api/types";
import { useFiltersMeta, useKpis } from "@/api/hooks";
import { BentoGrid, Card, chartDetailTabs, DataTable, GridItem, Loading, MetricCard, PageHeader, PairCard, Skeleton, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/Panel";
import { useThemeMode } from "@/components/charts/EChart";
import { SERIES } from "@/lib/viz";
import { fmt, int, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { nationalSeriesId, useEvents, useJoinpointSafe, useNationalRates } from "./geo/data";
import { AsrTrend, annotationsFor, SegmentList, type Obs } from "./geo/AsrTrend";
import { KpiStrip, type KpiDef, type KpiPoint } from "./overview/KpiStrip";
import { MiniMap } from "./overview/MiniMap";
import { CountsVsAsr, countsVsAsrSummary } from "./overview/CountsVsAsr";

const SEX = { ALL: "both sexes", M: "men", F: "women" } as const;
const BAND = { ALL: "all ages", "<50": "under 50", "50-64": "50–64", "65+": "65 and over" } as const;

/** V1 National Overview (SPEC §16.3): KPI strip, mini 3D map, honest national trend with joinpoints and annotations. */
export default function Overview() {
  const f = useFilters();
  const nav = useNavigate();
  const mode = useThemeMode();
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
    const scope = filtered ? "All patients — sex/age filters not applied" : undefined;

    const cAnn = annual(cur), cPrev = prev?.cases ?? null;
    const cD = cAnn !== null && cAnn !== undefined && cPrev ? (100 * (cAnn - cPrev)) / cPrev : null;
    const aD = cur?.asr !== null && cur?.asr !== undefined && prev?.asr !== null && prev?.asr !== undefined ? cur.asr - prev.asr : null;
    const aSig = aD !== null && prev?.asr !== null && cur?.asr_lci !== null && cur?.asr_uci !== null && prev && (prev.asr! < cur!.asr_lci! || prev.asr! > cur!.asr_uci!);
    const s4 = k.pct_stage_iv, s4p = prevOf("pct_stage_iv"), s4D = s4 !== null && s4p !== null ? s4 - s4p : null;
    const di = k.median_diag_interval_days, dip = prevOf("median_diag_interval_days"), diD = di !== null && dip !== null ? di - dip : null;
    const hp = k.hp_testing_rate_dyspepsia, hpp = prevOf("hp_testing_rate_dyspepsia"), hpD = hp !== null && hpp !== null ? 100 * (hp - hpp) : null;
    const partial = !!cur?.partial_year;
    return [
      { id: "cases", label: `Cases ${partial ? `${year} to date` : year}`, value: int(cur?.cases), partial,
        sub: partial ? `≈ ${int(cAnn)} annualised` : `${SEX[f.sex]}, ${BAND[f.ageBand]}`,
        delta: cD === null ? null : { text: `${signed(cD, 1, "%")} ${vs}`, dir: dir(cD), tone: "neutral", note: partial ? "annualised" : undefined },
        spark: rates.filter((r) => r.y <= year && r.y >= f.yearFrom).map((r) => ({ year: r.y, value: annual(r) ?? null, flag: flagOf(r) })), format: (v) => int(v) },
      { id: "asr", label: "National ASR", value: fmt(cur?.asr), unit: "/100k", partial,
        sub: `95% CI ${fmt(cur?.asr_lci)}–${fmt(cur?.asr_uci)}`,
        delta: aD === null ? null : { text: `${signed(aD, 1)} ${vs}`, dir: dir(aD), tone: aSig ? tone(aD, false, 0) : "neutral", note: aSig ? undefined : "within CI" },
        spark: rates.filter((r) => r.y <= year && r.y >= f.yearFrom).map((r) => ({ year: r.y, value: r.asr, flag: flagOf(r) })), format: (v) => fmt(v) },
      { id: "s4", label: "Stage IV at diagnosis", value: fmt(s4, 0), unit: "%", partial, sub: "of cases with a known stage",
        delta: s4D === null ? null : { text: `${signed(s4D, 1)} pts ${vs}`, dir: dir(s4D), tone: tone(s4D, false, 2) },
        spark: spark(sp.pct_stage_iv ?? []), format: (v) => `${fmt(v, 0)}%`, scope },
      { id: "di", label: "Time to diagnosis", value: int(di), unit: "days", partial, sub: di !== null ? `median ≈ ${fmt(di / 30.44, 1)} mo, first GI symptom → dx` : undefined,
        delta: diD === null ? null : { text: `${signed(diD, 0)} d ${vs}`, dir: dir(diD), tone: tone(diD, false, 7) },
        spark: spark(sp.median_diag_interval_days ?? []), format: (v) => `${int(v)} days`, scope },
      { id: "hp", label: "H. pylori testing", value: hp === null ? "—" : fmt(100 * hp, 0), unit: "%", partial, sub: "of dyspepsia patients tested",
        delta: hpD === null ? null : { text: `${signed(hpD, 1)} pts ${vs}`, dir: dir(hpD), tone: tone(hpD, true, 1) },
        spark: spark((sp.hp_testing_rate_dyspepsia ?? []).map((p) => ({ ...p, value: p.value === null ? null : 100 * p.value }))), format: (v) => `${fmt(v, 1)}%`, scope },
      { id: "await", label: "Awaiting endoscopy", value: k.high_risk_awaiting_endoscopy === null ? "—" : int(k.high_risk_awaiting_endoscopy), unit: "patients", partial: false,
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
  const sub = `per 100,000 · ${SEX[f.sex]}, ${BAND[f.ageBand]} · ${f.caseDef === "CONFIRMED" ? "confirmed" : "confirmed + probable"} · ${f.yearFrom}–${f.yearTo}`;

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
      !jpId || !jp.data ? "No joinpoint model is fitted for this sex × age combination — observed rates only." :
      jp.data.n_joinpoints ? `${jp.data.n_joinpoints} joinpoint${jp.data.n_joinpoints > 1 ? "s" : ""} detected (diamond). ` : "No joinpoint detected: a single log-linear trend fits best. "}
    {!crude && jp.data && segs?.length ? segs.map((s) => `${s.start_year}–${s.end_year}: APC ${signed(s.apc, 1, "%")} (${fmt(s.apc_lci)} to ${fmt(s.apc_uci)})${s.significant ? "" : ", not significant"}`).join(" · ") : ""}
    {" "}▲ marks endoscopy units opening — local diagnosis rises without more cancer (INS-5).
  </>;
  const trendChart = (h: number) => (
    <AsrTrend obs={obs} fitted={fit} segments={segs} events={ann.endo} emrSpan={ann.emrSpan} height={h} unit="" name={crude ? "Crude rate" : "Observed ASR"}
              ariaLabel={`National ${crude ? "crude" : "age-standardised"} rate trend, ${sub}`} />
  );

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <PageHeader icon={<Activity size={18} />} title={`Gastric cancer in Rwanda, ${year}${ytd ? " to date" : ""}`}
        info={{
          about: <>Rates are per 100,000 person-years of the population served by live EMR facilities, so the 2015–2019 roll-out does not masquerade as rising cancer.{ytd && <> {year} is year-to-date and flagged throughout.</>}</>,
          method: <ul className="flex flex-col gap-1.5">
            <li><b>Dashed</b> = years with under half of facilities on the EMR, or the current year to date. Treat as unreliable.</li>
            <li><b>Bands</b> are 95% confidence intervals; a change inside the band is reported as “within CI”, not as a trend.</li>
            <li><b>Joinpoints</b> mark where the trend changes slope; APC = annual percent change in that segment.</li>
          </ul>,
          notes: "Ministry view shows aggregates only; districts with fewer than 5 cases are suppressed.",
        }}
        right={ytd ? <StatusChip status="warning" size="md" label={`${year} year to date`} /> : undefined} />

      {kq.error ? <ErrorNote error={kq.error} /> : !kpis ? <Skeleton variant="card" h={150} label="Reading the KPI mart" /> : <KpiStrip items={kpis} />}

      <BentoGrid>
        <GridItem span={{ lg: 8 }}>
          <Card title={crude ? "National crude rate trend" : "National ASR trend"} icon={<TrendingUp size={16} />}
                info={{ about: sub, method: trendMethod, notes: trendNotes }}
                actions={!crude && aapc && aapc.value !== null ? (
                  <StatusChip status="info" size="md" title={`AAPC, last 10 years: ${signed(aapc.value, 1, "%")} (95% CI ${fmt(aapc.lci)} to ${fmt(aapc.uci)})`}
                              label={<span className="tabular">AAPC 10 y <b>{signed(aapc.value, 1, "%")}</b></span>} />) : undefined}
                detail={{ tabs: chartDetailTabs({ chart: trendChart(420), table: trendTable, method: trendMethod, notes: trendNotes }), defaultTab: "table", subtitle: sub }}
                detailLabel="View as table">
            {(jp.isLoading || rq.isLoading) ? <Loading h={420} /> : (rq.error && !jp.data) ? <ErrorNote error={rq.error} /> : trendChart(420)}
          </Card>
        </GridItem>
        <GridItem span={{ lg: 4 }}>
          <Card title="Where it concentrates" icon={<MapIcon size={16} />}
                info={{ about: "3-year pooled ASR per 100,000. Click the map or a district to explore it.", method: "District ASR pooled over the latest 3 complete years to stabilise small numbers. Extrusion height and colour both encode the ASR. Click a district to open it in the Geo Explorer.", notes: "× = ratio to the national rate · HH = High–High LISA cluster. Hover a row for its 95% CI." }}
                actions={<Button isIconOnly size="sm" radius="full" variant="flat" aria-label="Open Geo Explorer" onPress={() => nav("/geo")}
                                 className="min-w-8 w-8 h-8 bg-surface-2 border border-border text-fg-muted data-[hover=true]:text-fg"><ArrowUpRight size={16} /></Button>}>
            <MiniMap yearTo={f.yearTo} />
          </Card>
        </GridItem>

        <GridItem span={{ lg: 8 }}>
          <Card title="Why raw counts mislead" icon={<Scale size={16} />}
                info={{ about: `Cases vs age-standardised rate, indexed to the first full-coverage year = 100 · ${SEX[f.sex]}, ${BAND[f.ageBand]}.`,
                        method: "Both series are divided by their value in the first year with full EMR coverage (= 100), so they share one axis. Raw counts climb as facilities go live; the person-time-based ASR stays near its baseline (INS-7)." }}
                detail={{ tabs: chartDetailTabs({ chart: <CountsVsAsr rows={ratesInRange} height={360} />, table: <DataTable rows={ratesInRange} columns={[{ key: "y", label: "Year" }, { key: "cases", label: "Cases", num: true, fmt: (v) => int(v) },
                  { key: "asr", label: "ASR", num: true, fmt: (v) => fmt(v) }, { key: "coverage_flag", label: "Flag", fmt: (v, r) => (r.partial_year ? "year to date" : v ? "low EMR coverage" : "") }]} /> }), defaultTab: "table" }}
                detailLabel="View as table">
            {rq.isLoading ? <Loading h={250} /> : rq.error ? <ErrorNote error={rq.error} /> : <CountsVsAsr rows={ratesInRange} height={250} />}
          </Card>
        </GridItem>
        <GridItem span={{ lg: 4 }} className="gap-4">
          <PairCard title="Counts vs rate" className="!flex-none"
            info={pair ? `From ${pair.from} to ${pair.to}${pair.partial ? " (year to date, annualised)" : ""}, recorded cases multiplied by ${fmt(pair.cases, 1)} while the age-standardised rate moved ×${fmt(pair.asr, 2)}: the extra cases are facilities joining the EMR, not more cancer.` : undefined}
            left={{ label: "Cases", value: pair ? `×${fmt(pair.cases, 1)}` : "—", unit: pair ? `${pair.from}→${String(pair.to).slice(2)}` : undefined, marker: SERIES[mode][2] }}
            right={{ label: "ASR", value: pair ? `×${fmt(pair.asr, 2)}` : "—", marker: SERIES[mode][0] }} />
          <MetricCard label={crude ? "Latest trend segment" : `Trend since ${lastSeg?.start_year ?? "—"}`} icon={<GitCommitHorizontal size={15} />} className="flex-1"
            value={!crude && lastSeg ? signed(lastSeg.apc, 1, "%") : "—"} unit="per year"
            status={!crude && lastSeg ? (!lastSeg.significant ? { status: "neutral", label: "Not significant" } : lastSeg.apc > 0 ? { status: "serious", label: "Rising" } : { status: "good", label: "Falling" }) : null}
            aside={!crude && jp.data ? `${jp.data.n_joinpoints ?? 0} joinpoint${jp.data.n_joinpoints === 1 ? "" : "s"}` : undefined}
            range={!crude && lastSeg ? { value: lastSeg.apc, min: -10, max: 10, thresholds: [0], label: "Annual percent change, −10% to +10%",
              markers: [{ value: lastSeg.apc_lci, label: "95% CI lower" }, { value: lastSeg.apc_uci, label: "95% CI upper" }], minLabel: "−10%", maxLabel: "+10%" } : undefined}
            info={{ about: !crude && lastSeg ? `Annual percent change ${lastSeg.start_year}–${lastSeg.end_year}, 95% CI ${fmt(lastSeg.apc_lci)} to ${fmt(lastSeg.apc_uci)}.` : "Joinpoint is fitted on age-standardised rates only.", method: trendMethod }}
            detail={!crude && jp.data ? { title: "Joinpoint segments", children: <SegmentList segments={jp.data.segments} aapc={jp.data.aapc_last10} />, size: "xl" } : undefined} />
        </GridItem>
      </BentoGrid>
    </div>
  );
}
