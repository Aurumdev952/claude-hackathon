"""Patient app API (docs/contracts/v3-loop.md §4.2): `X-Role: patient` + `X-Patient-Id`.

Every /me endpoint returns only the caller's own data. The given name appears only here (the patient's own app);
plans omit doctor notes and model fields, and results that would reveal a diagnosis are never sent.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from care import engine, journey as journey_mod, messages, pathways
from care.store import get_store

from ..deps import SERVE, APIError, Role, envelope, parse_json, patient, role
from .care import build_journey

router = APIRouter()
CHW = {"name": "CHW (Synthetic)", "phone": "+250 7xx xxx xxx"}
HIDDEN_PLAN = ("note", "model_id", "risk_at_approval", "band_at_approval", "propensity", "context", "source_alert_id",
               "trigger", "approved_by", "emr_encounter_id")
# Internal pathway and task codes can reveal a diagnosis (ONCOLOGY_TREATMENT, CHEMO_CYCLE, STAGING_CT, ...). The patient
# payload drops the pathway code (the friendly `pathway_name` stays) and replaces task types with neutral codes. The field
# name `type` is kept for the patient app (it keys the medicine-course tracker on HP_TREATMENT / IRON_COURSE, which are
# kept as they are).
PATIENT_TASK = {"ONCOLOGY_INTAKE": "SPECIALIST_VISIT", "STAGING_CT": "SCAN", "MDT_PLAN": "TEAM_PLAN", "SURGERY": "OPERATION",
                "CHEMO_CYCLE": "TREATMENT_CYCLE", "SURVEILLANCE_IMAGING": "SCAN", "PATHOLOGY_REVIEW": "LAB_REVIEW",
                "RESULT_DISCUSSED": "RESULTS_VISIT", "PAIN_REVIEW": "COMFORT_REVIEW"}


def patient_task_type(t: str | None) -> str | None:
    return PATIENT_TASK.get(t, t) if t else t


def patient_template_key(key: str | None) -> str | None:
    """`<pathway>.<task>.<stage>` -> `care.<neutral task>.<stage>` (no pathway code)."""
    if not key:
        return key
    parts = str(key).split(".")
    task, stage = (parts[1], parts[2]) if len(parts) >= 3 else (parts[0], parts[-1])
    return f"care.{patient_task_type(task)}.{stage}"


PATIENT_EVENTS = {"PLAN_CREATED", "TASK_CREATED", "TASK_OPENED", "NOTIFIED", "COMPLETED", "RESCHEDULED", "PATIENT_CONFIRMED",
                  "PATIENT_ACTED", "CHECKIN", "DOSE", "CHW_ASSIGNED", "PLAN_COMPLETED", "MISSED", "OVERDUE"}


def p(r: Role = Depends(role)) -> Role:
    return patient(r)


def _care_error(e: engine.CareError):
    raise APIError(e.status, e.code, e.message)


def _me_row(pid: int) -> dict:
    row = SERVE.one("""SELECT p.patient_id, p.display_id, p.given_name, p.home_facility_id, l.name AS facility_name
                       FROM pt_patient p LEFT JOIN core_dim_location l ON l.location_id = p.home_facility_id
                       WHERE p.patient_id = ?""", [pid])
    if not row:
        raise APIError(404, "NOT_FOUND", "Patient not found")
    return row


@router.get("/me")
def me(r: Role = Depends(p)):
    row = _me_row(r.patient_id)
    return envelope({"patient_id": row["patient_id"], "display_id": row["display_id"], "given_name": row["given_name"],
                     "facility": {"id": row["home_facility_id"], "name": row["facility_name"]}, "chw": CHW})


def _note(n: dict, first_name: str | None) -> dict:
    out = {k: n[k] for k in ("id", "plan_id", "task_id", "channel", "template_key", "title", "body", "created_sim",
                             "delivered_sim", "read_sim", "acted_sim")}
    out["template_key"] = patient_template_key(out["template_key"])
    if n["channel"] == "APP":
        out["greeting"] = messages.greeting(first_name)
    return out


@router.get("/me/notifications")
def my_notifications(r: Role = Depends(p)):
    row = _me_row(r.patient_id)
    items = [_note(n, row["given_name"]) for n in engine.notifications_for(r.patient_id)]
    return envelope(items, unread=sum(1 for n in items if not n["read_sim"] and n["channel"] == "APP"))


def _mark(pid: int, nid: str, field: str) -> dict:
    try:
        n = engine.mark_notification(pid, nid, field)
    except engine.CareError as e:
        _care_error(e)
    if n["channel"] not in ("APP", "SMS"):
        raise APIError(404, "NOT_FOUND", "Notification not found")
    return n


@router.post("/me/notifications/{notification_id}/read")
def read_notification(notification_id: str, r: Role = Depends(p)):
    row = _me_row(r.patient_id)
    return envelope(_note(_mark(r.patient_id, notification_id, "read_sim"), row["given_name"]))


@router.post("/me/notifications/{notification_id}/acted")
def acted_notification(notification_id: str, r: Role = Depends(p)):
    row = _me_row(r.patient_id)
    return envelope(_note(_mark(r.patient_id, notification_id, "acted_sim"), row["given_name"]))


def patient_plans(pid: int) -> list[dict]:
    names = {k: v["name"] for k, v in pathways.pathways().items()}
    out = []
    for pl in engine.plans_for(pid):
        q = {k: v for k, v in pl.items() if k not in HIDDEN_PLAN and k != "pathway"}
        q["pathway_name"] = names.get(pl["pathway"], "Care plan")
        fid = pl.get("target_facility_id") or pl.get("facility_id")
        loc = SERVE.one("SELECT name FROM core_dim_location WHERE location_id = ?", [fid]) if fid else None
        q["target_facility_name"] = (loc or {}).get("name")   # additive (U1): the next-step card names the facility
        q["tasks"] = [{k: t[k] for k in ("id", "plan_id", "seq", "title", "status", "opens_at", "due_at", "completed_at",
                                         "reminders")}
                      | {"type": patient_task_type(t["type"]), "patient_facing": pathways.patient_facing(pl["pathway"], t["type"])}
                      for t in pl["tasks"]]
        q["events"] = [{"id": e["id"], "task_id": e["task_id"], "kind": e["kind"], "actor": e["actor"], "sim_time": e["sim_time"]}
                       for e in pl["events"] if e["kind"] in PATIENT_EVENTS]
        out.append(q)
    return out


@router.get("/me/plan")
def my_plan(r: Role = Depends(p)):
    _me_row(r.patient_id)
    return envelope({"plans": patient_plans(r.patient_id)})


@router.get("/me/journey")
def my_journey(r: Role = Depends(p)):
    _me_row(r.patient_id)
    return envelope(journey_mod.for_patient_app(build_journey(r.patient_id)))


@router.post("/me/checkins", status_code=201)
def checkin(body: dict = Body(...), r: Role = Depends(p)):
    _me_row(r.patient_id)
    try:
        return envelope(engine.record_checkin(r.patient_id, body))
    except engine.CareError as e:
        _care_error(e)


@router.post("/me/doses", status_code=201)
def dose(body: dict = Body(...), r: Role = Depends(p)):
    _me_row(r.patient_id)
    try:
        return envelope(engine.record_dose(r.patient_id, body.get("course"), body.get("taken")))
    except engine.CareError as e:
        _care_error(e)


@router.get("/me/doses")
def my_doses(r: Role = Depends(p)):
    """The patient's own dose taps (newest first), for the medicines course tracker (additive, U1)."""
    _me_row(r.patient_id)
    rows = get_store().rows("""SELECT id, payload, created_sim FROM patient_reports WHERE patient_id = ? AND kind = 'DOSE'
                               ORDER BY created_sim DESC, id DESC""", [r.patient_id])
    out = []
    for x in rows:
        pl = parse_json(x["payload"]) or {}
        out.append({"id": x["id"], "course": pl.get("course"), "taken": bool(pl.get("taken")), "created_sim": x["created_sim"]})
    return envelope(out)


@router.post("/me/tasks/{task_id}/confirm", status_code=201)
def confirm(task_id: str, body: dict = Body(...), r: Role = Depends(p)):
    _me_row(r.patient_id)
    try:
        return envelope(engine.confirm_task(r.patient_id, task_id, body.get("text") or ""))
    except engine.CareError as e:
        _care_error(e)


@router.get("/patient-app/demo-patients")
def demo_patients():
    """Demo picker only (no role): display ids of patients with care plans. No names."""
    rows = get_store().rows("""SELECT p.patient_id, max(p.display_id) AS display_id, count(*) AS plan_count,
                                      EXISTS (SELECT 1 FROM notifications n WHERE n.patient_id = p.patient_id
                                              AND n.channel IN ('APP', 'SMS')) AS has_notifications,
                                      max(p.approved_at) AS last_approved
                               FROM care_plans p GROUP BY p.patient_id ORDER BY last_approved DESC""")
    return envelope([{"patient_id": x["patient_id"], "display_id": x["display_id"], "plan_count": x["plan_count"],
                      "has_notifications": bool(x["has_notifications"])} for x in rows])
