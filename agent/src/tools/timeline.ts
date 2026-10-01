/** get_patient_timeline + helpers shared with make_patient_widget (ports of patients.timeline / _highlights / build_case). */
import { z } from "zod";
import { SERVE, type RowObject } from "../db/duck.js";
import { notFound, patientRisk, PatientRef, resolvePatient } from "./patient.js";
import { round } from "./rates.js";
import { defineTool } from "./types.js";

export const LABS: Record<number, string> = {
  3100: "Haemoglobin", 3101: "MCV", 3102: "Ferritin", 3103: "WBC", 3104: "Platelets", 3107: "Albumin", 3109: "Creatinine",
  3105: "ALT", 3110: "Random glucose", 3111: "HbA1c",
};
export const CODED_LABS: Record<number, string> = {
  3120: "H. pylori stool antigen", 3121: "H. pylori serology", 3122: "H. pylori breath test", 3112: "Malaria RDT", 3123: "Faecal occult blood",
};

const DAY = 86_400_000;
const parseTs = (s: unknown) => new Date(`${String(s).replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? "" : "Z"}`);
export const monthsBetween = (a: unknown, b: Date) => (b.getTime() - parseTs(a).getTime()) / DAY / 30.44;

export async function simTime(): Promise<Date> {
  const s = SERVE().meta().sim_time ?? "2026-06-30T23:59:59";
  return parseTs(s);
}

export async function timelineEvents(pid: number, where: string[] = [], params: unknown[] = []): Promise<RowObject[]> {
  return SERVE().rows(
    `SELECT t.ts, t.event_type, t.concept_id, t.label, t.value_num, t.value_text, t.unit, t.is_abnormal, l.name AS facility
     FROM pt_timeline t LEFT JOIN core_dim_location l ON l.location_id = t.facility_id
     WHERE ${["t.patient_id = ?", ...where].join(" AND ")} ORDER BY t.ts`,
    [pid, ...params],
  );
}

/** Port of patients._highlights: events matching Tier 3 attributions or SHAP reason features. */
export function highlights(ev: RowObject[], risk: RowObject | null): Set<number> {
  const out = new Set<number>();
  if (!risk) return out;
  const asof = parseTs(risk.as_of);
  const tmap: Record<string, string> = { V: "VISIT", D: "DIAGNOSIS", S: "SYMPTOM", L: "LAB", W: "VITAL", R: "DRUG" };
  for (const a of (risk.t3_attention as unknown as { token: string; days_before: number }[]) ?? []) {
    const parts = String(a.token).split(":");
    if (parts.length < 2) continue;
    const et = tmap[parts[0]];
    const cid = /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
    let best = -1;
    let gapBest = 1e9;
    ev.forEach((e, i) => {
      if (e.event_type === et && e.concept_id === cid) {
        const gap = Math.abs(Math.floor((asof.getTime() - parseTs(e.ts).getTime()) / DAY) - a.days_before);
        if (gap < gapBest) { best = i; gapBest = gap; }
      }
    });
    if (best >= 0 && gapBest <= 3) out.add(best);
  }
  const feats = new Set(((risk.top_reasons as unknown as { feature: string }[]) ?? []).map((x) => x.feature));
  const any = (xs: string[]) => xs.some((x) => feats.has(x));
  if (any(["hb_drop_12m", "hb_slope_12m", "hb_last", "hb_min_12m", "anaemia_flag"])) {
    const hbs = ev.map((e, i) => [e, i] as const).filter(([e]) => e.event_type === "LAB" && e.concept_id === 3100).map(([, i]) => i);
    for (const i of hbs.slice(-2)) out.add(i);
  }
  if (any(["sx_dysphagia", "sx_weight_loss", "sx_mass", "n_alarm_features_12m"])) {
    ev.forEach((e, i) => { if (e.event_type === "SYMPTOM" && [2203, 2205, 2213].includes(Number(e.concept_id))) out.add(i); });
  }
  return out;
}

export function series(ev: RowObject[]) {
  return {
    hb: ev.filter((e) => e.event_type === "LAB" && e.concept_id === 3100).map((e) => ({ ts: String(e.ts), value: (e.value_num as number | null) ?? null })),
    weight: ev.filter((e) => e.event_type === "VITAL" && e.concept_id === 3000).map((e) => ({ ts: String(e.ts), value: (e.value_num as number | null) ?? null })),
  };
}

/** Port of build_case.summarise for labs (latest value, 12-month change, abnormal flag) + coded H. pylori / FOBT results. */
export function labSummaries(ev: RowObject[]) {
  const out = [];
  for (const [cidS, name] of Object.entries(LABS)) {
    const cid = Number(cidS);
    const s = ev.filter((e) => e.event_type === "LAB" && e.concept_id === cid && typeof e.value_num === "number");
    if (!s.length) continue;
    const last = s[s.length - 1];
    const lastTs = parseTs(last.ts);
    const prev12 = s.filter((x) => monthsBetween(x.ts, lastTs) <= 12);
    const v0 = prev12[0]?.value_num as number | undefined;
    const chg = prev12.length >= 2 && v0 ? (100 * ((last.value_num as number) - v0)) / v0 : null;
    out.push({
      concept_id: cid, name, unit: (last.unit as string | null) ?? null, latest: last.value_num as number, latest_ts: String(last.ts),
      abnormal: !!last.is_abnormal, change_pct_12m: chg === null ? null : round(chg, 1), n: s.length,
    });
  }
  for (const [cidS, name] of Object.entries(CODED_LABS)) {
    const cid = Number(cidS);
    const res = ev.filter((e) => e.event_type === "LAB" && e.concept_id === cid);
    if (!res.length) continue;
    const last = res[res.length - 1];
    out.push({
      concept_id: cid, name, unit: null, latest: (last.value_text as string | null) ?? null, latest_ts: String(last.ts),
      abnormal: !!last.is_abnormal, n: res.length, coded: true,
    });
  }
  return out;
}

export const getPatientTimeline = defineTool({
  name: "get_patient_timeline",
  title: "Patient timeline",
  description:
    "Chronological EMR events of one patient at your facility: visits, diagnoses, symptoms, labs (haemoglobin etc.), vitals, " +
    "drugs, orders, endoscopy, pathology, staging, with abnormal flags and `highlight` on events that drove the risk score. " +
    "Window: the last `months` months (default 24) unless from/to are given; filter by types. Also returns Hb and weight series.",
  roles: ["doctor"],
  inputSchema: z.object({
    ...PatientRef,
    months: z.number().int().min(1).max(120).default(24),
    from: z.string().optional().describe("ISO date"),
    to: z.string().optional().describe("ISO date"),
    types: z.array(z.enum(["VISIT", "DIAGNOSIS", "SYMPTOM", "LAB", "VITAL", "DRUG", "ORDER", "ENDOSCOPY", "PATHOLOGY", "STAGING"])).optional(),
  }),
  async execute(i, t) {
    try {
      const pid = await resolvePatient(t, i);
      const where: string[] = [];
      const params: unknown[] = [];
      const end = await simTime();
      const from = i.from ?? new Date(end.getTime() - i.months * 30.44 * DAY).toISOString().slice(0, 10);
      where.push("t.ts >= CAST(? AS TIMESTAMP)");
      params.push(from);
      if (i.to) { where.push("t.ts <= CAST(? AS TIMESTAMP)"); params.push(i.to); }
      if (i.types?.length) { where.push(`t.event_type IN (${i.types.map(() => "?").join(",")})`); params.push(...i.types); }
      const ev = await timelineEvents(pid, where, params);
      const risk = await patientRisk(pid);
      const hl = highlights(ev, risk);
      const events = ev.map((e, k) => ({ ...e, highlight: hl.has(k) }));
      const counts: Record<string, number> = {};
      for (const e of events) counts[String(e.event_type)] = (counts[String(e.event_type)] ?? 0) + 1;
      return { ok: true, patient_id: pid, window: { from, to: i.to ?? null }, counts, n_events: events.length, series: series(ev), events };
    } catch (e) {
      return notFound(e);
    }
  },
  modelView(o) {
    if (!o.ok || !("events" in o)) return o;
    // keep the model view compact: abnormal / highlighted events first, then the most recent ones
    const ev = o.events;
    if (ev.length <= 120) return o;
    const keep = new Set<number>();
    ev.forEach((e, k) => { if (e.highlight || e.is_abnormal) keep.add(k); });
    for (let k = ev.length - 1; k >= 0 && keep.size < 120; k--) keep.add(k);
    return { ...o, events: ev.filter((_, k) => keep.has(k)).slice(-150), events_note: `${ev.length} events; showing abnormal, highlighted and most recent` };
  },
});
