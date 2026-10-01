/** Column labels and value formatting for arbitrary NL->SQL result sets. */
const LABELS: Record<string, string> = {
  geo_code: "Code", name: "Name", asr: "ASR per 100,000", asr_lci: "ASR lower 95%", asr_uci: "ASR upper 95%", crude_rate: "Crude rate per 100,000",
  cases: "Cases", year: "Year", period: "Period", sir: "SIR", lisa_quadrant: "LISA quadrant", stage: "Stage", surv_1y_pct: "1-year survival",
  n: "Patients", hp_test_rate_pct: "HP testing rate", n_dyspepsia: "Dyspepsia patients", district_code: "District", median_months: "Median (months)",
  group: "Group", cases_pct: "Cases", controls_pct: "Controls", pct_diffuse: "Diffuse type", pct_stage_iv: "Stage IV share",
  high_risk_awaiting_endoscopy: "High-risk awaiting endoscopy", high_risk_not_scoped: "High-risk not yet scoped", model_id: "Model", tier: "Tier",
  auroc: "AUROC", auprc: "AUPRC", median_lead_time_days: "Median lead time (days)", apc: "APC", apc_lci: "APC lower", apc_uci: "APC upper",
  segment_no: "Segment", start_year: "From", end_year: "To", significant: "Significant", risk_band: "Band", risk_pct: "Risk", display_id: "ID",
  age: "Age", sex: "Sex", created_at: "Created", summary: "Summary", series_id: "Series", metric: "Metric",
};

export function colLabel(c: string) {
  if (LABELS[c]) return LABELS[c];
  const s = c.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const isPct = (c: string) => /(_pct$|^pct_|_pct_)/.test(c) || c === "risk_pct";
const YEARISH = new Set(["year", "start_year", "end_year", "segment_no", "tier"]);

export function fmtVal(c: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (YEARISH.has(c)) return String(v);
    if (isPct(c)) return `${v.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    if (Number.isInteger(v)) return v.toLocaleString("en-GB");
    const ad = Math.abs(v);
    return v.toLocaleString("en-GB", { maximumFractionDigits: ad < 1 ? 3 : ad < 100 ? 1 : 0 });
  }
  return String(v).replace(" (Synthetic)", "");
}

export const isNumCol = (rows: unknown[][], i: number) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === "number");
