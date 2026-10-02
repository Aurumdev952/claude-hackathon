/** Forecast API (docs/contracts/v3-loop.md §7, §7.1, §7.2): types and query hooks for the Outlook, the Overview card and
 * the Trends Lab forecast toggle. Query keys start with "trends" so a WebSocket refresh (changed: ["trends", ...])
 * refetches them after a sim tick or a forecast refit. */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { get, post, qs } from "@/api/client";

export type FcMetric = "cases" | "asr";
export type HistPt = { year: number; period: string; mean: number | null; lo95: number | null; hi95: number | null; cases_label?: string; completeness?: number };
export type FcPt = { year: number; period: string; mean: number; lo80: number; hi80: number; lo95: number; hi95: number };
export type Backtest = { mape: number | null; cov80: number | null; cov95: number | null; crps?: number | null; n: number; note?: string };
export type FcRun = {
  run_id: string; sim_time: string; created_at: string; source: string; source_label: string; case_def: string; first_year: number;
  last_full_year: number; horizon_year: number; n_draws: number; backtest: Backtest; notes: string[];
};
export type FcSeries = { series_id: string; metric: FcMetric; unit: string; history: HistPt[]; forecast: FcPt[]; model: string | null; backtest: Backtest; run: FcRun };
export type Drivers = {
  geo_level: string; geo_code: string; from_year: number; to_year: number; cases_from: number; cases_to: number; total_change: number;
  components: { component: "population" | "ageing" | "risk"; cases: number; pct: number }[]; method: string;
};
export type RfPt = { year: number; period: string; value: number | null; lo95: number | null; hi95: number | null; n?: number | null; label?: string };
export type RiskFactor = { indicator: string; geo_code: string; sex: string; source: string; survey: RfPt[]; fitted: RfPt[]; forecast: RfPt[]; nowcast: RfPt[] };
export type OpsPt = { month: string; mean: number; lo80: number | null; hi80: number | null };
export type CapacityRow = { district_code: string; name: string; demand_12m: number | null; capacity_12m: number | null; high_flags_12m: number | null; gi_visits_12m: number | null; gap_12m: number };
export type Operational = { district: string; as_of: string | null; months: string[]; metrics: Record<string, OpsPt[]>; capacity_by_district: CapacityRow[]; method: string };
export type BacktestRow = { series_id: string; origin_year: number; horizon: number; year: number; actual: number; forecast: number; mape: number; cov80: number; cov95: number; crps: number; model: string };
export type TrackingRow = { series_id: string; period: string; forecast_run_id: string; forecast_mean: number; forecast_lo80: number | null; forecast_hi80: number | null; actual: number | null; abs_pct_error: number | null; in_band80: boolean | null };
export type BacktestAll = {
  summary: { mape: number; cov80: number; cov95: number; crps: number; n: number; origins: number[] };
  by_series: (Backtest & { series_id: string })[]; by_horizon: (Backtest & { horizon: number })[]; rows: BacktestRow[]; tracking: TrackingRow[]; method: string;
};
export type MapRowFc = { district_code: string; name: string; province_code: string; value: number | null; lo95?: number | null; hi95?: number | null; cases?: number; base_cases?: number };
export type ScenarioIn = { hp_coverage_delta: number; smoking_delta: number; salt_delta: number; endoscopy_access: string[]; until: number };
export type ScenarioOut = {
  baseline: { year: number; mean: number; lo95: number; hi95: number }[]; scenario: { year: number; mean: number; lo95: number; hi95: number }[];
  cases_averted: number; cases_averted_range: [number, number];
  stage_shift: { early_pct_baseline: number; early_pct_scenario: number; districts_gaining_access: string[] };
  assumptions: string[]; coefficients: Record<string, { value: number; se: number }>; elapsed_ms: number;
};

const ONE_MIN = 60_000;

export function useForecastSeries(p: { metric?: FcMetric; geo?: string; code?: string | null; sex?: string; age?: string }, enabled = true) {
  const params = { geo: p.geo ?? "NATIONAL", code: p.code ?? undefined, sex: p.sex ?? "ALL", age: p.age ?? "ALL", metric: p.metric ?? "cases" };
  return useQuery({
    queryKey: ["trends", "forecast", "series", params], enabled, staleTime: 5 * ONE_MIN, retry: false,
    queryFn: () => get<FcSeries>(`/forecast/series${qs(params)}`),
  });
}
export const useDrivers = () => useQuery({ queryKey: ["trends", "forecast", "drivers"], queryFn: () => get<Drivers>("/forecast/drivers"), staleTime: 5 * ONE_MIN });
export const useRiskFactors = () => useQuery({ queryKey: ["trends", "forecast", "risk-factors"], queryFn: () => get<RiskFactor[]>("/forecast/risk-factors"), staleTime: 5 * ONE_MIN });
export const useOperational = () => useQuery({ queryKey: ["trends", "forecast", "operational"], queryFn: () => get<Operational>("/forecast/operational"), staleTime: 5 * ONE_MIN });
export const useBacktest = (enabled = true) => useQuery({ queryKey: ["trends", "forecast", "backtest"], queryFn: () => get<BacktestAll>("/forecast/backtest"), staleTime: 5 * ONE_MIN, enabled });
export const useForecastMap = (metric: "asr" | "change", year = 2031) =>
  useQuery({ queryKey: ["trends", "forecast", "map", metric, year], queryFn: () => get<MapRowFc[]>(`/forecast/map${qs({ year, metric })}`), staleTime: 5 * ONE_MIN });
export function useScenario(body: ScenarioIn) {
  return useQuery({
    queryKey: ["trends", "forecast", "scenario", body], queryFn: () => post<ScenarioOut>("/forecast/scenario", body),
    placeholderData: keepPreviousData, staleTime: 5 * ONE_MIN,
  });
}

/** Human labels for the survey indicators and the EMR nowcast proxies. */
export const INDICATORS: Record<string, { label: string; short: string; emr?: boolean }> = {
  hp_seroprev: { label: "H. pylori seroprevalence", short: "H. pylori" },
  smoking_current: { label: "Current smoking", short: "Smoking" },
  high_salt: { label: "High-salt diet", short: "High salt" },
  alcohol_any: { label: "Any alcohol use", short: "Alcohol" },
  smoked_food: { label: "Smoked-food use", short: "Smoked food" },
  hp_pos_tested: { label: "H. pylori positive among tested", short: "H. pylori positive", emr: true },
  anaemia_gi: { label: "Anaemia in the GI cohort", short: "Anaemia", emr: true },
  ppi_use: { label: "Acid-suppressant (PPI) use", short: "PPI use", emr: true },
};
export const SURVEY_ORDER = ["hp_seroprev", "smoking_current", "high_salt", "alcohol_any", "smoked_food"];
export const NOWCAST_ORDER = ["hp_pos_tested", "anaemia_gi", "ppi_use"];

/** The year the simulated "today" falls in, as a fractional year (for the "today" marker). */
export function simYearFrac(sim: string | null | undefined): number | null {
  if (!sim) return null;
  const t = new Date(sim.endsWith("Z") ? sim : `${sim}Z`);
  if (Number.isNaN(t.getTime())) return null;
  const y = t.getUTCFullYear();
  return y + (t.getTime() - Date.UTC(y, 0, 1)) / (365.25 * 864e5);
}
