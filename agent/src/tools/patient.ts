/**
 * Doctor patient tools: ports of api/routers/patients.py (facility access check through pt_patient_facility, alert status
 * overlay from app_state.sqlite). Full objects (with the patient's name) go to the clinician's UI; the model only ever sees
 * the pseudonymised view (display_id + clinical data) through toModelOutput.
 */
import { z } from "zod";
import { alertStatuses } from "../db/appstate.js";
import { parseJson, SERVE, type RowObject } from "../db/duck.js";
import { round } from "./rates.js";
import { defineTool, type ToolCtx } from "./types.js";

export const STATUSES = ["NEW", "ACKNOWLEDGED", "REFERRED", "DISMISSED"] as const;

/** Patient reference accepted by every doctor tool: the internal id or the EMR display id. */
export const PatientRef = {
  patient_id: z.number().int().optional().describe("Internal patient_id from a previous tool result"),
  display_id: z.string().optional().describe("EMR identifier shown to clinicians, e.g. from list_high_risk_patients"),
};

export class PatientNotFound extends Error {}

export async function resolvePatient(t: ToolCtx, ref: { patient_id?: number; display_id?: string }): Promise<number> {
  const db = SERVE();
  let pid = ref.patient_id;
  if (pid === undefined && ref.display_id) {
    const r = await db.one("SELECT patient_id FROM pt_patient WHERE display_id = ?", [ref.display_id.trim()]);
    if (!r) throw new PatientNotFound(`No patient with display_id ${ref.display_id}`);
    pid = Number(r.patient_id);
  }
  if (pid === undefined) throw new PatientNotFound("Pass patient_id or display_id");
  const ok = await db.one("SELECT 1 AS ok FROM pt_patient_facility WHERE patient_id = ? AND facility_id = ?", [pid, t.ctx.facilityId]);
  if (!ok) throw new PatientNotFound("Patient not found at this facility");
  return pid;
}

export function notFound(e: unknown) {
  if (e instanceof PatientNotFound) return { ok: false as const, error: e.message };
  throw e;
}

export async function patientHeader(pid: number): Promise<RowObject> {
  const h = await SERVE().one(
    `SELECT p.*, d.name AS district_name, d.province, l.name AS home_facility_name FROM pt_patient p
     LEFT JOIN ref_district d ON d.district_code = p.district_code LEFT JOIN core_dim_location l ON l.location_id = p.home_facility_id
     WHERE p.patient_id = ?`,
    [pid],
  );
  if (!h) throw new PatientNotFound("Patient not found");
  const { given_name, family_name, ...rest } = h;
  return { ...rest, name: [given_name, family_name].filter(Boolean).join(" ") || null };
}

export interface RiskReasonRow {
  feature: string;
  label?: string | null;
  contribution?: number | null;
  value?: number | null;
}

export async function patientRisk(pid: number): Promise<RowObject | null> {
  const db = SERVE();
  if (!(await db.hasTable("pt_risk"))) return null;
  const r = await db.one("SELECT * FROM pt_risk WHERE patient_id = ?", [pid]);
  if (!r) return null;
  const reasons = (parseJson(r.top_reasons) as RiskReasonRow[] | null) ?? [];
  const attn = parseJson(r.t3_attention);
  return {
    ...r,
    ensemble_prob: round(r.ensemble_prob, 4),
    t2_prob: round(r.t2_prob, 4),
    t3_prob: round(r.t3_prob, 4),
    risk_pct: typeof r.ensemble_prob === "number" ? round(100 * r.ensemble_prob, 1) : null,
    top_reasons: (Array.isArray(reasons) ? reasons : []).map((x) => ({ ...x, contribution: round(x.contribution, 3), value: round(x.value, 2) })) as never,
    t3_attention: (Array.isArray(attn) ? attn : []) as never,
  };
}

/** Port of patients._alerts_for (alert rows + patient display id/name + status overlay). */
export async function alertsFor(where: string, params: unknown[]): Promise<RowObject[]> {
  const db = SERVE();
  if (!(await db.hasTable("pt_alerts"))) return [];
  const rows = await db.rows(
    `SELECT a.*, p.display_id, p.given_name || ' ' || p.family_name AS name FROM pt_alerts a
     JOIN pt_patient p ON p.patient_id = a.patient_id WHERE ${where} ORDER BY a.created_at DESC`,
    params,
  );
  const st = await alertStatuses(rows.map((a) => String(a.alert_id)));
  return rows.map((a) => {
    const s = st[String(a.alert_id)];
    const out: RowObject = { ...a, reasons: (parseJson(a.reasons) ?? []) as never };
    if (s) Object.assign(out, { status: s.status, note: s.note, status_updated_at: s.updated_at });
    return out;
  });
}

export const getPatient = defineTool({
  name: "get_patient",
  title: "Patient record",
  description:
    "Header of one patient at your facility (sex, age, district, home facility, cohort entry, case status, diagnosis date, last " +
    "visit) plus the current risk score (risk_band, risk_pct = 12-month probability %, top_reasons with SHAP contributions, " +
    "rank_in_facility, scoped_since_flag) and open alerts. Identify the patient by display_id or patient_id.",
  roles: ["doctor"],
  inputSchema: z.object(PatientRef),
  async execute(ref, t) {
    try {
      const pid = await resolvePatient(t, ref);
      const header = await patientHeader(pid);
      const risk = await patientRisk(pid);
      const alerts = (await alertsFor("a.patient_id = ?", [pid])).filter((a) => a.status === "NEW" || a.status === "ACKNOWLEDGED");
      return { ok: true, patient: header, risk, open_alerts: alerts.map(slimAlert) };
    } catch (e) {
      return notFound(e);
    }
  },
});

export function slimAlert(a: RowObject) {
  return {
    alert_id: a.alert_id, patient_id: a.patient_id, display_id: a.display_id, name: a.name, created_at: a.created_at,
    trigger: a.trigger, severity: a.severity, status: a.status, summary: a.summary, suggested_action: a.suggested_action,
  };
}

export const listHighRiskPatients = defineTool({
  name: "list_high_risk_patients",
  title: "High-risk patients",
  description:
    "Patients at your facility ranked by gastric cancer risk (port of the Doctor Workspace list). status 'flagged' = undiagnosed " +
    "patients with a risk score (default), 'diagnosed' = known cases, 'all'. Filter by risk_band (HIGH, MEDIUM, LOW) and " +
    "unscoped_only (HIGH risk with no endoscopy since first flagged). Each row: patient_id, display_id, sex, age, risk_band, " +
    "risk_pct, top 2 reasons, rank_in_facility, scoped_since_flag, open_alerts, last_visit.",
  roles: ["doctor"],
  inputSchema: z.object({
    risk_band: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
    status: z.enum(["flagged", "diagnosed", "all"]).default("flagged"),
    unscoped_only: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(10),
  }),
  async execute(i, t) {
    const db = SERVE();
    const hasRisk = await db.hasTable("pt_risk");
    const where = ["f.facility_id = ?"];
    const params: unknown[] = [t.ctx.facilityId];
    if (i.status === "flagged") where.push(`NOT p.is_case${hasRisk ? " AND rk.patient_id IS NOT NULL" : ""}`);
    else if (i.status === "diagnosed") where.push("p.is_case");
    if (i.risk_band && hasRisk) { where.push("rk.risk_band = ?"); params.push(i.risk_band); }
    if (i.unscoped_only && hasRisk) where.push("rk.risk_band = 'HIGH' AND NOT coalesce(rk.scoped_since_flag, FALSE)");
    const riskCols = hasRisk
      ? "rk.risk_band, rk.ensemble_prob, rk.t1_score, rk.top_reasons, rk.rank_in_facility, rk.scoped_since_flag"
      : "NULL AS risk_band, NULL AS ensemble_prob, NULL AS t1_score, NULL AS top_reasons, NULL AS rank_in_facility, NULL AS scoped_since_flag";
    const base = `FROM pt_patient_facility f JOIN pt_patient p ON p.patient_id = f.patient_id
                  ${hasRisk ? "LEFT JOIN pt_risk rk ON rk.patient_id = p.patient_id" : ""} WHERE ${where.join(" AND ")}`;
    const total = await db.one(`SELECT count(DISTINCT p.patient_id) AS n ${base}`, params);
    const order = hasRisk && i.status !== "diagnosed" ? "rk.ensemble_prob DESC NULLS LAST" : "p.dx_date DESC NULLS LAST";
    const rows = await db.rows(
      `SELECT p.patient_id, p.display_id, p.given_name || ' ' || p.family_name AS name, p.sex, p.age, p.district_code,
              p.is_case, p.case_status, p.dx_date, p.last_encounter_date AS last_visit, ${riskCols}
       ${base} ORDER BY ${order} LIMIT ?`,
      [...params, i.limit],
    );
    const ids = rows.map((x) => Number(x.patient_id));
    const open = new Map<number, number>();
    if (ids.length) {
      for (const a of await alertsFor(`a.patient_id IN (${ids.map(() => "?").join(",")})`, ids)) {
        if (a.status === "NEW" || a.status === "ACKNOWLEDGED") open.set(Number(a.patient_id), (open.get(Number(a.patient_id)) ?? 0) + 1);
      }
    }
    const out = rows.map((x) => ({
      ...x,
      ensemble_prob: round(x.ensemble_prob, 4),
      risk_pct: typeof x.ensemble_prob === "number" ? round(100 * x.ensemble_prob, 1) : null,
      top_reasons: ((parseJson(x.top_reasons) as RiskReasonRow[] | null) ?? []).slice(0, 2).map((r) => r.label ?? r.feature) as never,
      open_alerts: open.get(Number(x.patient_id)) ?? 0,
    }));
    return { ok: true, facility_id: t.ctx.facilityId, total: total?.n ?? out.length, dataset_id: t.datasets.register("list_high_risk_patients", out), rows: out };
  },
});

export const listAlerts = defineTool({
  name: "list_alerts",
  title: "Alerts",
  description:
    "Alerts for patients of your facility (port of GET /alerts): trigger RISK_BAND_HIGH, ALARM_NO_SCOPE_90D, HB_DROP or " +
    "HP_POS_UNTREATED; severity HIGH / MEDIUM; status NEW, ACKNOWLEDGED, REFERRED, DISMISSED (overlay of clinician actions); " +
    "summary and suggested_action. Default: open alerts (NEW + ACKNOWLEDGED), newest first.",
  roles: ["doctor"],
  inputSchema: z.object({
    status: z.enum(["open", ...STATUSES, "all"]).default("open"),
    severity: z.enum(["HIGH", "MEDIUM"]).optional(),
    trigger: z.enum(["RISK_BAND_HIGH", "ALARM_NO_SCOPE_90D", "HB_DROP", "HP_POS_UNTREATED", "CARE_OVERDUE"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async execute(i, t) {
    let rows = await alertsFor("a.patient_id IN (SELECT patient_id FROM pt_patient_facility WHERE facility_id = ?)", [t.ctx.facilityId]);
    if (i.status === "open") rows = rows.filter((a) => a.status === "NEW" || a.status === "ACKNOWLEDGED");
    else if (i.status !== "all") rows = rows.filter((a) => a.status === i.status);
    if (i.severity) rows = rows.filter((a) => a.severity === i.severity);
    if (i.trigger) rows = rows.filter((a) => a.trigger === i.trigger);
    const counts: Record<string, number> = {};
    for (const a of rows) counts[`${a.severity}`] = (counts[`${a.severity}`] ?? 0) + 1;
    const out = rows.slice(0, i.limit).map(slimAlert);
    return { ok: true, total: rows.length, by_severity: counts, dataset_id: t.datasets.register("list_alerts", out as RowObject[]), rows: out };
  },
});
