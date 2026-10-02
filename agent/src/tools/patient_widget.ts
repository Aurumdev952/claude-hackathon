/** make_patient_widget: assembles the PatientWidget (header, risk, 12-month timeline, labs, alerts, suggested actions). */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SERVE, type RowObject } from "../db/duck.js";
import { PatientWidget, type RiskReason } from "../widgets/specs.js";
import { alertsFor, notFound, patientHeader, patientRisk, PatientRef, resolvePatient } from "./patient.js";
import { round } from "./rates.js";
import { highlights, labSummaries, series, simTime, timelineEvents } from "./timeline.js";
import { defineTool } from "./types.js";

/** Suggested actions phrased as considerations (the agent never prescribes or diagnoses). */
const CONSIDER: Record<string, string> = {
  RISK_BAND_HIGH: "Consider upper GI endoscopy referral",
  ALARM_NO_SCOPE_90D: "Consider endoscopy referral: alarm features recorded 90+ days ago without endoscopy",
  HB_DROP: "Consider investigating the falling haemoglobin (FBC, iron studies) and a GI work-up",
  HP_POS_UNTREATED: "Consider H. pylori eradication therapy per national guideline",
};

const DAY = 86_400_000;

export const makePatientWidget = defineTool({
  name: "make_patient_widget",
  title: "Patient card",
  description:
    "Shows the clinician a patient card: header, current risk with reasons, risk history, a timeline of the last `months` months " +
    "(default 12) with highlighted events, latest labs, open alerts and suggested actions. ALWAYS call this when the question is " +
    "about a specific patient (e.g. 'my highest-risk patient', 'tell me about ES-...'). Returns a compact summary to you; the " +
    "full card is rendered in the UI.",
  roles: ["doctor"],
  inputSchema: z.object({
    ...PatientRef,
    months: z.number().int().min(3).max(60).default(12),
    focus: z.string().max(200).optional().describe("One line on why this patient is shown"),
  }),
  async execute(i, t) {
    try {
      const pid = await resolvePatient(t, i);
      const db = SERVE();
      const header = await patientHeader(pid);
      const risk = await patientRisk(pid);
      const history = (await db.hasTable("ml_risk_history"))
        ? (await db.rows("SELECT as_of, ensemble_prob, risk_band FROM ml_risk_history WHERE patient_id = ? ORDER BY as_of", [pid]))
            .map((r) => ({ as_of: String(r.as_of), ensemble_prob: round(r.ensemble_prob, 4), risk_band: (r.risk_band as string | null) ?? null }))
        : [];
      const all = await timelineEvents(pid);
      const sim = await simTime();
      const end = header.death_date ? new Date(Math.min(sim.getTime(), new Date(`${header.death_date}T00:00:00Z`).getTime())) : sim;
      const start = new Date(end.getTime() - i.months * 30.44 * DAY);
      const startIso = start.toISOString().slice(0, 19);
      const hl = highlights(all, risk);
      const windowEvents = all
        .map((e, k) => ({ ...e, highlight: hl.has(k) }) as RowObject)
        .filter((e) => String(e.ts) >= startIso)
        .map((e) => ({
          ts: String(e.ts), event_type: String(e.event_type), concept_id: (e.concept_id as number | null) ?? null, label: (e.label as string | null) ?? null,
          value_num: (e.value_num as number | null) ?? null, value_text: (e.value_text as string | null) ?? null, unit: (e.unit as string | null) ?? null,
          is_abnormal: (e.is_abnormal as boolean | null) ?? null, facility: (e.facility as string | null) ?? null, highlight: e.highlight === true,
        }));
      const s = series(all);
      const inWin = (p: { ts: string }) => p.ts >= startIso;
      const alerts = (await alertsFor("a.patient_id = ?", [pid])).map((a) => ({
        alert_id: String(a.alert_id), trigger: String(a.trigger), severity: String(a.severity), status: String(a.status),
        summary: (a.summary as string | null) ?? null, suggested_action: (a.suggested_action as string | null) ?? null,
        created_at: (a.created_at as string | null) ?? null,
      }));
      const open = alerts.filter((a) => a.status === "NEW" || a.status === "ACKNOWLEDGED");
      const actions: string[] = [];
      for (const a of open) {
        const c = CONSIDER[a.trigger] ?? (a.suggested_action ? `Consider: ${a.suggested_action}` : null);
        if (c && !actions.includes(c)) actions.push(c);
      }
      if (risk?.risk_band === "HIGH" && !risk.scoped_since_flag && !actions.includes(CONSIDER.RISK_BAND_HIGH)) actions.unshift(CONSIDER.RISK_BAND_HIGH);
      const widget: PatientWidget = {
        kind: "patient",
        id: `pw_${randomUUID().slice(0, 8)}`,
        patient_id: pid,
        display_id: (header.display_id as string | null) ?? null,
        name: (header.name as string | null) ?? null,
        sex: (header.sex as string | null) ?? null,
        age: (header.age as number | null) ?? null,
        district_name: (header.district_name as string | null) ?? null,
        home_facility_name: (header.home_facility_name as string | null) ?? null,
        is_case: (header.is_case as boolean | null) ?? null,
        case_status: (header.case_status as string | null) ?? null,
        dx_date: (header.dx_date as string | null) ?? null,
        last_visit: (header.last_encounter_date as string | null) ?? null,
        risk: risk
          ? {
              band: (risk.risk_band as string | null) ?? null,
              probability: (risk.ensemble_prob as number | null) ?? null,
              t1_score: (risk.t1_score as number | null) ?? null,
              rank_in_facility: (risk.rank_in_facility as number | null) ?? null,
              as_of: (risk.as_of as string | null) ?? null,
              scoped_since_flag: (risk.scoped_since_flag as boolean | null) ?? null,
              first_high_at: (risk.first_high_at as string | null) ?? null,
              top_reasons: (risk.top_reasons as unknown as RiskReason[]) ?? [],
            }
          : null,
        risk_history: history,
        timeline: {
          window: { start: startIso, end: end.toISOString().slice(0, 19), months: i.months },
          events: windowEvents,
          series: { hb: s.hb.filter(inWin), weight: s.weight.filter(inWin) },
        },
        labs: labSummaries(all),
        alerts,
        suggested_actions: actions,
        ...(i.focus ? { focus: i.focus } : {}),
        links: { case: `/doctor/case/${pid}`, api: `/api/v1/patients/${pid}` },
      };
      const parsed = PatientWidget.safeParse(widget);
      if (!parsed.success) return { ok: false, error: `widget validation failed: ${parsed.error.issues.slice(0, 3).map((x) => x.path.join(".") + " " + x.message).join("; ")}` };
      return parsed.data;
    } catch (e) {
      return notFound(e);
    }
  },
  modelView(w) {
    if (!("kind" in w)) return w;
    const abnormal = w.timeline.events.filter((e) => e.is_abnormal || e.highlight);
    return {
      ok: true,
      shown_to_user: "patient card",
      patient_id: w.patient_id,
      display_id: w.display_id,
      sex: w.sex,
      age: w.age,
      district_name: w.district_name,
      is_case: w.is_case,
      case_status: w.case_status,
      dx_date: w.dx_date,
      last_visit: w.last_visit,
      risk: w.risk && { ...w.risk, risk_pct: typeof w.risk.probability === "number" ? round(100 * w.risk.probability, 1) : null },
      risk_history_points: w.risk_history.length,
      timeline_window: w.timeline.window,
      n_events_in_window: w.timeline.events.length,
      abnormal_or_highlighted_events: abnormal.slice(-25),
      hb_series: w.timeline.series.hb,
      labs: w.labs,
      alerts: w.alerts.filter((a) => a.status === "NEW" || a.status === "ACKNOWLEDGED"),
      suggested_actions: w.suggested_actions,
    };
  },
});
