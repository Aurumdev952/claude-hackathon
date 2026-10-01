/** Chart colour system (design v3, "Granger polish"). One data hue (sky) and one attention hue (signal), ink and grey
 * for context. Validated with the dataviz skill's validator (scripts/validate_palette.js) against the v3 chart surfaces
 * (light #FFFFFF, dark #16191F); status colours carry reserved meaning and always ship with a glyph + label.
 * See docs/decisions.md D-22 (v2) and design-v3.md. */
export type Mode = "dark" | "light";

/** The one UI family, for canvas / WebGL text (ECharts, deck.gl, three labels). */
export const FONT_STACK = '"Urbanist Variable", Urbanist, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Default series order for <= 4 series (focus + context): sky, signal, ink, grey. Slots 1-2 are the identities (all-pairs
 * CVD ΔE 23.3 light / 22.3 dark); ink and grey are deliberately neutral context series (reference lines, "other",
 * comparators) and must be direct-labelled or legend-labelled. */
export const CORE: Record<Mode, string[]> = {
  light: ["#5AB4E5", "#F05A28", "#3A3F4B", "#A3A8B5"],
  dark: ["#3F9AD3", "#E4521C", "#D7DAE0", "#6B7080"],
};

/** Validated categorical palette for > 4 identities (ROC / PR curves, timeline event types, multi-line legends).
 * Fixed order, never cycled. Light vs #FFFFFF: band/chroma PASS, worst adjacent CVD ΔE 9.1, normal-vision 19.6, contrast
 * WARN on slots 1, 3, 4, 5 (< 3:1, relief = direct labels or the table view). Dark vs #16191F (stepped for the dark band
 * L 0.48-0.67): all checks PASS, worst adjacent CVD ΔE 8.4, normal-vision 19.3. All-pairs forms (scatter, map points):
 * first three slots only (light CVD 9.8 / NV 16.5; dark CVD 10.5 / NV 15.9). */
export const CATEGORICAL: Record<Mode, string[]> = {
  light: ["#5AB4E5", "#F05A28", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3F9AD3", "#E4521C", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** Backward-compatible series array (v2 views index SERIES[mode][0..7]): the CORE four, then categorical slots 3-6.
 * New charts: CORE for <= 4 series, CATEGORICAL for more. */
export const SERIES: Record<Mode, string[]> = {
  light: [...CORE.light, ...CATEGORICAL.light.slice(2, 6)],
  dark: [...CORE.dark, ...CATEGORICAL.dark.slice(2, 6)],
};

/** UI hues for non-chart marks (progress fills, dot matrices, sparklines). */
export const HUE: Record<Mode, { sky: string; skySoft: string; signal: string; signalSoft: string; ink: string; grey: string; track: string }> = {
  light: { sky: "#5AB4E5", skySoft: "#D9EEF9", signal: "#F05A28", signalSoft: "#FDE9E1", ink: "#15171C", grey: "#A3A8B5", track: "#F5F6F9" },
  dark: { sky: "#6CC0EC", skySoft: "#1C3240", signal: "#FF6D3A", signalSoft: "#3A2219", ink: "#F2F3F5", grey: "#5A5F6B", track: "#1D2128" },
};
export const hue = () => HUE[mode()];

/** Status scale: reserved meaning, always paired with an icon + label. Fills / marks. One accent: serious and critical
 * are both signal (critical solid, serious lighter); warning is amber; good is green (small dots and glyphs only). */
export const STATUS = { good: "#2E9E6A", warning: "#D98A00", serious: "#F58A60", critical: "#F05A28" };
export type StatusKey = keyof typeof STATUS;
/** Status colour for text: darker steps on white, brighter steps on the dark surface. */
export const STATUS_TEXT: Record<Mode, Record<StatusKey, string>> = {
  light: { good: "#1F7A52", warning: "#9A6200", serious: "#B83A12", critical: "#B83A12" },
  dark: { good: "#4CC28A", warning: "#F0A626", serious: "#FF8A5C", critical: "#FF8A5C" },
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

/** v2 range-bar gradient. Design v3 bars are a grey track with one solid fill (GradientRangeBar); these stay exported so
 * old imports compile, and now describe a single-hue sky -> signal ramp instead of a traffic-light rainbow. */
export const RANGE_STOPS = ["#5AB4E5", "#F05A28"];
export const RANGE_GRADIENT = `linear-gradient(90deg, ${RANGE_STOPS.join(", ")})`;
/** Build a CSS gradient from stops (optionally reversed, e.g. when higher is better). */
export const rangeGradient = (stops: string[] = RANGE_STOPS, reverse = false) =>
  `linear-gradient(90deg, ${(reverse ? [...stops].reverse() : stops).join(", ")})`;

/** Sequential (magnitude) ramp for maps and heat cells: one warm hue, the signal family.
 * Light: #F3F4F7 -> #F8C9B5 -> #F05A28 -> #B83A12 (near-surface grey to deep signal), 7 steps.
 * Dark: dim -> bright on #16191F, ending in the dark signal. */
export const SEQ_LIGHT = ["#F3F4F7", "#F6DDD2", "#F8C9B5", "#F49170", "#F05A28", "#D4491D", "#B83A12"];
export const SEQ_DARK = ["#22252C", "#3A2621", "#5E2C1C", "#8C3518", "#C2441A", "#F05A28", "#FF8A5C"];
/** Anchors of the light map ramp (design-v3 §Tokens). */
export const MAP_RAMP_LIGHT = ["#F3F4F7", "#F8C9B5", "#F05A28", "#B83A12"];
/** Diverging (SHAP push down / up, SIR around 1): sky <- grey -> signal. */
export const DIVERGING = { neg: "#3593CC", mid: "#A3A8B5", pos: "#F05A28" };

export function mode(): Mode {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
/** Chart ink: text and chrome tokens (never a series colour). */
export const ink = () => (mode() === "dark"
  ? { primary: "#F2F3F5", secondary: "#B4B8C2", muted: "#8B909E", grid: "rgba(242,243,245,0.10)", axis: "rgba(242,243,245,0.18)", surface: "#16191F", border: "#262A33", tile: "#1D2128" }
  : { primary: "#15171C", secondary: "#4A4F5C", muted: "#6B7080", grid: "rgba(21,23,28,0.10)", axis: "rgba(21,23,28,0.16)", surface: "#FFFFFF", border: "#E8E9EF", tile: "#F5F6F9" });

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
