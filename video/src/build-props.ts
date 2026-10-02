/** Build typed video props from the FastAPI (Node only). The caller's role headers are forwarded, so the API's own role
 * checks apply: a doctor only reaches patients linked to their facility, and the ministry only gets aggregates.
 *
 * Patient props are built from a whitelist and then checked: no name / birthdate / phone keys, and the patient's real
 * name (seen in the raw payload) must not occur anywhere in the serialised props. */
import { FORBIDDEN_KEYS, MinistryReelPropsSchema, PatientVideoPropsSchema, type MinistryReelProps, type PatientVideoProps } from "./props";

/** FastAPI base: VIDEO_API_URL, else API_URL (the agent's variable, host only), always ending in /api/v1. */
export const API_URL = (() => {
  const raw = (process.env.VIDEO_API_URL ?? process.env.API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  return /\/api\/v\d+$/.test(raw) ? raw : `${raw}/api/v1`;
})();
export type RoleHeaders = Record<string, string>;

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

/** GET an API path; returns `data` from the envelope. `optional` turns 404/405/501 (endpoint not built yet) into null. */
async function get<T = any>(path: string, headers: RoleHeaders, optional = false): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    if (optional) return null;
    throw new ApiError(502, `API unreachable at ${API_URL}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    if (optional && [404, 405, 422, 501].includes(res.status)) return null;
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, `API ${path} -> ${res.status}`, body);
  }
  const j = (await res.json()) as any;
  const data = j && typeof j === "object" && "data" in j ? j.data : j;
  if (optional && (data === null || (Array.isArray(data) && !data.length) || (typeof data === "object" && !Object.keys(data).length))) return null;
  return data as T;
}

/** Remove identifying keys anywhere in a raw payload (defence in depth; the props are whitelisted anyway). */
export function stripIdentifiers<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripIdentifiers) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!FORBIDDEN_KEYS.includes(k)) out[k] = stripIdentifiers(x);
    return out as T;
  }
  return v;
}

export function assertNoNames(props: unknown, names: string[] = []) {
  const s = JSON.stringify(props);
  for (const k of FORBIDDEN_KEYS) if (s.includes(`"${k}"`)) throw new Error(`patient props contain a forbidden key: ${k}`);
  for (const n of names.filter((x) => x && x.trim().length >= 3)) {
    for (const part of [n, ...n.split(/\s+/).filter((p) => p.length >= 3)]) {
      if (s.toLowerCase().includes(part.toLowerCase())) throw new Error("patient props contain the patient's name");
    }
  }
}

const d10 = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : null);
const round = (v: number | null | undefined, k = 3) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** k) / 10 ** k : null);

/** Reference ranges for the mini lab charts (adult, synthetic EMR units). Sex-specific Hb. */
function refRange(name: string, sex: string | null): [number | null, number | null] {
  const n = name.toLowerCase();
  if (n.startsWith("haemoglobin")) return sex === "F" ? [12, 15.5] : [13, 17];
  const t: Record<string, [number, number]> = {
    mcv: [80, 100], wbc: [4, 11], platelets: [150, 400], bmi: [18.5, 25], "systolic bp": [90, 140], "diastolic bp": [60, 90],
    pulse: [60, 100], temperature: [36.1, 37.5], "respiratory rate": [12, 20], albumin: [3.5, 5], "vitamin b12": [200, 900], b12: [200, 900],
    ferritin: [30, 300], creatinine: [0.6, 1.2],
  };
  return t[n] ?? [null, null];
}

const PAIRS: Record<string, { id: string; label: string }> = {
  kidney_l: { id: "kidneys", label: "Kidneys" }, kidney_r: { id: "kidneys", label: "Kidneys" },
  lung_l: { id: "lungs", label: "Lungs" }, lung_r: { id: "lungs", label: "Lungs" },
};
const TYPE_LABEL: Record<string, string> = {
  SYMPTOM: "Symptom", DIAGNOSIS: "Diagnosis", LAB: "Lab", VITAL: "Vital sign", DRUG: "Medicine", VISIT: "Visit", ORDER: "Order",
  ENDOSCOPY: "Procedure", PATHOLOGY: "Procedure", STAGING: "Procedure", REFERRAL: "Referral",
};

// ------------------------------------------------------------------------------------------------ patient
export async function buildPatientProps(patientId: number | string, headers: RoleHeaders): Promise<PatientVideoProps> {
  const id = encodeURIComponent(String(patientId));
  const [caseRaw, riskRaw, careRaw, journeyRaw] = await Promise.all([
    get<any>(`/patients/${id}/case?months=36`, headers),
    get<any>(`/patients/${id}/risk`, headers, true),
    get<any>(`/patients/${id}/care`, headers, true),
    get<any>(`/patients/${id}/journey`, headers, true),
  ]);
  if (!caseRaw) throw new ApiError(404, "case not found");
  // remember the real name only to prove it is absent from the output
  const names = [caseRaw.header?.name, ...(caseRaw.alerts ?? []).map((a: any) => a.name),
    [caseRaw.header?.given_name, caseRaw.header?.family_name].filter(Boolean).join(" ")].filter(Boolean) as string[];
  const c = stripIdentifiers(caseRaw);
  const h = c.header ?? {};
  const sex: string | null = h.sex ?? null;
  const simDate = d10(c.window?.end) ?? d10(c.risk?.as_of) ?? "2026-06-30";
  const events: any[] = c.events ?? [];

  // concept -> organs from the timeline (labs and vitals inherit the organs their events map to)
  const conceptOrgans = new Map<number, Set<string>>();
  for (const e of events) {
    if (!e.organ_ids?.length) continue;
    const s = conceptOrgans.get(e.concept_id) ?? new Set<string>();
    e.organ_ids.forEach((o: string) => s.add(PAIRS[o]?.id ?? o));
    conceptOrgans.set(e.concept_id, s);
  }
  const condByLabel = new Map<string, any>();
  for (const x of c.conditions ?? []) condByLabel.set(x.label, x);
  const labLike = [...(c.labs ?? []), ...(c.vitals ?? [])].filter((l: any) => !l.coded && (l.series?.length ?? 0) >= 1);

  const merged = new Map<string, { id: string; label: string; score: number; conditions: Set<string> }>();
  for (const o of c.organs ?? []) {
    const key = PAIRS[o.organ_id]?.id ?? o.organ_id;
    const g = merged.get(key) ?? { id: key, label: PAIRS[o.organ_id]?.label ?? o.label, score: 0, conditions: new Set<string>() };
    g.score = Math.max(g.score, o.score ?? 0);
    (o.conditions ?? []).forEach((x: string) => g.conditions.add(x));
    merged.set(key, g);
  }
  const organs = [...merged.values()].sort((a, b) => b.score - a.score).map((g) => {
    const conditions = [...g.conditions].map((name) => {
      const cc = condByLabel.get(name);
      return { name, date: d10(cc?.last_ts) ?? simDate, severity: round(cc?.severity ?? 0, 3) ?? 0 };
    }).sort((a, b) => b.severity - a.severity).slice(0, 6);
    const labs = labLike.filter((l: any) => conceptOrgans.get(l.concept_id)?.has(g.id))
      .sort((a: any, b: any) => Number(b.abnormal) - Number(a.abnormal) || (b.series?.length ?? 0) - (a.series?.length ?? 0))
      .slice(0, 2)
      .map((l: any) => {
        const [low, high] = refRange(l.name, sex);
        return { name: l.name, unit: l.unit ?? null, low, high,
          series: (l.series ?? []).filter((p: any) => typeof p.value === "number").map((p: any) => ({ date: d10(p.ts) as string, value: round(p.value, 2) as number })) };
      });
    return { id: g.id, label: g.label, score: round(g.score, 3) ?? 0, conditions, labs };
  });

  // timeline: the last 24 months, without routine normal vitals (they would bury the signal)
  const from = new Date(Date.parse(`${simDate}T00:00:00Z`) - 730 * 86400000).toISOString().slice(0, 10);
  const timeline = events.filter((e) => d10(e.ts)! >= from && !(e.event_type === "VITAL" && !e.is_abnormal))
    .map((e) => ({ date: d10(e.ts) as string, type: TYPE_LABEL[e.event_type] ?? e.event_type, label: String(e.label ?? ""),
                   organ_ids: (e.organ_ids ?? []).map((o: string) => PAIRS[o]?.id ?? o), abnormal: !!e.is_abnormal }))
    .slice(-160);

  const r = riskRaw?.current ?? c.risk ?? null;
  const thr = riskRaw?.thresholds ?? null;
  const reasons = (r?.top_reasons ?? []).map((x: any) => ({ label: String(x.label ?? x.feature), value: round(x.contribution ?? 0, 3) ?? 0,
    direction: (x.contribution ?? 0) >= 0 ? "up" : "down" }));

  const care = careRaw?.plans?.length ? {
    plans: careRaw.plans.map((p: any) => ({
      pathway: String(p.pathway_name ?? p.pathway ?? "Care plan"), status: String(p.status ?? ""),
      tasks: (p.tasks ?? []).map((t: any) => ({ title: String(t.title ?? t.type ?? "Task"), status: String(t.status ?? ""),
        due: d10(t.due_at ?? t.due), completed: d10(t.completed_at ?? t.completed) })),
    })),
  } : null;

  const journey = journeyRaw?.phases?.length ? normaliseJourney(journeyRaw) : null;
  const t = c.tumour;
  const tumour = t ? { stage_group: t.stage_group ?? null, t_stage: t.t_stage ?? null, n_stage: t.n_stage ?? null, m_stage: t.m_stage ?? null,
    lesion_location: t.lesion_location ?? null, dx_date: d10(t.dx_date), histology: t.lauren ?? null } : null;
  const alerts = (c.alerts ?? []).map((a: any) => ({ trigger: String(a.trigger), severity: String(a.severity), summary: String(a.summary ?? "") }));

  const props = PatientVideoPropsSchema.parse({
    display_id: h.display_id,
    facility: h.home_facility_name ?? "Facility (Synthetic)",
    sim_date: simDate,
    synthetic: true,
    risk: {
      t1_score: r?.t1_score ?? null, t2_prob: round(r?.t2_prob, 4), ensemble_prob: round(r?.ensemble_prob, 4),
      band: r?.risk_band ?? (h.is_case ? "DIAGNOSED" : "NOT SCORED"), top_reasons: reasons, t1_band: r?.t1_band ?? null,
      thresholds: thr ? { medium: round(thr.medium_cut ?? thr.medium ?? null, 4), high: round(thr.high_cut ?? thr.high ?? null, 4) } : null,
    },
    organs, timeline, care, journey, tumour, alerts,
    // an alert's screening suggestion only while the patient is undiagnosed and the alert is still open; otherwise the
    // summary shows the active care plan's next step (a diagnosed patient in treatment must not be told to get scoped)
    next_step: h.is_case ? null
      : (c.alerts ?? []).find((a: any) => a.suggested_action && ["NEW", "ACKNOWLEDGED"].includes(String(a.status ?? "NEW").toUpperCase()))?.suggested_action ?? null,
  });
  assertNoNames(props, names);
  return props;
}

function normaliseJourney(j: any) {
  const series: Record<string, { date: string; value: number }[]> = {};
  for (const [k, v] of Object.entries(j.recovery?.series ?? {})) {
    if (!Array.isArray(v)) continue;
    const pts = v.map((p: any) => ({ date: d10(p.date ?? p.ts ?? p.t) as string, value: Number(p.value ?? p.v) }))
      .filter((p) => p.date && Number.isFinite(p.value));
    if (pts.length) series[k] = pts;
  }
  return {
    phases: j.phases.map((p: any) => ({ phase: String(p.phase ?? p.name ?? "Phase"), start: d10(p.start), end: d10(p.end), status: String(p.status ?? ""),
      milestones: (p.milestones ?? []).map((m: any) => ({ date: d10(m.date) as string, label: String(m.label ?? ""), kind: m.kind ?? null })).filter((m: any) => m.date) })),
    recovery: j.recovery ? {
      series,
      chemo: j.recovery.chemo ? { done: j.recovery.chemo.done ?? null, planned: j.recovery.chemo.planned ?? null } : null,
      next_visit: d10(j.recovery.next_visit), missed_visits: j.recovery.missed_visits ?? null,
      recurrence: j.recovery.recurrence == null ? null : String(typeof j.recovery.recurrence === "object" ? j.recovery.recurrence.status ?? "" : j.recovery.recurrence),
    } : null,
  };
}

// ------------------------------------------------------------------------------------------------ ministry
export type MinistryParams = { from?: number | string; to?: number | string; sex?: string; age?: string; def?: string };

/** Douglas-Peucker on one ring (degrees). */
function simplifyRing(pts: number[][], tol: number): number[][] {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let idx = -1, dmax = 0;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = pts.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
  return out.length >= 4 ? out : pts;
}

function simplifyGeo(raw: any) {
  if (!raw?.features) return null;
  return {
    type: "FeatureCollection" as const,
    features: raw.features.map((f: any) => {
      const g = f.geometry;
      const coords = g.type === "Polygon" ? g.coordinates.map((r: number[][]) => simplifyRing(r, 0.0025))
        : g.coordinates.map((poly: number[][][]) => poly.map((r) => simplifyRing(r, 0.0025)));
      return { type: "Feature" as const, properties: { code: f.properties.district_code ?? f.properties.code, name: f.properties.name },
               geometry: { type: g.type, coordinates: coords } };
    }),
  };
}

const AGE = new Set(["ALL", "<50", "50-64", "65+"]);
const SEXES = new Set(["ALL", "M", "F"]);
const DEFS = new Set(["CONFIRMED_PROBABLE", "CONFIRMED"]);

export function normaliseMinistryParams(p: MinistryParams) {
  const to = Number(p.to ?? 2026), from = Number(p.from ?? 2015);
  const sex = SEXES.has(String(p.sex ?? "ALL")) ? String(p.sex ?? "ALL") : "ALL";
  const age = AGE.has(String(p.age ?? "ALL")) ? String(p.age ?? "ALL") : "ALL";
  const def = DEFS.has(String(p.def ?? "CONFIRMED_PROBABLE")) ? String(p.def ?? "CONFIRMED_PROBABLE") : "CONFIRMED_PROBABLE";
  return { from: Math.min(from, to), to: Math.max(from, to), sex, age, def };
}

export async function buildMinistryProps(params: MinistryParams, headers: RoleHeaders): Promise<MinistryReelProps> {
  const P = normaliseMinistryParams(params);
  const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
  const filt = { sex: P.sex, age_band: P.age, case_def: P.def };
  const series = `NATIONAL|${P.sex}|${P.age}|${P.def}`;
  const [kpis, rates, young, jp0, spatial, funnel, stage, models, careFunnel, careAdh, forecast, geoRaw, filters, health] = await Promise.all([
    get<any>(`/kpis`, headers),
    get<any[]>(`/rates?${q({ ...filt, year_from: P.from, year_to: P.to })}`, headers),
    get<any[]>(`/rates?${q({ sex: P.sex, age_band: "<50", case_def: P.def, year_from: P.from, year_to: P.to })}`, headers, true),
    get<any>(`/trends/joinpoint?${q({ series_id: series })}`, headers, true),
    get<any>(`/spatial`, headers, true),
    get<any[]>(`/cohort/funnel`, headers, true),
    get<any[]>(`/stage-mix`, headers, true),
    get<any[]>(`/models`, headers, true),
    get<any>(`/care/funnel?${q({ from: `${P.from}-01-01`, to: `${P.to}-12-31` })}`, headers, true),
    get<any>(`/care/adherence?by=channel`, headers, true),
    get<any>(`/forecast/series?${q({ geo: "NATIONAL", sex: P.sex, age: P.age, freq: "Y" })}`, headers, true),
    get<any>(`/geo/districts`, headers, true),
    get<any>(`/meta/filters`, headers, true),
    get<any>(`/health`, headers, true),
  ]);
  const jp = jp0 ?? (series !== "NATIONAL|ALL|ALL|CONFIRMED_PROBABLE" ? await get<any>(`/trends/joinpoint`, headers, true) : null);

  // ---- KPIs for the last year of the period that has data
  const years: number[] = kpis?.years ?? [];
  const kYear = [...years].reverse().find((y) => y <= P.to) ?? kpis?.year;
  const k = kYear && kYear !== kpis?.year ? await get<any>(`/kpis?year=${kYear}`, headers, true) ?? kpis : kpis;
  const spark = (key: string) => (k?.sparklines?.[key] ?? []).filter((x: any) => x.year >= P.from && x.year <= P.to).map((x: any) => round(x.value, 3));
  const prevOf = (key: string) => { const s = (k?.sparklines?.[key] ?? []) as any[]; const i = s.findIndex((x) => x.year === k?.year); return i > 0 ? s[i - 1].value : null; };
  const pctChange = (now: number | null, prev: number | null) => (now != null && prev ? round((100 * (now - prev)) / prev, 1) : null);
  const ptsChange = (now: number | null, prev: number | null) => (now != null && prev != null ? round(now - prev, 1) : null);
  const vsLabel = k?.year ? `vs ${k.year - 1}` : "";
  const kpiList = k ? [
    { label: `Cases, ${k.year}${k.partial_year ? " (annualised)" : ""}`, value: round(k.cases_annualised ?? k.cases, 0), unit: "", delta: round(k.cases_delta_pct, 1), delta_label: vsLabel, spark: spark("cases_annualised") },
    { label: "Age-standardised rate", value: round(k.national_asr, 1), unit: "per 100,000", delta: pctChange(k.national_asr, prevOf("national_asr")), delta_label: vsLabel, spark: spark("national_asr"), decimals: 1 },
    { label: "Diagnosed at stage IV", value: round(k.pct_stage_iv, 0), unit: "%", delta: ptsChange(k.pct_stage_iv, prevOf("pct_stage_iv")), delta_label: vsLabel, spark: spark("pct_stage_iv") },
    { label: "Median time to diagnosis", value: round(k.median_diag_interval_days, 0), unit: "days", delta: pctChange(k.median_diag_interval_days, prevOf("median_diag_interval_days")), delta_label: vsLabel, spark: spark("median_diag_interval_days") },
    { label: "H. pylori testing in dyspepsia", value: k.hp_testing_rate_dyspepsia == null ? null : round(100 * k.hp_testing_rate_dyspepsia, 0), unit: "%", delta: ptsChange(k.hp_testing_rate_dyspepsia == null ? null : 100 * k.hp_testing_rate_dyspepsia, prevOf("hp_testing_rate_dyspepsia") == null ? null : 100 * (prevOf("hp_testing_rate_dyspepsia") as number)), delta_label: vsLabel, higher_is_better: true, spark: spark("hp_testing_rate_dyspepsia").map((v: number | null) => (v == null ? null : v * 100)) },
    { label: "High-risk awaiting endoscopy", value: k.high_risk_awaiting_endoscopy ?? null, unit: "patients", delta: null },
  ] : [];

  // ---- national ASR (suppressed years stay null)
  const national_asr = (rates ?? []).filter((x) => x.level === "NATIONAL").map((x) => ({ year: Number(x.period), value: round(x.asr, 2), lo: round(x.asr_lci, 2), hi: round(x.asr_uci, 2) }));
  const segs: any[] = jp?.segments ?? [];
  const joinpoint = jp ? {
    year: segs.length > 1 ? segs[1].start_year : null,
    apc_before: round(segs[0]?.apc ?? null, 2), apc_after: round(segs.length > 1 ? segs[segs.length - 1].apc : null, 2),
    fitted: (jp.fitted ?? []).filter((f: any) => f.year >= P.from && f.year <= P.to).map((f: any) => ({ year: f.year, value: round(f.asr, 2) })),
    aapc: round(jp.aapc_last10?.value ?? null, 2),
  } : null;

  // ---- districts: 3-year pooled ASR, keyed by the window's end year (stable rates in small districts)
  const pooled: string[] = (filters?.pooled_periods ?? []).filter((p: string) => /^\d{4}-\d{4}$/.test(p))
    .filter((p: string) => { const [a, b] = p.split("-").map(Number); return b - a === 2 && b >= P.from && b <= P.to; });
  const maps = await Promise.all(pooled.map((p) => get<any[]>(`/rates/map?${q({ period_type: "POOLED3", period: p, metric: "asr", sex: P.sex, age_band: P.age, case_def: P.def })}`, headers, true)));
  const dist = new Map<string, { code: string; name: string; values_by_year: Record<string, number | null> }>();
  for (const d of filters?.districts ?? []) dist.set(d.district_code, { code: d.district_code, name: d.name, values_by_year: {} });
  pooled.forEach((p, i) => {
    const end = p.split("-")[1];
    for (const row of maps[i] ?? []) {
      const g = dist.get(row.geo_code) ?? { code: row.geo_code, name: row.name, values_by_year: {} as Record<string, number | null> };
      g.values_by_year[end] = round(row.asr, 1);
      dist.set(row.geo_code, g);
    }
  });
  const sp: any[] = spatial?.districts ?? [];
  const hotspots = sp.filter((d) => d.lisa_quadrant === "HH" || (typeof d.gi_star_z === "number" && d.gi_star_z >= 1.96)).map((d) => d.district_code);
  const smoothed = sp.length ? { label: `Smoothed rate, ${sp[0].period ?? "pooled"}`, values: Object.fromEntries(sp.map((d) => [d.district_code, round(d.eb_smoothed_rate, 1)])) } : null;

  // ---- young onset: ASR in under-50s
  const young_onset = (young ?? []).filter((x) => x.level === "NATIONAL").map((x) => ({ year: Number(x.period), value: round(x.asr, 2) }));

  // ---- cascade (endoscopy pathway), small cells suppressed
  const sup = (n: any) => (typeof n === "number" && n >= 5 ? n : null);
  const STEP: Record<string, string> = { gi_flagged: "Stomach complaints flagged", referred: "Referred", scoped: "Endoscopy done", biopsied: "Biopsy taken", diagnosed: "Diagnosed" };
  const cascade = (funnel ?? []).filter((x) => x.pathway === "endoscopy").map((x) => ({ step: STEP[x.stage] ?? x.stage, n: sup(x.n) }));

  // ---- stage mix (% of known stage), years with < 5 staged cases suppressed
  const byYear = new Map<number, Record<string, number>>();
  for (const x of stage ?? []) {
    const y = Number(x.year);
    if (!Number.isFinite(y) || y < P.from || y > P.to || !["I", "II", "III", "IV"].includes(x.stage_group)) continue;
    const g = byYear.get(y) ?? {};
    g[x.stage_group] = (g[x.stage_group] ?? 0) + (x.n ?? 0);
    byYear.set(y, g);
  }
  // a period is shown only when every non-zero stage cell has >= 5 cases (small-cell rule); sparse data falls back to
  // 3-year blocks ending at the last year, labelled by their end year
  const STAGES = ["I", "II", "III", "IV"] as const;
  const toRow = (year: number, g: Record<string, number>) => {
    const tot = STAGES.reduce((a, k) => a + (g[k] ?? 0), 0);
    const ok = tot >= 5 && STAGES.every((k) => !g[k] || g[k] >= 5);
    const pct = (v?: number) => (ok ? round((100 * (v ?? 0)) / tot, 1) : null);
    return { year, I: pct(g.I), II: pct(g.II), III: pct(g.III), IV: pct(g.IV) };
  };
  let stage_mix = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, g]) => toRow(y, g));
  let stage_mix_label = "Share of staged cases by year";
  if (stage_mix.filter((r) => r.IV !== null).length < 3) {
    const blocks: { year: number; g: Record<string, number> }[] = [];
    for (let end = P.to; end - 2 >= P.from; end -= 3) {
      const g: Record<string, number> = {};
      for (let y = end - 2; y <= end; y++) for (const k of STAGES) g[k] = (g[k] ?? 0) + (byYear.get(y)?.[k] ?? 0);
      blocks.unshift({ year: end, g });
    }
    stage_mix = blocks.map((b) => toRow(b.year, b.g));
    stage_mix_label = "Share of staged cases, 3-year periods";
  }

  // ---- care coordination (L2, optional)
  const care = careFunnel ? {
    funnel: (Array.isArray(careFunnel) ? careFunnel : careFunnel.steps ?? careFunnel.funnel ?? [])
      .map((x: any) => ({ step: String(x.step ?? x.stage ?? x.label ?? ""), n: sup(x.n ?? x.count) })).filter((x: any) => x.step),
    adherence: (Array.isArray(careAdh) ? careAdh : careAdh?.rows ?? careAdh?.groups ?? [])
      .map((x: any) => ({ group: String(x.group ?? x.channel ?? x.key ?? ""), value: round(x.rate ?? x.adherence ?? x.value ?? null, 3) }))
      .map((x: any) => ({ ...x, value: x.value != null && x.value <= 1 ? round(x.value * 100, 1) : x.value })).filter((x: any) => x.group),
    adherence_label: "Completed on time, by reminder channel (%)",
  } : null;

  // ---- forecast (L3, optional)
  const fp = (x: any) => ({ year: Number(x.year ?? String(x.period ?? x.ds ?? "").slice(0, 4)), value: round(x.value ?? x.mean ?? x.asr ?? x.y ?? null, 2),
    lo80: round(x.lo80 ?? null, 2), hi80: round(x.hi80 ?? null, 2), lo95: round(x.lo95 ?? null, 2), hi95: round(x.hi95 ?? null, 2) });
  const fc = forecast && Array.isArray(forecast.forecast) && forecast.forecast.length ? {
    history: (forecast.history ?? []).map(fp).filter((x: any) => Number.isFinite(x.year) && x.year >= P.from),
    forecast: forecast.forecast.map(fp).filter((x: any) => Number.isFinite(x.year)),
    label: forecast.model ? `Model: ${typeof forecast.model === "string" ? forecast.model : forecast.model.name ?? forecast.model.id ?? ""}` : undefined,
    metric: forecast.metric === "cases" ? "cases" as const : "asr" as const,
    source: forecast.run?.source_label ?? undefined,
  } : null;

  // ---- model performance: the active tier-2 model on the test split
  const active = (models ?? []).filter((m) => m.is_active);
  const best = active.find((m) => m.tier === 2) ?? active[0] ?? null;
  const t = best?.metrics?.test ?? best?.metrics?.val ?? null;
  const modelsOut = t ? { auroc: round(t.auroc, 3), auprc: round(t.auprc, 3), ppv: round(t.ppv_at_top2pct, 3), sens_at_spec90: round(t.sens_at_spec90, 3),
    lead_time_days: round(t.median_lead_time_days, 0), name: best.tier === 2 ? "Tier 2 (gradient boosting)" : `Tier ${best.tier}` } : null;

  const districts = [...dist.values()];
  const props = MinistryReelPropsSchema.parse({
    period: { from: P.from, to: P.to }, filters: { sex: P.sex, age: P.age, def: P.def }, kpis: kpiList, national_asr, joinpoint,
    districts, geo: simplifyGeo(geoRaw), hotspots, map_label: "3-year pooled age-standardised rate per 100,000", smoothed,
    stage_mix_label, young_onset, young_onset_label: "Age-standardised rate in under-50s, per 100,000", cascade, stage_mix, care, forecast: fc,
    models: modelsOut, messages: [], sim_date: d10(health?.meta?.sim_time) ?? undefined,
  });
  props.messages = keyMessages(props);
  return props;
}

/** Three closing messages chosen by fixed rules: each candidate gets a magnitude score; the top three win (ties keep the
 * candidate order), so the same data always gives the same messages. */
export function keyMessages(p: MinistryReelProps): string[] {
  const c: { score: number; text: string }[] = [];
  const asr = p.national_asr.filter((x) => x.value != null);
  if (asr.length >= 2) {
    const a = asr[0], b = asr[asr.length - 1];
    const ch = (100 * ((b.value as number) - (a.value as number))) / (a.value as number);
    c.push({ score: Math.abs(ch) / 10, text: `Age-standardised incidence ${ch >= 0 ? "rose" : "fell"} ${Math.abs(ch).toFixed(0)}% from ${a.year} to ${b.year}, to ${(b.value as number).toFixed(1)} per 100,000.` });
  }
  const sm = p.stage_mix.filter((x) => x.IV != null);
  if (sm.length >= 2) {
    const a = sm[0], b = sm[sm.length - 1];
    const d = (b.IV as number) - (a.IV as number);
    c.push({ score: Math.abs(d) / 5, text: `Stage IV at diagnosis went from ${(a.IV as number).toFixed(0)}% in ${a.year} to ${(b.IV as number).toFixed(0)}% in ${b.year}.` });
  }
  const cs = p.cascade.filter((x) => x.n != null);
  if (cs.length >= 2) {
    let worst = { i: -1, share: 2 };
    cs.forEach((s, i) => { if (i && (cs[i - 1].n as number) > 0) { const sh = (s.n as number) / (cs[i - 1].n as number); if (sh < worst.share) worst = { i, share: sh }; } });
    if (worst.i > 0) c.push({ score: (1 - worst.share) * 3, text: `The largest drop in the care cascade is from ${cs[worst.i - 1].step.toLowerCase()} to ${cs[worst.i].step.toLowerCase()}: only ${(100 * worst.share).toFixed(0)}% move on.` });
  }
  if (p.hotspots.length) {
    const names = p.districts.filter((d) => p.hotspots.includes(d.code)).map((d) => d.name).slice(0, 3);
    c.push({ score: 1.5 + p.hotspots.length * 0.2, text: `${p.hotspots.length} district${p.hotspots.length > 1 ? "s form" : " forms"} a high-rate cluster${names.length ? `: ${names.join(", ")}` : ""}.` });
  }
  const yo = p.young_onset.filter((x) => x.value != null);
  if (yo.length >= 2) {
    const a = yo[0], b = yo[yo.length - 1];
    const ch = (100 * ((b.value as number) - (a.value as number))) / (a.value as number);
    c.push({ score: Math.abs(ch) / 15, text: `Under-50 incidence ${ch >= 0 ? "rose" : "fell"} ${Math.abs(ch).toFixed(0)}% between ${a.year} and ${b.year}.` });
  }
  if (p.forecast?.forecast.length) {
    const e = p.forecast.forecast[p.forecast.forecast.length - 1];
    const cases = p.forecast.metric === "cases";
    const v = (x: number) => (cases ? Math.round(x).toLocaleString("en-GB") : x.toFixed(1));
    if (e.value != null) c.push({ score: 1.2, text: `The ${e.year} forecast is ${v(e.value)} ${cases ? "new cases" : "per 100,000"}${e.lo95 != null && e.hi95 != null ? ` (95% interval ${v(e.lo95)} to ${v(e.hi95)})` : ""}.` });
  }
  if (p.models?.ppv != null) c.push({ score: p.models.ppv * 2, text: `Of every 100 patients the model ranks highest, about ${Math.round(p.models.ppv * 100)} are diagnosed with gastric cancer.` });
  return c.map((x, i) => ({ ...x, i })).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 3).map((x) => x.text);
}
