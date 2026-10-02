/** Value formatting and labels shared by the chat widgets. */
import type { Cell, Row, ValueFormat } from "@agent/widgets";

const ACRONYMS: Record<string, string> = {
  asr: "ASR", sir: "SIR", apc: "APC", aapc: "AAPC", lci: "lower CI", uci: "upper CI", ci: "CI", hp: "H. pylori", id: "ID",
  auroc: "AUROC", auprc: "AUPRC", ppv: "PPV", npv: "NPV", hb: "Hb", lisa: "LISA", gi: "GI", opd: "OPD", km: "KM",
};

/** `asr_lci` -> "ASR lower CI", `pct_stage4` -> "Pct stage4". */
export function colLabel(key: string): string {
  const words = key.split(/[_\s]+/).filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w);
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const N0 = nf(0, 0), N1 = nf(0, 1), N2 = nf(0, 2), N1F = nf(1, 1);

/** Sensible precision for an unformatted number. */
export function fmtNumber(v: number): string {
  const a = Math.abs(v);
  if (Number.isInteger(v)) return N0.format(v);
  if (a >= 100) return N0.format(v);
  if (a >= 10) return N1.format(v);
  if (a >= 1) return N1.format(v);
  return N2.format(v);
}

export function fmtValue(v: Cell | undefined, format?: ValueFormat, unit?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "—";
  switch (format) {
    case "integer": return N0.format(v);
    case "percent": return `${N1.format(v)}%`;
    case "fraction_percent": return `${N1.format(v * 100)}%`;
    case "rate": return N1F.format(v);
    case "days": return `${N0.format(v)} d`;
    case "text": return String(v);
    default: {
      if (unit && /%$/.test(unit.trim())) return `${N1.format(v)}%`;
      if (isFractionUnit(unit) && Math.abs(v) <= 1) return `${N1.format(v * 100)}%`;
      return fmtNumber(v);
    }
  }
}

/** Units that mean "share between 0 and 1": shown as percentages. */
export const isFractionUnit = (unit?: string) => !!unit && /^(fraction|proportion|share|probability)\b/i.test(unit.trim());
/** Unit text for axis / legend captions ("fraction" reads as "%"). */
export const unitText = (unit?: string) => (isFractionUnit(unit) ? "%" : unit);

/** Value of `key` in `row`, falling back to the suppression label (`<key>_label`, e.g. "<5"). */
export function cellText(row: Row, key: string, format?: ValueFormat, unit?: string): string {
  const v = row[key];
  if ((v === null || v === undefined) && typeof row[`${key}_label`] === "string") return String(row[`${key}_label`]);
  if ((v === null || v === undefined) && key !== "cases" && row.suppressed === true) return "suppressed";
  return fmtValue(v, format, unit);
}

export const asNum = (v: Cell | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function initials(name: string | null | undefined, fallback = "?"): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || fallback;
}

/** Humanise SCREAMING_CASE codes ("RISK_BAND_HIGH" -> "Risk band high"). */
export function humanCode(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
