/** Chart colour system. Validated with the dataviz skill's validator against the Highland Watch surfaces
 * (dark #27333F, light #FFFFFF): categorical = reference palette in fixed order (8 slots, adjacent CVD ΔE >= 8.4,
 * normal-vision >= 19.3); all-pairs forms (scatter / map points) use the first three slots only.
 * Brand hues (kivu/tea/sorghum/laterite) stay for UI chrome; they fail as a 4-series categorical set (green/red
 * collapse under deuteranopia), so they never carry series identity. See docs/decisions.md D-22. */
export type Mode = "dark" | "light";

export const SERIES: Record<Mode, string[]> = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};
/** Status scale: reserved meaning, always paired with an icon + label. */
export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };
export const BAND_STATUS: Record<string, keyof typeof STATUS> = { LOW: "good", MEDIUM: "warning", HIGH: "critical" };
/** Sequential (magnitude) ramp: one hue (laterite family, the spec's hotspot colour), dim -> bright on dark. */
export const SEQ_DARK = ["#3a2d2b", "#5b3328", "#7d3a27", "#a04326", "#c25030", "#df6a48", "#f08d6f"];
export const SEQ_LIGHT = ["#fbe3dc", "#f4c3b4", "#e99b85", "#d9704f", "#c24f2f", "#9c3a20", "#722816"];
/** Diverging (SHAP push down / up): blue <- gray -> orange. */
export const DIVERGING = { neg: "#3987e5", mid: "#8a949c", pos: "#d95926" };

export function mode(): Mode {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
export const ink = () => (mode() === "dark"
  ? { primary: "#E6ECEE", secondary: "#B4C0C8", muted: "#8696A2", grid: "rgba(230,236,238,0.07)", axis: "rgba(230,236,238,0.22)", surface: "#27333F" }
  : { primary: "#1B2430", secondary: "#45525E", muted: "#6B7884", grid: "rgba(27,36,48,0.08)", axis: "rgba(27,36,48,0.25)", surface: "#FFFFFF" });

export function seqColor(t: number): string {
  const ramp = mode() === "dark" ? SEQ_DARK : SEQ_LIGHT;
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
  return ramp[i];
}
export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Interpolated sequential colour (for continuous fills such as the 3D map). */
export function seqRgb(t: number): [number, number, number] {
  const ramp = (mode() === "dark" ? SEQ_DARK : SEQ_LIGHT).map(hexToRgb);
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = ramp[i], b = ramp[Math.min(i + 1, ramp.length - 1)];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];
}
