import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, qs } from "@/api/client";
import { useFiltersMeta } from "@/api/hooks";
import type { Joinpoint, MapRow } from "@/api/types";
import { useFilters } from "@/state/filters";

/** Data access for the Geo Explorer and the Overview mini map. Query keys start with the WS `changed[]` names. */

export type PeriodMode = "POOLED3" | "YEAR";
export type Period = { id: string; end: number; start: number; type: PeriodMode; partial: boolean };

export type SpatialRow = {
  district_code: string; period: string; asr: number | null; crude_rate: number | null; cases: number | null;
  eb_smoothed_rate: number | null; expected: number | null; sir: number | null; sir_lci: number | null; sir_uci: number | null;
  lisa_quadrant: string | null; lisa_quadrant_fdr: string | null; lisa_p: number | null; lisa_q_fdr: number | null; gi_star_z: number | null;
};
export type Facility = {
  location_id: number; name: string; district_code: string; province_code: string; facility_type: string; tier: string | null;
  derived_tier: string | null; lat: number; lon: number; n_dyspepsia: number; n_hp_tested: number; hp_test_rate: number | null;
  n_cases: number; pct_stage4: number | null; median_diag_interval: number | null; outlier_flag: string | null;
};
export type EventRow = { date: string; event_type: string; label: string; geo_code: string; province_code: string; location_id: number | null };
export type StageRow = { year: string; stage_group: string; n: number; pct: number; pct_known: number | null };

/** The latest complete year the marts publish (current sim year is partial). */
export function usePeriods(mode: PeriodMode): Period[] {
  const meta = useFiltersMeta();
  return useMemo(() => {
    const m = meta.data?.data;
    const years: number[] = m?.years ?? [];
    const latest = years.length ? years[years.length - 1] : 2026;
    if (mode === "YEAR") return years.map((y) => ({ id: String(y), start: y, end: y, type: mode, partial: y === latest }));
    return ((m?.pooled_periods ?? []) as string[])
      .map((p) => { const [a, b] = p.split("-").map(Number); return { id: p, start: a, end: b, type: mode, partial: false }; })
      .filter((p) => p.end - p.start === 2)
      .sort((a, b) => a.end - b.end);
  }, [meta.data, mode]);
}

const mapKey = (p: Period, f: { sex: string; ageBand: string; caseDef: string }) => ["rates", "map", p.id, p.type, f.sex, f.ageBand, f.caseDef];
const mapFn = (p: Period, f: { sex: string; ageBand: string; caseDef: string }) => () =>
  get<MapRow[]>(`/rates/map${qs({ level: "DISTRICT", period: p.id, period_type: p.type, metric: "asr", sex: f.sex, age_band: f.ageBand, case_def: f.caseDef })}`);

/** One /rates/map call per period of the slider, so play/scrub is instant and colour domains are fixed across years. */
export function useMapSeries(periods: Period[]) {
  const sex = useFilters((s) => s.sex), ageBand = useFilters((s) => s.ageBand), caseDef = useFilters((s) => s.caseDef);
  const f = { sex, ageBand, caseDef };
  const qs_ = useQueries({ queries: periods.map((p) => ({ queryKey: mapKey(p, f), queryFn: mapFn(p, f) })) });
  const byPeriod = useMemo(() => {
    const out: Record<string, MapRow[]> = {};
    qs_.forEach((q, i) => { if (q.data) out[periods[i].id] = q.data.data; });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs_.map((q) => q.dataUpdatedAt).join(","), periods]);
  const national: Record<string, number | null> = {};
  qs_.forEach((q, i) => { const l = (q.data as any)?.legend; if (l) national[periods[i].id] = l.national ?? null; });
  return { byPeriod, national, isLoading: qs_.some((q) => q.isLoading), error: qs_.find((q) => q.error)?.error ?? null };
}

export const useSpatial = () => useQuery({ queryKey: ["geo", "spatial"], queryFn: () => get<{ districts: SpatialRow[]; global: { morans_i: number | null; p: number | null; period: string | null } }>("/spatial"), staleTime: 5 * 60_000 });
export const useFacilities = () => useQuery({ queryKey: ["quality", "facilities"], queryFn: () => get<Facility[]>("/facilities/quality"), staleTime: 5 * 60_000 });
export const useEvents = () => useQuery({ queryKey: ["trends", "events"], queryFn: () => get<EventRow[]>("/events"), staleTime: 10 * 60_000 });
export const useCasePoints = (enabled: boolean) => useQuery({
  queryKey: ["geo", "points", "cases"], enabled, staleTime: 5 * 60_000,
  queryFn: () => get<{ lat: number; lon: number; year: number; age_band: string; sex: string; stage_group: string }[]>("/points/cases"),
});
export const useStageMix = (geo: string | null) => useQuery({
  queryKey: ["rates", "stage", geo], enabled: !!geo, staleTime: 5 * 60_000,
  queryFn: () => get<StageRow[]>(`/stage-mix${qs(geo === "RW" ? { level: "NATIONAL", geo_code: "RW" } : { level: "DISTRICT", geo_code: geo })}`),
});
export const useNationalRates = () => {
  const sex = useFilters((s) => s.sex), ageBand = useFilters((s) => s.ageBand), caseDef = useFilters((s) => s.caseDef);
  return useQuery({
    queryKey: ["rates", "national", sex, ageBand, caseDef],
    queryFn: () => get<import("@/api/types").RateRow[]>(`/rates${qs({ level: "NATIONAL", sex, age_band: ageBand, case_def: caseDef })}`),
  });
};

/** Joinpoint for a series; 404 (combination not modelled) resolves to null instead of an error. */
export function useJoinpointSafe(seriesId: string | null) {
  return useQuery({
    queryKey: ["trends", "jp", seriesId], enabled: !!seriesId, staleTime: 5 * 60_000, retry: false,
    queryFn: async () => {
      try { return (await get<Joinpoint>(`/trends/joinpoint${qs({ series_id: seriesId! })}`)).data; }
      catch (e: any) { if (e?.status === 404) return null; throw e; }
    },
  });
}

/** Joinpoint series the pipeline computes (SPEC §12.3): national all/M/F/age bands; provinces and districts all-ages only. */
export function nationalSeriesId(sex: string, band: string, caseDef: string): string | null {
  if (sex !== "ALL" && band !== "ALL") return null;
  return `NATIONAL|${sex}|${band}|${caseDef}`;
}
export const districtSeriesId = (code: string) => `${code}|ALL|ALL|CONFIRMED_PROBABLE`;
