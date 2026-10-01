import { useQuery } from "@tanstack/react-query";
import { type Envelope, get, qs } from "./client";
import { useFilters } from "@/state/filters";
import { useRole } from "@/state/role";
import type { Insight, Kpis } from "./types";

/** Query keys start with the WS `changed[]` names (kpis, rates, trends, geo, patients, alerts, warning, quality, models). */
export const useKpis = (year?: number) => useQuery({ queryKey: ["kpis", year], queryFn: () => get<Kpis>(`/kpis${qs({ year })}`) });
export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: () => get<any>("/status"), refetchInterval: 15_000 });
export const useFiltersMeta = () => useQuery({ queryKey: ["meta"], queryFn: () => get<any>("/meta/filters"), staleTime: Infinity });
export const useInsights = (view: string) => {
  const role = useRole((s) => s.role);
  return useQuery({ queryKey: ["kpis", "insights", view, role], queryFn: () => get<Insight[]>(`/insights?view=${view}`) });
};
/** Insight cards are shown only when a real LLM provider is configured; template-mode cards stay hidden until then. */
export const aiInsightCards = (env: Envelope<Insight[]> | undefined): Insight[] | null =>
  env && env.provider !== "template" ? env.data : null;
export function useJoinpoint(seriesId: string) {
  return useQuery({ queryKey: ["trends", "jp", seriesId], queryFn: () => get<any>(`/trends/joinpoint${qs({ series_id: seriesId })}`) });
}
export function seriesId(geo = "NATIONAL") {
  const f = useFilters.getState();
  return `${geo}|${f.sex}|${f.ageBand}|${f.caseDef}`;
}
export const useGeo = () => useQuery({ queryKey: ["geojson"], queryFn: () => fetch("/geo/districts.geojson").then((r) => r.json()), staleTime: Infinity });
export const useProvGeo = () => useQuery({ queryKey: ["geojson-prov"], queryFn: () => fetch("/geo/provinces.geojson").then((r) => r.json()), staleTime: Infinity });
