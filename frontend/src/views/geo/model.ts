import type { MapRow } from "@/api/types";
import { DIVERGING, hexToRgb, mode, SEQ_DARK, SEQ_LIGHT } from "@/lib/viz";
import { fmt } from "@/lib/format";

export type MetricKey = "asr" | "crude_rate" | "sir" | "lisa_quadrant" | "hp_test_rate" | "pct_stage4";
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export type MetricDef = {
  key: MetricKey; short: string; label: string; unit: string;
  /** "heat" = signal sequential #F3F4F7 -> #F8C9B5 -> #F05A28 -> #B83A12 (high = bad), "blue" = coverage sequential (high = good), "div" = diverging around 1, "cat" = LISA classes */
  ramp: "heat" | "blue" | "div" | "cat";
  /** Does the value change with the time slider? (SIR/LISA are 2019–2025 pooled; HP testing/stage IV are all-years facility marts) */
  periodic: boolean; staticNote?: string;
  /** Column that drives extrusion height (LISA is categorical, so height carries ASR). */
  height: keyof MapRow;
  format: (v: number | null | undefined) => string;
  method: string;
};

export const METRICS: Record<MetricKey, MetricDef> = {
  asr: {
    key: "asr", short: "ASR", label: "Age-standardised rate", unit: "per 100,000 person-years", ramp: "heat", periodic: true, height: "asr",
    format: (v) => fmt(v, 1),
    method: "Direct standardisation to the WHO World Standard Population (18 age groups); 95% CI by the Fay–Feuer gamma method. Maps use 3-year pooled rates by default to reduce small-number noise.",
  },
  crude_rate: {
    key: "crude_rate", short: "Crude", label: "Crude rate", unit: "per 100,000 person-years", ramp: "heat", periodic: true, height: "crude_rate",
    format: (v) => fmt(v, 1),
    method: "Cases ÷ person-years of the live-facility catchment population. Not age-adjusted: districts with older populations look worse than they are.",
  },
  sir: {
    key: "sir", short: "SIR", label: "Standardised incidence ratio", unit: "observed ÷ expected", ramp: "div", periodic: false, height: "sir",
    staticNote: "SIR is a 2019–2025 pooled estimate", format: (v) => fmt(v, 2),
    method: "Observed cases ÷ expected cases, where expected = national age–sex-specific rates × district population (2019–2025 pooled). 1.0 = national level; exact Poisson CI.",
  },
  lisa_quadrant: {
    key: "lisa_quadrant", short: "LISA", label: "Local Moran's I cluster", unit: "cluster type", ramp: "cat", periodic: false, height: "asr",
    staticNote: "LISA clusters use 2019–2025 pooled, EB-smoothed rates", format: (v) => (v === null || v === undefined ? "—" : String(v)),
    method: "Local Moran's I on empirical-Bayes smoothed 2019–2025 rates, queen contiguity, 999 permutations, p < 0.05. HH = high-rate district among high-rate neighbours (hotspot). Height still shows ASR.",
  },
  hp_test_rate: {
    key: "hp_test_rate", short: "HP testing", label: "H. pylori testing rate", unit: "% of dyspepsia patients tested", ramp: "blue", periodic: false, height: "hp_test_rate",
    staticNote: "Testing rate covers all years", format: (v) => (v === null || v === undefined ? "—" : `${fmt(v, 1)}%`),
    method: "Share of patients with dyspepsia at the district's facilities who had an H. pylori test (all years). Higher is better, so this metric uses a blue coverage ramp.",
  },
  pct_stage4: {
    key: "pct_stage4", short: "% stage IV", label: "Stage IV at diagnosis", unit: "% of staged cases", ramp: "heat", periodic: false, height: "pct_stage4",
    staticNote: "Stage mix covers all years", format: (v) => (v === null || v === undefined ? "—" : `${fmt(v, 1)}%`),
    method: "Stage IV ÷ cases with a known stage, all years pooled. Late stage at diagnosis signals missed or delayed diagnosis.",
  },
};
export const METRIC_ORDER: MetricKey[] = ["asr", "crude_rate", "sir", "lisa_quadrant", "hp_test_rate", "pct_stage4"];

/** Single-hue sky blue for coverage metrics (higher = better), dim -> bright on dark, light -> dark on light.
 * Design v3: anchored to the data hue sky (#5AB4E5 / #6CC0EC); single hue, monotone lightness. */
const BLUE_DARK = ["#1A2129", "#1C3240", "#22475C", "#2B6280", "#3C84AE", "#5AB4E5", "#9AD3F2"];
const BLUE_LIGHT = ["#F3F4F7", "#D9EEF9", "#B3DCF3", "#84C6EB", "#5AB4E5", "#3593CC", "#1F6FA3"];

function interp(ramp: string[], t: number): RGB {
  const r = ramp.map(hexToRgb);
  const x = Math.max(0, Math.min(1, t)) * (r.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = r[i], b = r[Math.min(i + 1, r.length - 1)];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as RGB;
}
const mix = (a: RGB, b: RGB, f: number): RGB => [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as RGB;

export function rampColors(kind: MetricDef["ramp"]): string[] {
  const dark = mode() === "dark";
  if (kind === "blue") return dark ? BLUE_DARK : BLUE_LIGHT;
  if (kind === "div") {
    const n = hexToRgb(DIVERGING.neg), m = hexToRgb(DIVERGING.mid), p = hexToRgb(DIVERGING.pos);
    const toHex = (c: RGB) => `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    return [n, mix(n, m, 0.5), m, mix(m, p, 0.5), p].map(toHex);
  }
  return dark ? SEQ_DARK : SEQ_LIGHT;
}
export function rampRgb(kind: MetricDef["ramp"], t: number): RGB { return interp(rampColors(kind), t); }

/** LISA classes: diverging poles for HH/LL (hot/cold), muted tints for the outliers, neutral land for not significant. */
export const LISA_ORDER = ["HH", "HL", "LH", "LL", "NS"] as const;
export const LISA_LABEL: Record<string, string> = { HH: "High–High hotspot", HL: "High among low", LH: "Low among high", LL: "Low–Low coldspot", NS: "Not significant" };
export function lisaRgb(q: string | null | undefined): RGB {
  const p = hexToRgb(DIVERGING.pos), n = hexToRgb(DIVERGING.neg), land = theme().land;
  if (q === "HH") return p;
  if (q === "LL") return n;
  if (q === "HL") return mix(p, land, 0.55);
  if (q === "LH") return mix(n, land, 0.55);
  return land;
}

/** Scene chrome that follows the theme (text stays in ink tokens; the map surface is part of the console). */
export function theme() {
  return mode() === "dark"
    ? { land: [44, 48, 58] as RGB, landBase: [29, 33, 40] as RGB, edge: [242, 243, 245, 40] as RGBA, outline: [242, 243, 245, 150] as RGBA,
        halo: [255, 109, 58, 60] as RGBA, grid: [242, 243, 245, 16] as RGBA, label: [242, 243, 245, 255] as RGBA, labelBg: [22, 25, 31, 230] as RGBA,
        muted: [139, 144, 158, 255] as RGBA, suppressed: [58, 62, 72] as RGB, focus: [242, 243, 245, 255] as RGBA, ring: [14, 16, 20, 255] as RGBA }
    : { land: [226, 228, 234] as RGB, landBase: [236, 237, 242] as RGB, edge: [21, 23, 28, 40] as RGBA, outline: [21, 23, 28, 140] as RGBA,
        halo: [240, 90, 40, 45] as RGBA, grid: [21, 23, 28, 16] as RGBA, label: [21, 23, 28, 255] as RGBA, labelBg: [255, 255, 255, 235] as RGBA,
        muted: [107, 112, 128, 255] as RGBA, suppressed: [214, 216, 223] as RGB, focus: [21, 23, 28, 255] as RGBA, ring: [255, 255, 255, 255] as RGBA };
}

export const isLowCoverage = (r: Pick<MapRow, "coverage_flag">) => !!r.coverage_flag;
export const numeric = (r: MapRow, k: keyof MapRow): number | null => {
  const v = r[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Colour/height domain fixed across every period of the slider so the animation compares like with like.
 * Low-coverage and suppressed cells are excluded, and the top is clamped at the 97th percentile (outliers saturate). */
export function domainFor(metric: MetricDef, all: MapRow[]): { lo: number; hi: number; hMax: number } {
  const key = metric.key === "lisa_quadrant" ? "asr" : metric.key;
  const vals = all.filter((r) => !r.suppressed && !isLowCoverage(r)).map((r) => numeric(r, key as keyof MapRow)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!vals.length) return { lo: 0, hi: 1, hMax: 1 };
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  const hi = q(0.97), lo = q(0.02);
  if (metric.ramp === "div") { const s = Math.max(hi, 1 / Math.max(lo, 0.05), 1.2); return { lo: 1 / s, hi: s, hMax: s }; }
  return { lo, hi: hi > lo ? hi : lo + 1, hMax: hi || 1 };
}

/** Position on the colour ramp; SIR uses a log scale centred on 1.0. */
export function tFor(metric: MetricDef, v: number, d: { lo: number; hi: number }): number {
  if (metric.ramp === "div") return 0.5 + 0.5 * Math.max(-1, Math.min(1, Math.log(v) / Math.log(d.hi)));
  return (v - d.lo) / (d.hi - d.lo || 1);
}

/** Rank 1 = highest value of the active metric (LISA ranks by ASR). */
export function rankBy(rows: MapRow[], key: keyof MapRow): Map<string, number> {
  const sorted = rows.filter((r) => numeric(r, key) !== null && !r.suppressed).sort((a, b) => (numeric(b, key) ?? 0) - (numeric(a, key) ?? 0));
  return new Map(sorted.map((r, i) => [r.geo_code, i + 1]));
}

/** INS-1b check: the district whose rank climbs most when switching from age-standardised to crude rates
 * (an old population, not a high risk). Also reports its crude/ASR ratio against the median district. */
export function ageStructureDecoy(rows: MapRow[]) {
  const ok = rows.filter((r) => !r.suppressed && numeric(r, "asr") && numeric(r, "crude_rate"));
  if (ok.length < 5) return null;
  const ra = rankBy(ok, "asr"), rc = rankBy(ok, "crude_rate");
  const ratio = (r: MapRow) => (r.crude_rate as number) / (r.asr as number);
  const ratios = ok.map(ratio).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const best = ok.map((r) => ({ r, jump: (ra.get(r.geo_code) ?? 0) - (rc.get(r.geo_code) ?? 0), ratio: ratio(r) }))
    .sort((a, b) => b.ratio - a.ratio || b.jump - a.jump)[0];
  return { code: best.r.geo_code, name: best.r.name, asrRank: ra.get(best.r.geo_code)!, crudeRank: rc.get(best.r.geo_code)!, ratio: best.ratio, median,
           asr: best.r.asr as number, crude: best.r.crude_rate as number, n: ok.length };
}

export const rgbCss = (c: RGB | RGBA, a?: number) => `rgba(${c[0]},${c[1]},${c[2]},${a ?? (c.length === 4 ? (c as RGBA)[3] / 255 : 1)})`;
export const cleanName = (s: string | null | undefined) => (s ?? "").replace(" (Synthetic)", "");
export const TIER_ORDER = ["low", "medium", "high"] as const;
/** HP testing tier = ordered classes -> ordinal blue steps (not categorical hues). */
export function tierRgb(tier: string | null | undefined): RGB {
  const r = rampColors("blue"), idx = mode() === "dark" ? [3, 5, 6] : [2, 4, 6];
  const i = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);
  if (i >= 0) return hexToRgb(r[idx[i]]);
  return theme().muted.slice(0, 3) as RGB;
}
