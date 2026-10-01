import { http, HttpResponse } from "msw";

/** MSW handlers from the SPEC §14.3 examples, so the UI runs without the API (VITE_USE_MOCKS=true, SPEC §16.6). */
const meta = { run_id: 812, sim_time: "2026-07-14T00:00:00", published_at: "2026-10-01T10:05:12Z" };
const years = Array.from({ length: 11 }, (_, i) => 2015 + i);

export const handlers = [
  http.get("/api/v1/kpis", () => HttpResponse.json({ meta, data: {
    year: 2025, cases: 402, cases_annualised: 402, cases_delta_pct: 7.8, national_asr: 12.4, national_asr_ci: [11.2, 13.7], asr_delta: 0.6,
    pct_stage_iv: 51.0, median_diag_interval_days: 262, hp_testing_rate_dyspepsia: 0.14, high_risk_awaiting_endoscopy: 1037,
    young_onset_share: 0.21, partial_year: false, years,
    sparklines: Object.fromEntries(["cases_annualised", "national_asr", "pct_stage_iv", "median_diag_interval_days", "hp_testing_rate_dyspepsia", "young_onset_share"]
      .map((k, j) => [k, years.map((y, i) => ({ year: y, value: 10 + i * (j + 1) * 0.3 }))])) } })),
  http.get("/api/v1/rates/map", () => HttpResponse.json({ meta, data: [
    { geo_code: "NOR-MUS", name: "Musanze", cases: 118, population: 1432000, crude_rate: 8.2, asr: 31.5, asr_lci: 25.9, asr_uci: 37.8,
      suppressed: false, lisa_quadrant: "HH", sir: 2.61, rank: 1 }],
    legend: { metric: "asr", unit: "per 100,000", min: 3.1, max: 34.9, national: 12.4 } })),
  http.get("/api/v1/trends/joinpoint", () => HttpResponse.json({ meta, data: {
    series_id: "NATIONAL|ALL|<50|CONFIRMED_PROBABLE",
    observed: years.map((y, i) => ({ year: y, asr: 2.1 * Math.pow(i < 4 ? 1.008 : 1.081, i), lci: 1.4, uci: 3.0, cases: 20 + i })),
    fitted: years.map((y, i) => ({ year: y, asr: 2.0 * Math.pow(i < 4 ? 1.008 : 1.081, i) })),
    segments: [{ segment_no: 1, start_year: 2015, end_year: 2019, apc: 0.8, apc_lci: -2.1, apc_uci: 3.8, significant: false },
               { segment_no: 2, start_year: 2019, end_year: 2025, apc: 8.1, apc_lci: 5.2, apc_uci: 11.1, significant: true }],
    aapc_last10: { value: 4.9, lci: 3.1, uci: 6.8 }, n_joinpoints: 1,
    events: [{ date: "2021-07-01", label: "Endoscopy opened: Rusizi DH", geo_code: "WES-RUS" }] } })),
  http.get("/api/v1/patients", () => HttpResponse.json({ meta, data: [
    { patient_id: 884213, display_id: "MUS-0018842K", name: "Uwimana Claudine", sex: "F", age: 57, district_code: "NOR-MUS", is_case: false,
      case_status: null, dx_date: null, risk_band: "HIGH", ensemble_prob: 0.083, t1_score: 11, rank_in_facility: 1,
      top_reasons: [{ feature: "hb_drop_12m", label: "Haemoglobin fell 2.3 g/dL in 12 months", contribution: 0.29 },
                    { feature: "n_gi_visits_12m", label: "5 visits with stomach complaints in 12 months", contribution: 0.21 }],
      open_alerts: 1, last_visit: "2026-07-09" }], page: 1, page_size: 25, total: 64 })),
  http.get("/api/v1/insights", () => HttpResponse.json({ meta, data: [
    { id: "trend-young-onset", title: "Young-onset cases rising fast", severity: "warning", generated_by: "llm", evidence: [],
      body: "Among people under 50, the age-adjusted rate has risen about 8% per year since 2019 (95% CI 5–11%), while rates in older adults are nearly flat." }] })),
  http.post("/api/v1/ask", () => HttpResponse.json({ meta, data: {
    answer: "In 2024, the highest under-50 rates were in Musanze (9.8 per 100,000), Nyabihu (8.9), Rutsiro (8.1), Rubavu (5.2) and Gakenke (4.7).",
    sql: "SELECT geo_code, asr FROM mart_rates WHERE level='DISTRICT' AND period='2024' AND age_band='<50' ORDER BY asr DESC LIMIT 5",
    columns: ["geo_code", "asr"], rows: [["NOR-MUS", 9.8], ["WES-NYB", 8.9]], chart: { type: "bar", x: "geo_code", y: "asr", title: "Under-50 ASR, 2024" },
    caveats: ["Small numbers: some districts have fewer than 20 cases."], validated_numbers: true, latency_ms: 2140 } })),
  http.get("/api/v1/status", () => HttpResponse.json({ meta, data: { pipeline: { run_id: 812, status: "OK" }, simulator: null, dq: [] } })),
];
