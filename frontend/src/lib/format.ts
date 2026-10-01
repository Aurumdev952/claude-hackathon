export const fmt = (v: number | null | undefined, nd = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toLocaleString("en-GB", { minimumFractionDigits: nd, maximumFractionDigits: nd }));
export const int = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-GB"));
export const pct = (v: number | null | undefined, nd = 0, scale = 1) => (v === null || v === undefined ? "—" : `${(v * scale).toFixed(nd)}%`);
export const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const monthYear = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "—");
export const signed = (v: number | null | undefined, nd = 1, unit = "") => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(nd)}${unit}`);
export function ago(ms: number | null) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
