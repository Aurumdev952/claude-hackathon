/** Number and date formatting for video text (en-GB style dates, thousands separators). */
export function fmtNum(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export const fmtPct = (v: number | null | undefined, decimals = 0) => (v === null || v === undefined ? "–" : `${fmtNum(v, decimals)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso: string | null | undefined, withDay = true): string {
  if (!iso) return "–";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m) return iso;
  return withDay && d ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${y}`;
}
export const monthLabel = (iso: string) => fmtDate(iso, false);
/** Days since epoch for an ISO date or datetime (UTC, deterministic). */
export function dayNum(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}
export const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : s);
export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
