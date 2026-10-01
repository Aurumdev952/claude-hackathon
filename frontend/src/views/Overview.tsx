import { useMemo } from "react";
import type { RateRow } from "@/api/types";
import { useFiltersMeta, useKpis } from "@/api/hooks";
import { DataTable, ErrorNote, Loading, Panel } from "@/components/ui/Panel";
import { fmt, int, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { nationalSeriesId, useEvents, useJoinpointSafe, useNationalRates } from "./geo/data";
import { AsrTrend, annotationsFor, type Obs } from "./geo/AsrTrend";
import { KpiStrip, type KpiDef, type KpiPoint } from "./overview/KpiStrip";
import { MiniMap } from "./overview/MiniMap";
import { CountsVsAsr } from "./overview/CountsVsAsr";

const SEX = { ALL: "both sexes", M: "men", F: "women" } as const;
const BAND = { ALL: "all ages", "<50": "under 50", "50-64": "50–64", "65+": "65 and over" } as const;

/** V1 National Overview (SPEC §16.3): KPI strip, mini 3D map, honest national trend with joinpoints and annotations. */
export default function Overview() {
  const f = useFilters();
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
      { id: "hp", label: "H. pylori testing rate", value: hp === null ? "—" : fmt(100 * hp, 0), unit: "%", partial, sub: "of dyspepsia patients tested",
        delta: hpD === null ? null : { text: `${signed(hpD, 1)} pts ${vs}`, dir: dir(hpD), tone: tone(hpD, true, 1) },
        spark: spark((sp.hp_testing_rate_dyspepsia ?? []).map((p) => ({ ...p, value: p.value === null ? null : 100 * p.value }))), format: (v) => `${fmt(v, 1)}%`, scope },
      { id: "await", label: "High-risk awaiting endoscopy", value: k.high_risk_awaiting_endoscopy === null ? "—" : int(k.high_risk_awaiting_endoscopy), partial: false,
        missing: k.high_risk_awaiting_endoscopy === null ? "Not published this run" : "HIGH band, not yet scoped", delta: null, spark: [], format: (v) => int(v),
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

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <div className="panel-title">V1 · National overview</div>
          <h1 className="text-xl font-bold leading-tight">Gastric cancer in Rwanda, {year}{kq.data?.data.partial_year && year === lastYear ? " to date" : ""}</h1>
        </div>
        <p className="text-xs text-fog leading-snug max-w-[520px]">
          Rates are per 100,000 person-years of the population served by live EMR facilities, so the 2015–2019 roll-out does not masquerade as rising cancer.
          {kq.data?.data.partial_year && year === lastYear && <> {year} is year-to-date and flagged throughout.</>}
        </p>
      </div>

      {kq.error ? <ErrorNote error={kq.error} /> : !kpis ? <Loading h={150} label="Reading the KPI mart" /> : <KpiStrip items={kpis} />}

      <div className="grid gap-3 grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
        <Panel title={crude ? "National crude rate trend" : "National age-standardised rate trend"} subtitle={sub}
               method={crude
                 ? "Crude rate = cases ÷ live-facility person-years. Not age-adjusted. Dashed years have under 50% of facilities live (EMR roll-out) or are year-to-date."
                 : "Annual ASR (WHO World Standard) with 95% Fay–Feuer CI. Joinpoint: weighted log-linear segmented regression (0–2 joinpoints, BIC selection); APC per segment, * = 95% CI excludes 0. Low-coverage and year-to-date points are dashed and excluded from the fit."}
               table={<DataTable rows={obs} columns={[
                 { key: "year", label: "Year" }, { key: "asr", label: crude ? "Crude" : "ASR", num: true, fmt: (v) => fmt(v) },
                 { key: "lci", label: "95% CI", num: true, fmt: (_, r) => (r.lci === null ? "—" : `${fmt(r.lci)}–${fmt(r.uci)}`) },
                 { key: "cases", label: "Cases", num: true, fmt: (v) => int(v) },
                 { key: "coverage_flag", label: "Flag", fmt: (v, r) => (r.partial_year ? "year to date" : v ? "low EMR coverage" : "") }]} />}
               actions={!crude && aapc && aapc.value !== null ? (
                 <div className="text-right text-[11px] leading-tight mr-1">
                   <div className="text-fog">AAPC, last 10 y</div>
                   <div className="tabular"><b className="text-mist">{signed(aapc.value, 1, "%")}</b> <span className="text-fog">({fmt(aapc.lci)} to {fmt(aapc.uci)})</span></div>
                 </div>) : undefined}>
          {(jp.isLoading || rq.isLoading) ? <Loading h={300} /> : (rq.error && !jp.data) ? <ErrorNote error={rq.error} /> : (
            <>
              <AsrTrend obs={obs} fitted={fit} segments={segs} events={ann.endo} emrSpan={ann.emrSpan} height={376} unit="" name={crude ? "Crude rate" : "Observed ASR"}
                        ariaLabel={`National ${crude ? "crude" : "age-standardised"} rate trend, ${sub}`} />
              <div className="text-[11px] text-fog mt-1 leading-snug">
                {crude ? "Crude rates are not age-adjusted; switch the filter bar to Age-standardised for the joinpoint model." :
                  !jpId || !jp.data ? "No joinpoint model is fitted for this sex × age combination — observed rates only." :
                  jp.data.n_joinpoints ? `${jp.data.n_joinpoints} joinpoint${jp.data.n_joinpoints > 1 ? "s" : ""} detected (diamond). ` : "No joinpoint detected: a single log-linear trend fits best. "}
                {!crude && jp.data && segs?.length ? segs.map((s) => `${s.start_year}–${s.end_year}: APC ${signed(s.apc, 1, "%")} (${fmt(s.apc_lci)} to ${fmt(s.apc_uci)})${s.significant ? "" : ", not significant"}`).join(" · ") : ""}
                {" "}▲ marks endoscopy units opening — local diagnosis rises without more cancer (INS-5).
              </div>
            </>
          )}
        </Panel>
        <Panel title="Where it concentrates" subtitle="3-year pooled ASR · click the map to explore"
               method="District ASR pooled over the latest 3 complete years to stabilise small numbers. Extrusion height and colour both encode the ASR. Click a district to open it in the Geo Explorer.">
          <MiniMap yearTo={f.yearTo} />
        </Panel>
      </div>

      <div className="grid gap-3 grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
        <Panel title="Why raw counts mislead" subtitle={`Cases vs age-standardised rate, indexed to the first full-coverage year = 100 · ${SEX[f.sex]}, ${BAND[f.ageBand]}`}
               method="Both series are divided by their value in the first year with full EMR coverage (= 100), so they share one axis. Raw counts climb as facilities go live; the person-time-based ASR stays near its baseline (INS-7)."
               table={<DataTable rows={ratesInRange} columns={[{ key: "y", label: "Year" }, { key: "cases", label: "Cases", num: true, fmt: (v) => int(v) },
                 { key: "asr", label: "ASR", num: true, fmt: (v) => fmt(v) }, { key: "coverage_flag", label: "Flag", fmt: (v, r) => (r.partial_year ? "year to date" : v ? "low EMR coverage" : "") }]} />}>
          {rq.isLoading ? <Loading h={230} /> : rq.error ? <ErrorNote error={rq.error} /> : <CountsVsAsr rows={ratesInRange} />}
        </Panel>
        <Panel title="Reading this page" subtitle="How the numbers are built">
          <ul className="text-xs text-fog leading-relaxed flex flex-col gap-2">
            <li><b className="text-mist">Dashed</b> = years with under half of facilities on the EMR, or the current year to date. Treat as unreliable.</li>
            <li><b className="text-mist">Bands</b> are 95% confidence intervals; a change inside the band is reported as “within CI”, not as a trend.</li>
            <li><b className="text-mist">Joinpoints</b> mark where the trend changes slope; APC = annual percent change in that segment.</li>
            <li><b className="text-mist">Ministry view</b> shows aggregates only; districts with fewer than 5 cases are suppressed.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
