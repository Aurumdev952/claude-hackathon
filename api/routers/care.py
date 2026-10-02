"""Care coordination API (docs/contracts/v3-loop.md §4.2): doctor care plans and follow-ups, ministry aggregates.

Doctor routes need X-Role: doctor + X-Facility-Id and only reach patients linked to that facility (pt_patient_facility)
or plans approved at / targeted to it. Ministry routes return suppressed aggregates (n < 5 -> null + "<5").
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from care import engine, journey as journey_mod, pathways
from care.store import get_store

from ..deps import SERVE, APIError, Role, doctor, envelope, ministry, parse_json, role
from ..suppress import suppress_breakdowns, suppress_group, suppress_row

router = APIRouter()


def d(r: Role = Depends(role)) -> Role:
    return doctor(r)


def m(r: Role = Depends(role)) -> Role:
    return ministry(r)


def _care_error(e: engine.CareError):
    raise APIError(e.status, e.code, e.message)


def check_access(patient_id: int, r: Role):
    """403 unless the patient is linked to the doctor's facility or has a care plan approved at / targeted to it."""
    ok = SERVE.one("SELECT 1 AS ok FROM pt_patient_facility WHERE patient_id = ? AND facility_id = ?", [patient_id, r.facility_id])
    if ok:
        return
    if get_store().one("SELECT 1 AS ok FROM care_plans WHERE patient_id = ? AND (facility_id = ? OR target_facility_id = ?)",
                       [patient_id, r.facility_id, r.facility_id]):
        return
    raise APIError(403, "FORBIDDEN", "This patient is not linked to your facility")


# ------------------------------------------------------------------------------------------------ doctor
@router.get("/care/pathways")
def get_pathways(r: Role = Depends(role)):
    """Pathway templates (configuration, no patient data): doctor and ministry."""
    if r.role == "patient":
        raise APIError(403, "FORBIDDEN", "Not available in the patient app")
    cfg = pathways.config()
    return envelope([pathways.public(pid) for pid in pathways.pathways()], ladder=cfg["ladder"], sources=cfg.get("sources", {}),
                    trigger_pathway=pathways.TRIGGER_PATHWAY)


def _body_pid(body: dict) -> int:
    try:
        return int(body["patient_id"])
    except (KeyError, TypeError, ValueError):
        raise APIError(400, "INVALID_REQUEST", "patient_id is required") from None


@router.post("/care/notifications/preview")
def preview(body: dict = Body(...), r: Role = Depends(d)):
    pid = _body_pid(body)
    check_access(pid, r)
    try:
        out = engine.preview(pid, body.get("pathway") or "", due_override=body.get("due_override"), channels=body.get("channels"),
                             facility_id=r.facility_id, target_facility_id=body.get("target_facility_id"),
                             alert_id=body.get("alert_id"))
    except engine.CareError as e:
        _care_error(e)
    return envelope(out)


@router.post("/care/plans", status_code=201)
def create_plan(body: dict = Body(...), r: Role = Depends(d)):
    pid = _body_pid(body)
    check_access(pid, r)
    note = body.get("note")
    if note is not None and len(str(note)) > 2000:
        raise APIError(400, "INVALID_NOTE", "note must be at most 2000 characters")
    try:
        out = engine.create_plan(pid, r.facility_id, body.get("pathway") or "", alert_id=body.get("alert_id"),
                                 due_override=body.get("due_override"), channels=body.get("channels"),
                                 target_facility_id=body.get("target_facility_id"), note=note, actor="doctor")
    except engine.CareError as e:
        _care_error(e)
    return envelope(out)


@router.get("/care/plans")
def list_plans(status: str | None = None, r: Role = Depends(d)):
    return envelope({"plans": engine.plans_for(facility_id=r.facility_id, status=status)})


@router.get("/patients/{patient_id}/care")
def patient_care(patient_id: int, r: Role = Depends(d)):
    check_access(patient_id, r)
    return envelope({"plans": engine.plans_for(patient_id), "suggested_next": engine.suggestions(patient_id=patient_id)})


@router.get("/care/suggestions")
def care_suggestions(r: Role = Depends(d)):
    """Open next-plan suggestions for the doctor's facility (a suggestion is never a plan: the doctor starts it)."""
    return envelope(engine.suggestions(facility_id=r.facility_id))


@router.patch("/care/tasks/{task_id}")
def patch_task(task_id: str, body: dict = Body(...), r: Role = Depends(d)):
    t = get_store().one("SELECT patient_id FROM care_tasks WHERE id = ?", [task_id])
    if not t:
        raise APIError(404, "NOT_FOUND", "Task not found")
    check_access(int(t["patient_id"]), r)
    try:
        out = engine.patch_task(task_id, body.get("action") or "", reason=body.get("reason"), due_at=body.get("due_at"),
                                result=body.get("result"), actor="doctor")
    except engine.CareError as e:
        _care_error(e)
    return envelope(out)


@router.get("/care/worklist")
def worklist(r: Role = Depends(d)):
    return envelope(engine.worklist(r.facility_id))


@router.get("/patients/{patient_id}/journey")
def patient_journey(patient_id: int, r: Role = Depends(d)):
    check_access(patient_id, r)
    return envelope(build_journey(patient_id))


def build_journey(patient_id: int) -> dict:
    """pt_journey + pt_recovery from the serve DB; computed live when the tables are absent or older than the patient's
    latest care-plan change."""
    store = get_store()
    # stale when a care event was written after the serve DB was published (e.g. a plan approved a minute ago): the
    # published pt_journey cannot contain it yet. Both stamps are UTC ISO strings ending in Z, so they compare as text.
    last_change = store.one("SELECT max(wall_time) AS t FROM care_events WHERE patient_id = ?", [patient_id])
    published = SERVE.meta().get("published_at") or ""
    stale = bool(last_change and last_change["t"] and str(last_change["t"]) > str(published))
    if SERVE.has_table("pt_journey") and SERVE.has_table("pt_recovery") and not stale:
        ph = SERVE.rows("SELECT phase, start_date, end_date, status, milestones FROM pt_journey WHERE patient_id = ? ORDER BY seq",
                        [patient_id])
        phases = [{"phase": p["phase"], "start": p["start_date"], "end": p["end_date"], "status": p["status"],
                   "milestones": parse_json(p["milestones"]) or []} for p in ph]
        rec = SERVE.one("SELECT * FROM pt_recovery WHERE patient_id = ?", [patient_id])
        if rec is not None:
            rec["series"] = parse_json(rec.get("series")) or {}
        return {"phases": phases, "recovery": _recovery_shape(rec), "source": "pt_journey"}
    j = live_journey(patient_id)
    return {"phases": j["phases"], "recovery": _recovery_shape(j["recovery"]), "source": "live"}


def live_journey(patient_id: int) -> dict:
    pt = SERVE.one("SELECT patient_id, is_case, dx_date, dead, death_date FROM pt_patient WHERE patient_id = ?", [patient_id])
    if not pt:
        raise APIError(404, "NOT_FOUND", "Patient not found")
    ev = SERVE.rows("""SELECT ts, event_type, concept_id, label, value_num, encounter_id FROM pt_timeline WHERE patient_id = ?
                       AND (event_type IN ('VISIT', 'ENDOSCOPY', 'STAGING') OR (event_type = 'VITAL' AND concept_id = 3000)
                            OR (event_type = 'LAB' AND concept_id IN (3100, 3107, 3125))
                            OR (event_type = 'DRUG' AND concept_id IN (6014, 6015)))""", [patient_id])
    tx = SERVE.rows("SELECT * FROM pt_treatment WHERE patient_id = ?", [patient_id]) if SERVE.has_table("pt_treatment") else []
    tum = SERVE.one("SELECT * FROM pt_tumour WHERE patient_id = ?", [patient_id]) if SERVE.has_table("pt_tumour") else None
    alerts = SERVE.rows("""SELECT created_at, "trigger" FROM pt_alerts WHERE patient_id = ?""", [patient_id]) \
        if SERVE.has_table("pt_alerts") else []
    risk = SERVE.one("SELECT first_high_at FROM pt_risk WHERE patient_id = ?", [patient_id]) if SERVE.has_table("pt_risk") else None
    plans = engine.plans_for(patient_id)
    names = {k: v["name"] for k, v in pathways.pathways().items()}
    for p in plans:
        p["pathway_name"] = names.get(p["pathway"])
    first_n = get_store().one("SELECT min(created_sim) AS t FROM notifications WHERE patient_id = ?", [patient_id])
    ecog = []
    if SERVE.has_table("pt_recovery"):
        rec = SERVE.one("SELECT series FROM pt_recovery WHERE patient_id = ?", [patient_id])
        if rec:
            ecog = [{"date": x["date"], "value": x["value"]} for x in (parse_json(rec["series"]) or {}).get("ecog", [])]
    from care.store import sim_now
    return journey_mod.compute(pt, ev, treatment=tx, ecog=ecog, tumour=tum, alerts=alerts, risk=risk, plans=plans,
                               first_notification=(first_n or {}).get("t"), now=sim_now())


def _recovery_shape(rec: dict | None) -> dict | None:
    if not rec:
        return None
    s = rec.get("series") or {}
    return {"series": {k: s.get(k, []) for k in ("weight", "hb", "b12", "albumin", "ecog")},
            "chemo": {"done": rec.get("chemo_done"), "planned": rec.get("chemo_planned")},
            "next_visit": rec.get("next_visit_due"), "missed_visits": rec.get("missed_visits_12m"),
            "recurrence": rec.get("recurrence"),
            "summary": {k: rec.get(k) for k in ("as_of", "dx_date", "intent", "gastrectomy", "weight_base", "weight_last",
                                                "weight_change_pct", "hb_last", "b12_last", "albumin_last", "ecog_last")}}


# ------------------------------------------------------------------------------------------------ ministry
# Every ministry aggregate goes through api/suppress.py: primary suppression (1-4 -> null + "<5"), complementary
# suppression across the rows of a breakdown against its totals, complements inside a row, and derived values
# (rates, medians, percentages, survival) hidden whenever a count behind them is.
def suppress(row: dict, fields: tuple[str, ...], derived: tuple[str, ...] = ()) -> dict:
    """Single-row suppression (kept for callers of the old helper): see api.suppress.suppress_row."""
    return suppress_row(row, fields, derived)


FUNNEL = ("flagged", "approved", "notified", "attended", "endoscopy", "cancer_found", "early_stage")
FUNNEL_PAIRS = (("early_stage", "cancer_found"),)  # early-stage cancers are a subset of the cancers found


@router.get("/care/funnel")
def funnel(from_: str | None = Query(None, alias="from"), to: str | None = None, district: str | None = None,
           r: Role = Depends(m)):
    if not SERVE.has_table("mart_care_funnel"):
        return envelope({"steps": [], "by_district": [], "by_pathway": []})
    where, params = ["TRUE"], []
    if from_:
        where.append("period >= CAST(? AS DATE)")
        params.append(from_[:10])
    if to:
        where.append("period <= CAST(? AS DATE)")
        params.append(to[:10])
    if district:
        where.append("district_code = ?")
        params.append(district)
    w = " AND ".join(where)
    sums = ", ".join(f"coalesce(sum({f}), 0)::INT AS {f}" for f in FUNNEL)
    tot = SERVE.one(f"SELECT {sums} FROM mart_care_funnel WHERE {w}", params) or {f: 0 for f in FUNNEL}
    d_rows = SERVE.rows(f"SELECT district_code, {sums} FROM mart_care_funnel WHERE {w} GROUP BY 1 ORDER BY 1", params)
    p_rows = SERVE.rows(f"SELECT pathway, {sums} FROM mart_care_funnel WHERE {w} GROUP BY 1 ORDER BY 1", params)
    tot_s, (by_d, by_p) = suppress_breakdowns(tot, [d_rows, p_rows], FUNNEL, pairs=FUNNEL_PAIRS)
    steps = []
    for f in FUNNEL:
        st = {"step": f, "n": tot_s.get(f) if tot_s.get(f) is not None else (None if tot.get(f) else 0)}
        if tot_s.get(f"{f}_label"):
            st["n_label"] = "<5"
        steps.append(st)
    return envelope({"steps": steps, "by_district": by_d, "by_pathway": by_p, "filters": {"from": from_, "to": to, "district": district}})


@router.get("/care/adherence")
def adherence(by: str = "channel", r: Role = Depends(m)):
    if by not in ("channel", "distance", "sex", "age", "district", "pathway"):
        raise APIError(400, "INVALID_FILTER", "by must be channel|distance|sex|age|district|pathway")
    rows = SERVE.rows("SELECT * FROM mart_care_adherence WHERE dim = ? ORDER BY level", [by]) \
        if SERVE.has_table("mart_care_adherence") else []
    # every dimension partitions the same outcomes, so the levels of one dimension are a breakdown of a shared total;
    # n - adhered (not adhered) is a complement inside the row
    out, _ = suppress_group(rows, ("n", "adhered"), base="n", pairs=(("adhered", "n"),),
                            derived={"rate": ("n", "adhered"), "median_days": ("n", "adhered")})
    return envelope(out)


@router.get("/care/impact")
def impact(r: Role = Depends(m)):
    rows = SERVE.rows("SELECT * FROM mart_care_impact ORDER BY route") if SERVE.has_table("mart_care_impact") else []
    has = bool(rows) and "n_staged" in rows[0]
    # a derived value is hidden when any count it is computed from is small or hidden (older marts without the helper
    # counts: when n or n_surv_eligible is)
    # The percentage = part / (part + complement): hidden when the part or its complement is small (early vs later
    # stage among the staged, deaths vs survivors among the eligible). Older marts without these helper counts: when
    # n or n_surv_eligible is small or hidden.
    derived = {"early_stage_pct": ("n",), "surv_1y": ("n", "n_surv_eligible")}
    if has:
        for x in rows:
            x["_n_late"] = (x.get("n_staged") or 0) - (x.get("n_early") or 0)
            x["_n_alive_1y"] = (x.get("n_surv_eligible") or 0) - (x.get("n_dead_1y") or 0)
        derived = {"early_stage_pct": ("n_early", "_n_late"), "surv_1y": ("n_dead_1y", "_n_alive_1y")}
    # the routes split the same diagnoses: complementary suppression across them as well
    out, _ = suppress_group(rows, ("n", "n_surv_eligible"), derived=derived)
    for x in out:
        for k in ("n_staged", "n_early", "n_dead_1y", "_n_late", "_n_alive_1y"):
            x.pop(k, None)
    return envelope(out, caveat="Synthetic data. Care-pathway and usual-route diagnoses differ in who was flagged and when; "
                                "this is an associational comparison, not a causal effect.")


@router.get("/care/chw-workload")
def chw_workload(r: Role = Depends(m)):
    rows = SERVE.rows("""SELECT w.*, d.name AS district_name FROM mart_chw_workload w LEFT JOIN ref_district d USING (district_code)
                         ORDER BY open_visits DESC""") if SERVE.has_table("mart_chw_workload") else []
    out, _ = suppress_group(rows, ("open_visits", "overdue", "completed_30d"), pairs=(("overdue", "open_visits"),))
    return envelope(out)
