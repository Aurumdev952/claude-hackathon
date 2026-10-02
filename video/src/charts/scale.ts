/** Tiny deterministic scale helpers (no d3, so the bundle stays small and the output is identical everywhere). */
export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

/** "Nice" tick values covering [lo, hi] with about `count` steps. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Domain [0, niceMax] for magnitudes. */
export function niceMax(values: (number | null | undefined)[], pad = 1.08): number {
  const m = Math.max(0, ...values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
  const t = niceTicks(0, m * pad || 1, 4);
  return t[t.length - 1] || 1;
}

export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
