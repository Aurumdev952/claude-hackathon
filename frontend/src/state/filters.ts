import { create } from "zustand";

/** Persistent filter bar (SPEC §16.2) - mirrored into the URL query string for shareable deep links. */
export type Filters = { yearFrom: number; yearTo: number; sex: "ALL" | "M" | "F"; ageBand: "ALL" | "<50" | "50-64" | "65+";
  caseDef: "CONFIRMED_PROBABLE" | "CONFIRMED"; metric: "asr" | "crude_rate" };
type FS = Filters & { set: (p: Partial<Filters>) => void };

const fromUrl = (): Partial<Filters> => {
  const p = new URLSearchParams(window.location.search);
  const o: Partial<Filters> = {};
  if (p.get("from")) o.yearFrom = Number(p.get("from"));
  if (p.get("to")) o.yearTo = Number(p.get("to"));
  if (p.get("sex")) o.sex = p.get("sex") as Filters["sex"];
  if (p.get("age")) o.ageBand = p.get("age") as Filters["ageBand"];
  if (p.get("def")) o.caseDef = p.get("def") as Filters["caseDef"];
  if (p.get("metric")) o.metric = p.get("metric") as Filters["metric"];
  return o;
};

export const useFilters = create<FS>((set) => ({
  yearFrom: 2015, yearTo: 2026, sex: "ALL", ageBand: "ALL", caseDef: "CONFIRMED_PROBABLE", metric: "asr", ...fromUrl(),
  set: (patch) => set((s) => {
    const next = { ...s, ...patch };
    const p = new URLSearchParams(window.location.search);
    p.set("from", String(next.yearFrom)); p.set("to", String(next.yearTo)); p.set("sex", next.sex);
    p.set("age", next.ageBand); p.set("def", next.caseDef); p.set("metric", next.metric);
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
    return next;
  }),
}));
