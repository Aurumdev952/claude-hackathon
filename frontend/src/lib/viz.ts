/** Chart colour system (plan §A1). Categorical palettes were validated with the dataviz skill's validator against the v2
 * surfaces (light #FFFFFF, dark #121A2B): fixed order, 8 slots; all-pairs forms (scatter / map points) use the first three
 * slots only. Status colours carry reserved meaning and are always paired with a glyph + label (never colour alone).
 * Light is the default theme. See docs/decisions.md D-22. */
export type Mode = "dark" | "light";

export const SERIES: Record<Mode, string[]> = {
  light: ["#3F6FE8", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#4C7EF0", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** Status scale: reserved meaning, always paired with an icon + label. Fills / marks. */
export const STATUS = { good: "#22C55E", warning: "#F59E0B", serious: "#F97316", critical: "#EF4444" };
export type StatusKey = keyof typeof STATUS;
/** Status colour for text: darker steps on white, brighter steps on the dark surface. */
export const STATUS_TEXT: Record<Mode, Record<StatusKey, string>> = {
  light: { good: "#15803D", warning: "#B45309", serious: "#C2410C", critical: "#B91C1C" },
  dark: { good: "#34D399", warning: "#FBBF24", serious: "#FB923C", critical: "#F87171" },
};
export const statusText = (s: StatusKey) => STATUS_TEXT[mode()][s];
export const BAND_STATUS: Record<string, StatusKey> = { LOW: "good", MEDIUM: "warning", HIGH: "critical" };

/** Map a 0..1 position (higher = worse unless `higherIsBetter`) to a status step. `cuts` are the upper bounds of good / warning / serious. */
export function scoreStatus(t: number | null | undefined, opts: { higherIsBetter?: boolean; cuts?: [number, number, number] } = {}): StatusKey {
  if (t === null || t === undefined || !Number.isFinite(t)) return "warning";
  const x = opts.higherIsBetter ? 1 - t : t;
  const [a, b, c] = opts.cuts ?? [0.33, 0.6, 0.8];
  return x < a ? "good" : x < b ? "warning" : x < c ? "serious" : "critical";
}

/** Range-bar gradient (good → warning → critical), as in the reference "Key areas of concern" cards. */
export const RANGE_STOPS = ["#22C55E", "#84CC16", "#F59E0B", "#F97316", "#EF4444"];
export const RANGE_GRADIENT = `linear-gradient(90deg, ${RANGE_STOPS.map((c, i) => `${c} ${Math.round((i / (RANGE_STOPS.length - 1)) * 100)}%`).join(", ")})`;
/** Build a CSS gradient from stops (optionally reversed, e.g. when higher is better). */
export const rangeGradient = (stops: string[] = RANGE_STOPS, reverse = false) =>
  `linear-gradient(90deg, ${(reverse ? [...stops].reverse() : stops).join(", ")})`;

/** Sequential (magnitude) ramp: one warm hue (hotspot colour), dim -> bright on dark, light -> dark on light. */
export const SEQ_DARK = ["#3a2d2b", "#5b3328", "#7d3a27", "#a04326", "#c25030", "#df6a48", "#f08d6f"];
export const SEQ_LIGHT = ["#fbe3dc", "#f4c3b4", "#e99b85", "#d9704f", "#c24f2f", "#9c3a20", "#722816"];
/** Diverging (SHAP push down / up, SIR around 1): blue <- grey -> orange. */
export const DIVERGING = { neg: "#3F6FE8", mid: "#94A3B8", pos: "#eb6834" };

export function mode(): Mode {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
export const ink = () => (mode() === "dark"
  ? { primary: "#E6EAF2", secondary: "#B6C2D6", muted: "#94A3B8", grid: "rgba(230,234,242,0.07)", axis: "rgba(230,234,242,0.20)", surface: "#121A2B", border: "#243049" }
  : { primary: "#0F172A", secondary: "#475569", muted: "#64748B", grid: "rgba(15,23,42,0.06)", axis: "rgba(15,23,42,0.18)", surface: "#FFFFFF", border: "#E6EAF2" });

export function seqColor(t: number): string {
  const ramp = mode() === "dark" ? SEQ_DARK : SEQ_LIGHT;
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
  return ramp[i];
}
/** Alias with a clearer name for new code. */
export const sequential = seqColor;

export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c: readonly number[]) => `#${c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
const lerp = (a: readonly number[], b: readonly number[], f: number) => [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];

/** Interpolated sequential colour (for continuous fills such as the 3D map). */
export function seqRgb(t: number): [number, number, number] {
  const ramp = (mode() === "dark" ? SEQ_DARK : SEQ_LIGHT).map(hexToRgb);
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.floor(x), f = x - i;
  return lerp(ramp[i], ramp[Math.min(i + 1, ramp.length - 1)], f);
}
/** Diverging colour for t in [-1, 1] (0 = neutral). */
export function diverging(t: number): string {
  const x = Math.max(-1, Math.min(1, t));
  const mid = hexToRgb(DIVERGING.mid);
  return rgbToHex(x < 0 ? lerp(mid, hexToRgb(DIVERGING.neg), -x) : lerp(mid, hexToRgb(DIVERGING.pos), x));
}
/** CSS rgba() from a hex colour. */
export function alphaHex(hex: string, a: number) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
