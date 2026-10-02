/**
 * v3 care coordination tools for the doctor (plan §2, §8; contract docs/contracts/v3-loop.md §4).
 *
 * Reads go to the FastAPI first (live care.sqlite state, so a plan approved a minute ago is visible) and fall back to the
 * published serve DB snapshot (pt_care_plan / pt_care_task / care_events, pt_journey / pt_recovery) when the API is not
 * reachable. Every patient goes through the facility access check first (resolvePatient).
 *
 * draft_care_plan only renders a preview (POST /care/notifications/preview). No agent tool creates a plan, changes a
 * task or sends a notification: the doctor approves in the UI ("Approve & plan").
 */
import { z } from "zod";
import { SERVE, parseJson, type RowObject } from "../db/duck.js";
import { api, upstreamMessage, UpstreamError } from "../lib/upstream.js";
import { alertsFor, notFound, PatientRef, resolvePatient } from "./patient.js";
import { round } from "./rates.js";
import { defineTool, type ToolCtx } from "./types.js";

export const PATHWAYS = [
  "ENDOSCOPY_REFERRAL", "HP_TEST_AND_TREAT", "ANAEMIA_WORKUP", "ONCOLOGY_TREATMENT", "SURVIVORSHIP", "PALLIATIVE_SUPPORT",
] as const;
export type Pathway = (typeof PATHWAYS)[number];

/** Alert trigger -> pathway (same mapping as care/pathways.py TRIGGER_PATHWAY). */
export const TRIGGER_PATHWAY: Record<string, Pathway> = {
  ALARM_NO_SCOPE_90D: "ENDOSCOPY_REFERRAL",
  RISK_BAND_HIGH: "ENDOSCOPY_REFERRAL",
  HB_DROP: "ANAEMIA_WORKUP",
  HP_POS_UNTREATED: "HP_TEST_AND_TREAT",
};
const TRIGGER_ORDER = ["ALARM_NO_SCOPE_90D", "RISK_BAND_HIGH", "HB_DROP", "HP_POS_UNTREATED"];

const OPEN_TASK = new Set(["SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED"]);
const LATE_TASK = new Set(["OVERDUE", "ESCALATED"]);
export const APPROVAL_NOTE =
  "This is a draft only: nothing was created and no message was sent. To start the plan, review it in the case screen " +
  "and click Approve & plan. The patient is contacted only after the doctor approves.";

const ts = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).replace(" ", "T").slice(0, 19));

function slimTask(t: RowObject) {
  const ev = parseJson(t.evidence as never) as Record<string, unknown> | null | string | undefined;
  return {
    id: t.id, seq: t.seq, type: t.type, title: t.title, status: t.status, opens_at: ts(t.opens_at), due_at: ts(t.due_at),
    completed_at: ts(t.completed_at), result: t.result ?? null, reminders: t.reminders ?? 0, escalation_level: t.escalation_level ?? 0,
    occurrence: t.occurrence ?? null,
    evidence: ev && typeof ev === "object" ? { table: ev.table ?? null, id: ev.id ?? null, concept_id: ev.concept_id ?? null, date: ev.date ?? null } : null,
  };
}

function slimEvent(e: RowObject) {
  const d = parseJson(e.detail as never);
  return { kind: e.kind, sim_time: ts(e.sim_time), actor: e.actor, task_id: e.task_id ?? null, detail: d && typeof d === "object" ? d : null };
}

function slimPlan(p: RowObject, tasks: RowObject[], events: RowObject[], maxEvents: number) {
  const ch = parseJson(p.channels as never);
  return {
    id: p.id, pathway: p.pathway, status: p.status, trigger: p.trigger ?? null, source_alert_id: p.source_alert_id ?? null,
    approved_at: ts(p.approved_at), closed_at: ts(p.closed_sim), channels: Array.isArray(ch) ? ch : [],
    target_facility_id: p.target_facility_id ?? null, risk_at_approval: round(p.risk_at_approval, 4),
    band_at_approval: p.band_at_approval ?? null, model_id: p.model_id ?? null, note: p.note ?? null,
    tasks: tasks.map(slimTask),
    events: events.slice(-maxEvents).map(slimEvent),
  };
}

type PlanView = ReturnType<typeof slimPlan>;

function summarise(plans: PlanView[]) {
  const tasks = plans.flatMap((p) => p.tasks.map((t) => ({ ...t, pathway: p.pathway, plan_id: p.id })));
  const open = tasks.filter((t) => OPEN_TASK.has(String(t.status)));
  const next = open.filter((t) => t.due_at).sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))[0];
  return {
    n_plans: plans.length,
    active_plans: plans.filter((p) => p.status === "ACTIVE" || p.status === "ESCALATED").length,
    open_tasks: open.length,
    overdue_tasks: open.filter((t) => LATE_TASK.has(String(t.status))).length,
    completed_tasks: tasks.filter((t) => t.status === "COMPLETED").length,
    next_due: next ? { title: next.title, type: next.type, due_at: next.due_at, status: next.status, pathway: next.pathway } : null,
  };
}

async function displayId(pid: number): Promise<string | null> {
  return ((await SERVE().one("SELECT display_id FROM pt_patient WHERE patient_id = ?", [pid]))?.display_id as string) ?? null;
}

async function snapshotPlans(pid: number, maxEvents: number): Promise<PlanView[] | null> {
  const db = SERVE();
  const planTable = (await db.hasTable("pt_care_plan")) ? "pt_care_plan" : (await db.hasTable("care_plans")) ? "care_plans" : null;
  if (!planTable) return null;
  const taskTable = (await db.hasTable("pt_care_task")) ? "pt_care_task" : "care_tasks";
  const plans = await db.rows(`SELECT * FROM ${planTable} WHERE patient_id = ? ORDER BY approved_at DESC`, [pid]);
  const out: PlanView[] = [];
  for (const p of plans) {
    const tasks = (await db.hasTable(taskTable)) ? await db.rows(`SELECT * FROM ${taskTable} WHERE plan_id = ? ORDER BY seq, opens_at`, [p.id]) : [];
    const events = (await db.hasTable("care_events")) ? await db.rows("SELECT * FROM care_events WHERE plan_id = ? ORDER BY id", [p.id]) : [];
    out.push(slimPlan(p, tasks, events, maxEvents));
  }
  return out;
}

export const getCarePlan = defineTool({
  name: "get_care_plan",
  title: "Care plan",
  description:
    "Care plans of one patient at your facility (v3 care coordination): pathway (ENDOSCOPY_REFERRAL, HP_TEST_AND_TREAT, " +
    "ANAEMIA_WORKUP, ONCOLOGY_TREATMENT, SURVIVORSHIP, PALLIATIVE_SUPPORT), status, approval date, channels, every task " +
    "(type, title, status SCHEDULED/DUE/NOTIFIED/COMPLETED/OVERDUE/ESCALATED/CANCELLED/DECLINED, due date, completion date, " +
    "result, reminders sent, escalation level 0 none / 1 SMS / 2 CHW / 3 doctor, EMR evidence) and the latest audit events. " +
    "summary gives open / overdue / completed task counts and the next due task. Read-only.",
  roles: ["doctor"],
  inputSchema: z.object({
    ...PatientRef,
    max_events: z.number().int().min(0).max(50).default(12).describe("Latest audit events per plan"),
  }),
  async execute(i, t) {
    try {
      const pid = await resolvePatient(t, i);
      let plans: PlanView[] | null = null;
      let source: "live" | "snapshot" = "live";
      let liveError: string | undefined;
      try {
        const { data } = await api<{ plans: RowObject[] }>(t.ctx, `/patients/${pid}/care`);
        plans = (data?.plans ?? []).map((p) => slimPlan(p, (p.tasks as unknown as RowObject[]) ?? [], (p.events as unknown as RowObject[]) ?? [], i.max_events));
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 403) return { ok: false, error: e.message };
        liveError = (e as Error).message;
        source = "snapshot";
        plans = await snapshotPlans(pid, i.max_events);
      }
      if (plans === null) return { ok: false, error: "Care coordination data is not published yet (no care_* tables) and the API is unreachable" };
      const tasks = plans.flatMap((p) => p.tasks.map((x) => ({
        plan_id: p.id, pathway: p.pathway, seq: x.seq, type: x.type, title: x.title, status: x.status, due_at: x.due_at,
        completed_at: x.completed_at, result: x.result, reminders: x.reminders, escalation_level: x.escalation_level,
      })));
      return {
        ok: true, patient_id: pid, display_id: await displayId(pid), source,
        ...(source === "snapshot" ? { note: `Published snapshot (API unavailable: ${liveError?.slice(0, 120)}); plans approved since the last pipeline run are missing.` } : {}),
        summary: summarise(plans),
        plans,
        dataset_id: t.datasets.register("get_care_plan", tasks as RowObject[]),
        rows: tasks,
      };
    } catch (e) {
      return notFound(e);
    }
  },
  modelView(o) {
    // doctor notes are free text: they stay on the clinician's screen
    if (!o || typeof o !== "object" || !("plans" in o) || !Array.isArray(o.plans)) return o;
    return { ...o, plans: o.plans.map(({ note: _n, ...p }) => p) };
  },
});

// ------------------------------------------------------------------------------------------------ worklist
interface WorkItem {
  task: RowObject;
  plan: RowObject;
  patient: RowObject;
  p_adhere: number | null;
  priority: number | null;
}

function flatWork(w: WorkItem) {
  return {
    task_id: w.task.id, plan_id: w.plan.id, patient_id: w.patient.patient_id ?? w.task.patient_id, display_id: w.patient.display_id ?? null,
    given_name: w.patient.given_name ?? null, family_name: w.patient.family_name ?? null,
    age: w.patient.age ?? null, sex: w.patient.sex ?? null, pathway: w.plan.pathway, task_type: w.task.type, title: w.task.title,
    status: w.task.status, due_at: ts(w.task.due_at), overdue_days: w.task.overdue_days ?? 0, reminders: w.task.reminders ?? 0,
    escalation_level: w.task.escalation_level ?? 0, p_adhere: round(w.p_adhere, 3), priority: round(w.priority, 3),
  };
}

async function snapshotWorklist(facilityId: number): Promise<ReturnType<typeof flatWork>[] | null> {
  const db = SERVE();
  if (!(await db.hasTable("pt_care_task"))) return null;
  const meta = db.meta();
  const now = meta.sim_time ? String(meta.sim_time) : null;
  const rows = await db.rows(
    `SELECT t.*, p.age, p.sex FROM pt_care_task t LEFT JOIN pt_patient p ON p.patient_id = t.patient_id
     WHERE t.status IN ('DUE','NOTIFIED','OVERDUE','ESCALATED') AND (t.facility_id = ? OR t.target_facility_id = ?)`,
    [facilityId, facilityId],
  );
  return rows.map((r) => {
    const overdue = now && r.due_at ? Math.max(0, Math.floor((Date.parse(now.replace(" ", "T") + "Z") - Date.parse(String(r.due_at).replace(" ", "T") + "Z")) / 86_400_000)) : 0;
    return flatWork({
      task: { ...r, overdue_days: overdue }, plan: { id: r.plan_id, pathway: r.pathway }, patient: { patient_id: r.patient_id, display_id: r.display_id, age: r.age, sex: r.sex },
      p_adhere: null, priority: null,
    });
  });
}

const lateFirst = (a: { status: unknown; priority: number | null; overdue_days: unknown; due_at: string | null }, b: typeof a) =>
  Number(LATE_TASK.has(String(b.status))) - Number(LATE_TASK.has(String(a.status))) ||
  (b.priority ?? -1) - (a.priority ?? -1) ||
  Number(b.overdue_days ?? 0) - Number(a.overdue_days ?? 0) ||
  String(a.due_at).localeCompare(String(b.due_at));

export const listFollowups = defineTool({
  name: "list_followups",
  title: "Follow-up worklist",
  description:
    "The facility's care follow-up worklist (GET /care/worklist): open care tasks (DUE, NOTIFIED, OVERDUE, ESCALATED) of " +
    "approved plans, OVERDUE and ESCALATED first, then by priority. Each row: display_id, age, sex, pathway, task_type, " +
    "title, status, due_at, overdue_days, reminders, escalation_level, p_adhere (predicted probability the patient completes " +
    "the task; low = needs outreach such as a CHW visit first) and priority. Use for 'who needs follow-up', 'overdue tasks', " +
    "'who should the CHW visit first'.",
  roles: ["doctor"],
  inputSchema: z.object({
    status: z.enum(["open", "overdue"]).default("open").describe("overdue = OVERDUE + ESCALATED only"),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async execute(i, t) {
    let rows: ReturnType<typeof flatWork>[] | null;
    let source: "live" | "snapshot" = "live";
    let liveError: string | undefined;
    try {
      const { data } = await api<WorkItem[]>(t.ctx, "/care/worklist");
      rows = (data ?? []).map(flatWork);
    } catch (e) {
      liveError = (e as Error).message;
      source = "snapshot";
      rows = await snapshotWorklist(t.ctx.facilityId as number);
    }
    if (rows === null) return { ok: false, error: "Care coordination data is not published yet and the API is unreachable" };
    rows.sort(lateFirst);
    const all = rows;
    if (i.status === "overdue") rows = rows.filter((r) => LATE_TASK.has(String(r.status)));
    const by_status: Record<string, number> = {};
    for (const r of all) by_status[String(r.status)] = (by_status[String(r.status)] ?? 0) + 1;
    const out = rows.slice(0, i.limit);
    return {
      ok: true, facility_id: t.ctx.facilityId, source, total_open: all.length, overdue: all.filter((r) => LATE_TASK.has(String(r.status))).length,
      by_status,
      ...(source === "snapshot" ? { note: `Published snapshot (API unavailable: ${liveError?.slice(0, 120)}); p_adhere needs the API.` } : {}),
      dataset_id: t.datasets.register("list_followups", out as RowObject[]),
      rows: out,
    };
  },
});

// ------------------------------------------------------------------------------------------------ journey
type Phase = { phase: unknown; start: unknown; end: unknown; status: unknown; milestones: unknown };

function slimPhases(phases: Phase[]) {
  return phases.map((p) => {
    const ms = (Array.isArray(p.milestones) ? p.milestones : parseJson(p.milestones as never)) as unknown;
    const list = Array.isArray(ms) ? (ms as Record<string, unknown>[]) : [];
    return {
      phase: p.phase, start: p.start ? String(p.start).slice(0, 10) : null, end: p.end ? String(p.end).slice(0, 10) : null, status: p.status,
      milestones: list.slice(-8).map((m) => ({ date: m.date ? String(m.date).slice(0, 10) : null, label: m.label ?? null, kind: m.kind ?? null })),
      n_milestones: list.length,
    };
  });
}

const SERIES_KEYS = ["weight", "hb", "b12", "albumin", "ecog"] as const;

function recoveryRows(series: Record<string, unknown> | null | undefined): RowObject[] {
  const out: RowObject[] = [];
  for (const k of SERIES_KEYS) {
    const s = series?.[k];
    if (!Array.isArray(s)) continue;
    for (const pt of s as Record<string, unknown>[]) {
      const date = pt.date ?? pt.ts ?? pt.as_of;
      const value = typeof pt.value === "number" ? pt.value : typeof pt.v === "number" ? pt.v : null;
      if (date) out.push({ date: String(date).slice(0, 10), metric: k, value: round(value, 2) });
    }
  }
  return out;
}

function recoverySummary(r: Record<string, unknown> | null | undefined) {
  if (!r) return null;
  const pick = (k: string) => (r[k] === undefined ? null : r[k]);
  return {
    dx_date: pick("dx_date"), intent: pick("intent"), gastrectomy: pick("gastrectomy"),
    weight_change_pct: round(pick("weight_change_pct"), 1), weight_last: round(pick("weight_last"), 1), hb_last: round(pick("hb_last"), 1),
    b12_last: round(pick("b12_last"), 0), albumin_last: round(pick("albumin_last"), 1), ecog_last: pick("ecog_last"),
    chemo_done: pick("chemo_done"), chemo_planned: pick("chemo_planned"), missed_visits_12m: pick("missed_visits_12m"),
    recurrence: pick("recurrence"), next_visit_due: pick("next_visit_due") ? String(pick("next_visit_due")).slice(0, 10) : null,
  };
}

export const getPatientJourney = defineTool({
  name: "get_patient_journey",
  title: "Patient journey",
  description:
    "Journey of one patient at your facility (v3): phases Flagged, Approved, Notified, Seen, Endoscopy, Diagnosis, Staging, " +
    "Treatment, Recovery, Surveillance, Survivorship, Palliative, Deceased with start / end dates, status (done, current, " +
    "upcoming, missed) and milestones; for diagnosed patients the recovery summary (treatment intent, gastrectomy, weight " +
    "change since surgery, latest Hb, B12, albumin, ECOG, chemo cycles done / planned, missed visits, recurrence, next visit " +
    "due). `rows` (dataset_id) are the recovery series (date, metric weight/hb/b12/albumin/ecog, value) for a line chart.",
  roles: ["doctor"],
  inputSchema: z.object(PatientRef),
  async execute(ref, t) {
    try {
      const pid = await resolvePatient(t, ref);
      let phases: Phase[] = [];
      let recovery: Record<string, unknown> | null = null;
      let source = "live";
      try {
        const { data } = await api<{ phases: Phase[]; recovery: Record<string, unknown> | null; source?: string }>(t.ctx, `/patients/${pid}/journey`);
        phases = data?.phases ?? [];
        const rec = data?.recovery ?? null;
        recovery = rec ? { ...(rec.summary as Record<string, unknown> | undefined ?? {}), ...rec } : null;
        source = data?.source ? `api:${data.source}` : "live";
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 403) return { ok: false, error: e.message };
        source = "snapshot";
        const db = SERVE();
        if (!(await db.hasTable("pt_journey"))) return { ok: false, error: "Journey data is not published yet and the API is unreachable" };
        phases = (await db.rows("SELECT phase, start_date AS start, end_date AS \"end\", status, milestones FROM pt_journey WHERE patient_id = ? ORDER BY seq", [pid])) as Phase[];
        const rec = (await db.hasTable("pt_recovery")) ? await db.one("SELECT * FROM pt_recovery WHERE patient_id = ?", [pid]) : null;
        recovery = rec ? { ...rec, series: parseJson(rec.series) } : null;
      }
      const slim = slimPhases(phases);
      const current = slim.find((p) => p.status === "current") ?? null;
      const series = recoveryRows((recovery?.series as Record<string, unknown> | undefined) ?? null);
      return {
        ok: true, patient_id: pid, display_id: await displayId(pid), source,
        current_phase: current?.phase ?? null,
        phases: slim,
        recovery: recoverySummary(recovery),
        dataset_id: t.datasets.register("get_patient_journey", series),
        rows: series,
      };
    } catch (e) {
      return notFound(e);
    }
  },
});

// ------------------------------------------------------------------------------------------------ draft (preview only)
async function suggestPathway(pid: number): Promise<{ pathway: Pathway; rationale: string; alert_id: string | null } | null> {
  const open = (await alertsFor("a.patient_id = ?", [pid])).filter((a) => a.status === "NEW" || a.status === "ACKNOWLEDGED");
  for (const trig of TRIGGER_ORDER) {
    const a = open.find((x) => x.trigger === trig);
    if (a) return { pathway: TRIGGER_PATHWAY[trig], rationale: `Open ${trig} alert (${a.severity}): ${a.summary ?? ""}`.trim(), alert_id: String(a.alert_id) };
  }
  const db = SERVE();
  const p = await db.one("SELECT is_case, dead FROM pt_patient WHERE patient_id = ?", [pid]);
  if (p?.is_case && !p.dead) {
    const rec = (await db.hasTable("pt_recovery")) ? await db.one("SELECT intent, gastrectomy FROM pt_recovery WHERE patient_id = ?", [pid]) : null;
    const intent = String(rec?.intent ?? "").toUpperCase();
    if (/PALL|BEST SUPPORTIVE|^BSC$/.test(intent)) return { pathway: "PALLIATIVE_SUPPORT", rationale: `Diagnosed, treatment intent ${rec?.intent}`, alert_id: null };
    if (rec?.gastrectomy) return { pathway: "SURVIVORSHIP", rationale: "Diagnosed and treated with curative gastrectomy", alert_id: null };
    return { pathway: "ONCOLOGY_TREATMENT", rationale: "Diagnosed; no treatment plan recorded yet", alert_id: null };
  }
  if (await db.hasTable("pt_risk")) {
    const r = await db.one("SELECT risk_band FROM pt_risk WHERE patient_id = ?", [pid]);
    if (r?.risk_band === "HIGH") return { pathway: "ENDOSCOPY_REFERRAL", rationale: "Risk band HIGH (no open alert)", alert_id: null };
  }
  return null;
}

export const draftCarePlan = defineTool({
  name: "draft_care_plan",
  title: "Draft care plan (preview only)",
  description:
    "Drafts a care plan for one patient for the doctor to review: suggests a pathway (from the open alert, diagnosis or risk " +
    "band unless `pathway` is given), the task schedule (types, titles, due dates) and the patient message preview per channel " +
    "(APP / SMS / CHW). It NEVER creates a plan and NEVER sends anything: only the doctor can approve the plan in the case " +
    "screen (Approve & plan), and only then is the patient notified. Use it when asked to plan, refer, follow up or contact " +
    "a patient, then tell the doctor to approve in the UI.",
  roles: ["doctor"],
  inputSchema: z.object({
    ...PatientRef,
    pathway: z.enum(PATHWAYS).optional().describe("Leave empty to let the tool suggest one"),
    channels: z.array(z.enum(["APP", "SMS", "CHW"])).min(1).max(3).optional().describe("Default: the pathway's channels"),
    due_override: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe("ISO date for the first task, if the doctor asked for one"),
  }),
  async execute(i, t) {
    try {
      const pid = await resolvePatient(t, i);
      const suggestion = i.pathway ? { pathway: i.pathway, rationale: "Pathway chosen by the doctor", alert_id: null } : await suggestPathway(pid);
      if (!suggestion) {
        return { ok: false, error: "No pathway to suggest (no open alert, not HIGH risk, not diagnosed). Pass `pathway` explicitly.", pathways: PATHWAYS };
      }
      const existing = await activePlans(t, pid, suggestion.pathway);
      let preview: { pathway?: string; target_facility?: { id: number; name: string }; tasks?: RowObject[]; messages?: RowObject[] };
      try {
        const body: Record<string, unknown> = { patient_id: pid, pathway: suggestion.pathway };
        if (suggestion.alert_id) body.alert_id = suggestion.alert_id;
        if (i.channels) body.channels = i.channels;
        if (i.due_override) body.due_override = i.due_override;
        preview = (await api<typeof preview>(t.ctx, "/care/notifications/preview", { method: "POST", body })).data ?? {};
      } catch (e) {
        return { ...upstreamMessage(e), draft: true, approved: false, suggested_pathway: suggestion.pathway, rationale: suggestion.rationale, approval: APPROVAL_NOTE };
      }
      const tasks = (preview.tasks ?? []).map((x) => ({ seq: x.seq, type: x.type, title: x.title, status: x.status, opens_at: ts(x.opens_at), due_at: ts(x.due_at) }));
      // the APP greeting carries the patient's given name: it belongs to the patient's own app only (never the agent)
      const messages = (preview.messages ?? []).map((m) => ({ channel: m.channel, title: m.title ?? null, body: m.body ?? null }));
      const dId = await displayId(pid);
      return {
        ok: true, draft: true, approved: false, created: false, notifications_sent: 0,
        patient_id: pid, display_id: dId, pathway: preview.pathway ?? suggestion.pathway, rationale: suggestion.rationale,
        source_alert_id: suggestion.alert_id, target_facility: preview.target_facility ?? null,
        existing_active_plans: existing,
        tasks, messages,
        approval: APPROVAL_NOTE,
        links: { case: `/doctor/case/${pid}` },
        dataset_id: t.datasets.register("draft_care_plan", tasks as RowObject[]),
        rows: tasks,
      };
    } catch (e) {
      return notFound(e);
    }
  },
});

async function activePlans(t: ToolCtx, pid: number, pathway: string): Promise<{ id: unknown; pathway: unknown; status: unknown }[]> {
  try {
    const { data } = await api<{ plans: RowObject[] }>(t.ctx, `/patients/${pid}/care`);
    return (data?.plans ?? []).filter((p) => p.status === "ACTIVE" || p.status === "ESCALATED")
      .map((p) => ({ id: p.id, pathway: p.pathway, status: p.status, same_pathway: p.pathway === pathway }));
  } catch {
    return [];
  }
}
