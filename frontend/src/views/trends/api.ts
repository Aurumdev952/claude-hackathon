import { useQueries, useQuery } from "@tanstack/react-query";
import { get, qs } from "@/api/client";
import type { Joinpoint, RateRow } from "@/api/types";
import { useFiltersMeta } from "@/api/hooks";
import { create } from "zustand";

export type Level = "NATIONAL" | "PROVINCE" | "DISTRICT";
export type Sex = "ALL" | "M" | "F";
export type Band = "ALL" | "<50" | "50-64" | "65+";
export type SeriesSpec = { level: Level; geo: string; sex: Sex; age: Band; slot: number };
export type EventRow = { date: string; event_type: "EMR_GO_LIVE" | "ENDOSCOPY_OPENED" | string; label: string; geo_code: string; province_code: string | null };
export type SurfaceRow = { year: number; age_index: number; age_group: string; cases: number; population: number; rate: number; rate_smoothed: number };

export const specKey = (s: Pick<SeriesSpec, "level" | "geo" | "sex" | "age">) => `${s.level === "NATIONAL" ? "NATIONAL" : s.geo}|${s.sex}|${s.age}`;
export const jpId = (s: Pick<SeriesSpec, "level" | "geo" | "sex" | "age">, caseDef: string) => `${specKey(s)}|${caseDef}`;

export const MAX_SERIES = 6;
const DEFAULT: SeriesSpec[] = [
  { level: "NATIONAL", geo: "RW", sex: "ALL", age: "<50", slot: 0 },
  { level: "NATIONAL", geo: "RW", sex: "ALL", age: "50-64", slot: 1 },
  { level: "NATIONAL", geo: "RW", sex: "ALL", age: "65+", slot: 2 },
  { level: "NATIONAL", geo: "RW", sex: "ALL", age: "ALL", slot: 3 },
];

/** Selected comparison series. Each series keeps the colour slot it was given when added (colour follows the entity). */
type SS = { series: SeriesSpec[]; focus: string; logScale: boolean;
  add: (s: Omit<SeriesSpec, "slot">) => void; remove: (key: string) => void; setFocus: (k: string) => void; setLog: (v: boolean) => void };
export const useSeries = create<SS>((set) => ({
  series: DEFAULT, focus: specKey(DEFAULT[0]), logScale: true,
  add: (s) => set((st) => {
    if (st.series.length >= MAX_SERIES || st.series.some((x) => specKey(x) === specKey(s))) return st;
    const used = new Set(st.series.map((x) => x.slot));
    const slot = [0, 1, 2, 3, 4, 5].find((i) => !used.has(i)) ?? 0;
    return { series: [...st.series, { ...s, slot }], focus: specKey(s) };
  }),
  remove: (key) => set((st) => {
    const series = st.series.filter((x) => specKey(x) !== key);
    return { series, focus: st.focus === key ? (series[0] ? specKey(series[0]) : "") : st.focus };
  }),
  setFocus: (focus) => set({ focus }),
  setLog: (logScale) => set({ logScale }),
}));

export function useRateSeries(specs: SeriesSpec[], caseDef: string) {
  return useQueries({
    queries: specs.map((s) => ({
      queryKey: ["rates", "trend", s.level, s.geo, s.sex, s.age, caseDef],
      queryFn: () => get<RateRow[]>(`/rates${qs({ level: s.level, geo_code: s.level === "NATIONAL" ? undefined : s.geo, sex: s.sex, age_band: s.age, case_def: caseDef })}`),
      staleTime: 60_000,
    })),
  });
}

export function useNationalRates(sex: string, age: string, caseDef: string) {
  return useQuery({
    queryKey: ["rates", "trend", "NATIONAL", "RW", sex, age, caseDef],
    queryFn: () => get<RateRow[]>(`/rates${qs({ level: "NATIONAL", sex, age_band: age, case_def: caseDef })}`),
    staleTime: 60_000,
  });
}

export function useJp(id: string | null) {
  return useQuery({
    queryKey: ["trends", "jp", id],
    queryFn: () => get<Joinpoint>(`/trends/joinpoint${qs({ series_id: id! })}`),
    enabled: !!id, retry: false, staleTime: 60_000,
  });
}

export function useJpList() {
  return useQuery({ queryKey: ["trends", "series"], queryFn: () => get<{ series_id: string }[]>("/trends/series"), staleTime: 300_000 });
}

export function useSurface(caseDef: string) {
  return useQuery({ queryKey: ["trends", "surface", caseDef], queryFn: () => get<SurfaceRow[]>(`/trends/surface${qs({ case_def: caseDef })}`), staleTime: 60_000 });
}

export function useEvents() {
  return useQuery({ queryKey: ["trends", "events"], queryFn: () => get<EventRow[]>("/events"), staleTime: 300_000 });
}

/** Geo code -> display name (districts + provinces) from /meta/filters. */
export function useGeoNames() {
  const meta = useFiltersMeta();
  const d: { district_code: string; name: string; province_code: string; province: string }[] = meta.data?.data?.districts ?? [];
  const names: Record<string, string> = { RW: "Rwanda", NATIONAL: "Rwanda" };
  const provinces: { code: string; name: string }[] = [];
  d.forEach((x) => {
    names[x.district_code] = x.name;
    if (!names[x.province_code]) { names[x.province_code] = x.province; provinces.push({ code: x.province_code, name: x.province }); }
  });
  return { names, districts: d, provinces, ready: !!meta.data };
}

export const AGE_LABEL: Record<Band, string> = { ALL: "all ages", "<50": "under 50", "50-64": "50–64", "65+": "65+" };
export const SEX_LABEL: Record<Sex, string> = { ALL: "", M: "men", F: "women" };

export function seriesLabel(s: Pick<SeriesSpec, "level" | "geo" | "sex" | "age">, names: Record<string, string>, short = false) {
  const geo = s.level === "NATIONAL" ? (short ? "RW" : "National") : names[s.geo] ?? s.geo;
  const parts = [geo, AGE_LABEL[s.age], SEX_LABEL[s.sex]].filter(Boolean);
  if (short && s.level === "NATIONAL") return [AGE_LABEL[s.age], SEX_LABEL[s.sex]].filter(Boolean).join(", ");
  return parts.join(", ");
}
