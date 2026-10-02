/** Design v3 tokens for video (light theme, D-44): flat white cards on a cool grey page, Urbanist only, one attention
 * accent (signal) and one data hue (sky). Values mirror frontend/src/styles.css and frontend/src/lib/viz.ts. No gradients,
 * no glows, no shadows. Sizes are for a 1920x1080 frame (the vertical reel uses the same scale). */
export const C = {
  page: "#F1F2F6",
  surface: "#FFFFFF",
  tile: "#F5F6F9",
  tileHover: "#ECEDF2",
  hairline: "#E8E9EF",
  ink: "#15171C",
  ink2: "#4A4F5C",
  muted: "#6B7080",
  faint: "#A3A8B5",
  grey300: "#D6D8DF",
  signal: "#F05A28",
  signalStrong: "#D14516",
  signalText: "#B83A12",
  signalSoft: "#FDE9E1",
  sky: "#5AB4E5",
  skyDeep: "#3593CC",
  skySoft: "#D9EEF9",
  success: "#2E9E6A",
  successText: "#1F7A52",
  warning: "#D98A00",
  warningText: "#9A6200",
  grid: "rgba(21,23,28,0.08)",
  axis: "rgba(21,23,28,0.16)",
  stage: "#14171C",
} as const;

/** Sequential (magnitude) ramp, the signal family (viz.ts SEQ_LIGHT). */
export const SEQ = ["#F3F4F7", "#F6DDD2", "#F8C9B5", "#F49170", "#F05A28", "#D4491D", "#B83A12"];

export const FONT = '"Urbanist Variable", Urbanist, system-ui, sans-serif';

/** Type scale for 1080p video (the app's scale x ~2). */
export const T = {
  hero: { fontSize: 132, lineHeight: "136px", fontWeight: 500, letterSpacing: "-0.03em" },
  display: { fontSize: 84, lineHeight: "90px", fontWeight: 500, letterSpacing: "-0.025em" },
  h1: { fontSize: 56, lineHeight: "64px", fontWeight: 600, letterSpacing: "-0.015em" },
  metric: { fontSize: 76, lineHeight: "80px", fontWeight: 500, letterSpacing: "-0.02em" },
  title: { fontSize: 34, lineHeight: "42px", fontWeight: 600 },
  body: { fontSize: 28, lineHeight: "38px", fontWeight: 400 },
  label: { fontSize: 24, lineHeight: "30px", fontWeight: 500 },
  micro: { fontSize: 20, lineHeight: "26px", fontWeight: 500 },
} as const;

export const R = { tile: 20, card: 32, hero: 36, pill: 999 } as const;

export function seqColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const i = Math.max(0, Math.min(SEQ.length - 1, Math.round(x * (SEQ.length - 1))));
  return SEQ[i];
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(a: string, b: string, f: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  const k = Math.max(0, Math.min(1, f));
  return `#${[0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * k).toString(16).padStart(2, "0")).join("")}`;
}
/** Continuous sequential colour for an organ / district score in 0..1 (light steps start above the grey). */
export function scoreColor(t: number): string {
  const ramp = SEQ.slice(2);
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.floor(x);
  return mix(ramp[i], ramp[Math.min(i + 1, ramp.length - 1)], x - i);
}
export const alpha = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
