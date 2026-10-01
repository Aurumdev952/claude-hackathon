/**
 * Small-cell suppression (api/routers/epi.py `_suppress`, `_suppress_observed`; SPEC §18) and de-identification
 * (api/llm/guardrails.py `deidentify`) plus the doctor-side pseudonymised model view.
 */
type Obj = Record<string, unknown>;

/** Same key set as Python PII_KEYS. */
export const PII_KEYS = new Set(["given_name", "family_name", "name", "display_id", "patient_id", "birthdate", "phone", "national_id"]);

/** Keys that identify a person by name/contact; stripped from everything the remote model sees on the doctor side. */
export const NAME_KEYS = new Set(["given_name", "family_name", "birthdate", "phone", "national_id", "patient_name", "full_name"]);

const RATE_FIELDS = ["crude_rate", "asr", "asr_lci", "asr_uci"];

/** Port of epi._suppress: rows flagged `suppressed` (< 5 cases) lose their count and every rate derived from it. */
export function suppressRow<T extends Obj>(x: T): T {
  if (x.suppressed) {
    const out: Obj = { ...x, cases: null, cases_label: "<5" };
    for (const k of RATE_FIELDS) out[k] = null;
    return out as T;
  }
  return x;
}

/** Port of epi._suppress_observed (joinpoint observed points). */
export function suppressObserved(points: Obj[] | null | undefined): Obj[] {
  return (points ?? []).map((o) =>
    typeof o.cases === "number" && o.cases < 5 ? { ...o, cases: null, cases_label: "<5", asr: null, lci: null, uci: null } : o,
  );
}

/** n_* columns that count model artefacts, not people. */
const NOT_PERSON_COUNTS = new Set([
  "n_joinpoints", "n_features", "n_segments", "n_models", "n_folds",
  // process / model-evaluation denominators (facility H. pylori testing, model test split): not disease counts
  "n_dyspepsia", "n_hp_tested", "n_pos", "n_neg",
]);

/** Count-like columns in mart rows (cases, n, n_*, *_count, count*). */
export function isCountKey(k: string): boolean {
  const l = k.toLowerCase();
  if (NOT_PERSON_COUNTS.has(l)) return false;
  if (l.endsWith("_label") || l.endsWith("_days") || l.endsWith("_pct") || l.endsWith("_rate") || l.endsWith("_share") || l.includes("delta")) return false;
  return l === "cases" || l === "n" || l === "cases_annualised" || l.startsWith("n_") || l.startsWith("count") || l.endsWith("_count") ||
    l === "observed" || l === "deaths" || l === "events";
}

/** Rate / proportion columns that would let a suppressed count be back-calculated. */
export function isDerivedKey(k: string): boolean {
  const l = k.toLowerCase();
  if (l.startsWith("hp_test") || l.startsWith("funnel_") || l.startsWith("target_")) return false; // other denominator
  return RATE_FIELDS.includes(l) || l === "rate" || l === "pct" || l === "pct_known" || l === "lci" || l === "uci" ||
    l.endsWith("_rate") || l.endsWith("_pct") || l.startsWith("pct_") || l.endsWith("_lci") || l.endsWith("_uci");
}

/**
 * Ministry output filter for arbitrary mart rows: `suppressed` flags are honoured exactly like the FastAPI, and any count
 * column below 5 is nulled with a `<col>_label: "<5"` marker together with the rates derived from it.
 */
export function suppressSmallCells<T extends Obj>(rows: T[]): T[] {
  return rows.map((r0) => {
    let r: Obj = suppressRow(r0);
    const small = Object.keys(r).filter((k) => isCountKey(k) && typeof r[k] === "number" && (r[k] as number) < 5);
    if (!small.length) return r as T;
    r = { ...r };
    for (const k of small) {
      r[k] = null;
      r[k === "cases" ? "cases_label" : `${k}_label`] = "<5";
    }
    for (const k of Object.keys(r)) if (isDerivedKey(k)) r[k] = null;
    return r as T;
  });
}

/** Port of guardrails.deidentify. `keepName` keeps aggregate `name` columns (district / facility names) for the ministry. */
export function deidentify<T>(obj: T, opts: { keepName?: boolean } = {}): T {
  if (Array.isArray(obj)) return obj.map((x) => deidentify(x, opts)) as T;
  if (obj && typeof obj === "object") {
    const out: Obj = {};
    for (const [k, v] of Object.entries(obj as Obj)) {
      if (PII_KEYS.has(k) && !(opts.keepName && k === "name")) continue;
      out[k] = deidentify(v, opts);
    }
    return out as T;
  }
  return obj;
}

/**
 * Doctor model view: names, birth dates and contact details are removed; a `name` sitting next to a patient key is a
 * patient's name and is removed too (facility / district names elsewhere are kept). display_id + clinical data remain.
 */
export function pseudonymise<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((x) => pseudonymise(x)) as T;
  if (obj && typeof obj === "object") {
    const o = obj as Obj;
    const patientLevel = "patient_id" in o || "display_id" in o;
    const out: Obj = {};
    for (const [k, v] of Object.entries(o)) {
      if (NAME_KEYS.has(k)) continue;
      if (k === "name" && patientLevel) continue;
      out[k] = pseudonymise(v);
    }
    return out as T;
  }
  return obj;
}

/** Ministry model/MCP view: suppression already applied by the tool; strip any patient key that could remain. */
export function ministryView<T>(obj: T): T {
  return deidentify(obj, { keepName: true });
}
