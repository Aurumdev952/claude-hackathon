"""Care + patient-app API against the published dev serve DB (track L2): role guards, facility scoping, patient
scoping, suppression and the doctor-approve -> patient-notification flow. Care state, EMR writes and alert statuses
stay in memory / a temp file."""
from __future__ import annotations

import pytest

from shared.config import ANALYTICS_DIR

PII = {"given_name", "family_name", "display_id", "birthdate", "patient_id", "name"}
SIM = "2026-06-30T23:59:59"


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    if not (ANALYTICS_DIR / "current.json").exists():
        pytest.skip("no published serve DB")
    from fastapi.testclient import TestClient

    from api import app_state
    from care import emr_bridge
    from care import store as st
    app_state.CON = app_state._con(":memory:")
    old_store = st.set_store(st.Store(tmp_path_factory.mktemp("care") / "care.sqlite"))
    old_emr = emr_bridge.set_adapter(emr_bridge.MemoryEMR())
    st.set_clock(lambda: SIM)
    from api.main import app
    with TestClient(app) as c:
        yield c
    st.set_clock(None)
    st.set_store(old_store)
    emr_bridge.set_adapter(old_emr)


@pytest.fixture(scope="module")
def ctx(client):
    from api.deps import SERVE
    a = SERVE.one("""SELECT a.alert_id, a.patient_id, f.facility_id FROM pt_alerts a JOIN pt_patient_facility f USING (patient_id)
                     JOIN pt_patient p USING (patient_id) WHERE NOT p.dead AND a."trigger" IN ('RISK_BAND_HIGH', 'ALARM_NO_SCOPE_90D')
                     ORDER BY a.alert_id LIMIT 1""")
    # a health centre the patient is not linked to: never a plan's referral target (endoscopy sites are hospitals), so
    # its doctor has no route to this patient
    other = SERVE.one("""SELECT location_id FROM core_dim_location WHERE facility_type = 'HEALTH_CENTRE' AND location_id NOT IN
                         (SELECT facility_id FROM pt_patient_facility WHERE patient_id = ?) ORDER BY location_id LIMIT 1""",
                      [a["patient_id"]])["location_id"]
    b = SERVE.one("""SELECT a.alert_id, a.patient_id FROM pt_alerts a JOIN pt_patient_facility f USING (patient_id)
                     JOIN pt_patient p USING (patient_id)
                     WHERE f.facility_id = ? AND a."trigger" = 'HP_POS_UNTREATED' AND a.patient_id <> ? AND NOT p.dead
                     ORDER BY a.alert_id LIMIT 1""", [a["facility_id"], a["patient_id"]])
    if b is None:
        b = SERVE.one("""SELECT NULL AS alert_id, f.patient_id FROM pt_patient_facility f JOIN pt_patient p USING (patient_id)
                         WHERE f.facility_id = ? AND f.patient_id <> ? AND NOT p.dead ORDER BY 2 LIMIT 1""",
                      [a["facility_id"], a["patient_id"]])
    return {"A": a["patient_id"], "alert": a["alert_id"], "B": b["patient_id"], "alert_b": b["alert_id"],
            "doc": {"X-Role": "doctor", "X-Facility-Id": str(a["facility_id"])},
            "other_doc": {"X-Role": "doctor", "X-Facility-Id": str(other)},
            "pa": {"X-Role": "patient", "X-Patient-Id": str(a["patient_id"])},
            "pb": {"X-Role": "patient", "X-Patient-Id": str(b["patient_id"])},
            "min": {"X-Role": "ministry"}}


def ok(r, code=200):
    assert r.status_code == code, r.text[:500]
    body = r.json()
    assert set(body) >= {"meta", "data"}
    return body["data"]


def err(r, code, ecode=None):
    assert r.status_code == code, r.text[:300]
    if ecode:
        assert r.json()["error"]["code"] == ecode


@pytest.fixture(scope="module")
def plans(client, ctx):
    """Doctor approves: an endoscopy referral for A (from the alert) and H. pylori test-and-treat for B."""
    pv = ok(client.post("/api/v1/care/notifications/preview", headers=ctx["doc"],
                        json={"patient_id": ctx["A"], "pathway": "ENDOSCOPY_REFERRAL", "alert_id": ctx["alert"]}))
    assert pv["tasks"][0]["type"] == "ENDOSCOPY" and pv["messages"]
    a = ok(client.post("/api/v1/care/plans", headers=ctx["doc"],
                       json={"patient_id": ctx["A"], "pathway": "ENDOSCOPY_REFERRAL", "alert_id": ctx["alert"],
                             "channels": ["APP", "SMS", "CHW"], "note": "Discussed in clinic"}), 201)
    b = ok(client.post("/api/v1/care/plans", headers=ctx["doc"],
                       json={"patient_id": ctx["B"], "pathway": "HP_TEST_AND_TREAT", "alert_id": ctx["alert_b"]}), 201)
    return {"A": a, "B": b}


# ---------------------------------------------------------------------------------------------------- doctor
def test_doctor_creates_plan_and_alert_is_referred(client, ctx, plans):
    a = plans["A"]
    assert a["plan"]["pathway"] == "ENDOSCOPY_REFERRAL" and a["plan"]["status"] == "ACTIVE"
    assert {n["channel"] for n in a["notifications"]} >= {"APP", "SMS"}
    al = ok(client.get("/api/v1/alerts", headers=ctx["doc"]))
    assert next(x for x in al if x["alert_id"] == ctx["alert"])["status"] == "REFERRED"
    care = ok(client.get(f"/api/v1/patients/{ctx['A']}/care", headers=ctx["doc"]))
    assert care["plans"][0]["id"] == a["plan"]["id"] and care["plans"][0]["tasks"] and care["plans"][0]["events"]
    lst = ok(client.get("/api/v1/care/plans?status=ACTIVE", headers=ctx["doc"]))
    assert {p["patient_id"] for p in lst["plans"]} >= {ctx["A"], ctx["B"]}
    err(client.post("/api/v1/care/plans", headers=ctx["doc"], json={"patient_id": ctx["A"], "pathway": "ENDOSCOPY_REFERRAL"}),
        409, "PLAN_EXISTS")


def test_worklist_and_patch(client, ctx, plans):
    wl = ok(client.get("/api/v1/care/worklist", headers=ctx["doc"]))
    assert wl and set(wl[0]) >= {"task", "plan", "patient", "p_adhere", "priority"}
    assert set(wl[0]["patient"]) >= {"patient_id", "display_id", "given_name", "family_name", "age", "sex"}
    tid = plans["B"]["tasks"][0]["id"]
    t = ok(client.patch(f"/api/v1/care/tasks/{tid}", headers=ctx["doc"],
                        json={"action": "reschedule", "due_at": "2026-08-15", "reason": "patient request"}))
    assert t["task"]["due_at"].startswith("2026-08-15")
    err(client.patch(f"/api/v1/care/tasks/{tid}", headers=ctx["doc"], json={"action": "fly"}), 400, "INVALID_ACTION")


def test_pathways_and_journey(client, ctx, plans):
    pw = ok(client.get("/api/v1/care/pathways", headers=ctx["doc"]))
    assert len(pw) == 6 and set(pw[0]) >= {"id", "name", "description", "triggers", "tasks", "default_channels"}
    j = ok(client.get(f"/api/v1/patients/{ctx['A']}/journey", headers=ctx["doc"]))
    assert set(j) >= {"phases", "recovery"}
    names = [p["phase"] for p in j["phases"]]
    assert "Flagged" in names and "Approved" in names
    for p in j["phases"]:
        assert set(p) >= {"phase", "start", "end", "status", "milestones"}
        assert p["status"] in ("done", "current", "upcoming", "missed")


def test_diagnosed_journey_has_recovery(client, ctx):
    from api.deps import SERVE
    pid = SERVE.one("""SELECT p.patient_id FROM pt_patient p JOIN pt_patient_facility f USING (patient_id)
                       WHERE p.is_case AND f.facility_id = ? ORDER BY p.dx_date DESC LIMIT 1""", [int(ctx["doc"]["X-Facility-Id"])])
    if not pid:
        pytest.skip("no diagnosed patient at this facility")
    j = ok(client.get(f"/api/v1/patients/{pid['patient_id']}/journey", headers=ctx["doc"]))
    assert "Diagnosis" in [p["phase"] for p in j["phases"]]
    rec = j["recovery"]
    assert set(rec) >= {"series", "chemo", "next_visit", "missed_visits", "recurrence"}
    assert set(rec["series"]) == {"weight", "hb", "b12", "albumin", "ecog"}


# ---------------------------------------------------------------------------------------------------- guards
DOCTOR_ROUTES = [("get", "/api/v1/care/plans", None), ("get", "/api/v1/care/worklist", None),
                 ("post", "/api/v1/care/plans", {"patient_id": 1, "pathway": "ENDOSCOPY_REFERRAL"}),
                 ("post", "/api/v1/care/notifications/preview", {"patient_id": 1, "pathway": "ENDOSCOPY_REFERRAL"}),
                 ("patch", "/api/v1/care/tasks/CT-X", {"action": "complete"})]


@pytest.mark.parametrize("hdr", ["min", "pa"])
def test_ministry_and_patient_get_403_on_doctor_care_routes(client, ctx, plans, hdr):
    for method, url, body in DOCTOR_ROUTES + [("get", f"/api/v1/patients/{ctx['A']}/care", None),
                                              ("get", f"/api/v1/patients/{ctx['A']}/journey", None)]:
        r = getattr(client, method)(url, headers=ctx[hdr], **({"json": body} if body else {}))
        err(r, 403, "FORBIDDEN")


def test_doctor_at_another_facility_gets_403(client, ctx, plans):
    o = ctx["other_doc"]
    err(client.get(f"/api/v1/patients/{ctx['A']}/care", headers=o), 403)
    err(client.get(f"/api/v1/patients/{ctx['A']}/journey", headers=o), 403)
    err(client.post("/api/v1/care/plans", headers=o, json={"patient_id": ctx["A"], "pathway": "HP_TEST_AND_TREAT"}), 403)
    err(client.post("/api/v1/care/notifications/preview", headers=o, json={"patient_id": ctx["A"], "pathway": "HP_TEST_AND_TREAT"}), 403)
    err(client.patch(f"/api/v1/care/tasks/{plans['A']['tasks'][0]['id']}", headers=o, json={"action": "complete"}), 403)
    assert all(w["task"]["patient_id"] != ctx["A"] for w in ok(client.get("/api/v1/care/worklist", headers=o)))


def test_doctor_and_ministry_get_403_on_me(client, ctx):
    for hdr in ("doc", "min"):
        for url in ("/api/v1/me", "/api/v1/me/notifications", "/api/v1/me/plan", "/api/v1/me/journey"):
            err(client.get(url, headers=ctx[hdr]), 403, "FORBIDDEN")


def test_patient_requires_patient_id(client):
    err(client.get("/api/v1/me", headers={"X-Role": "patient"}), 400, "PATIENT_REQUIRED")


def test_patient_a_cannot_touch_patient_b(client, ctx, plans):
    nb = ok(client.get("/api/v1/me/notifications", headers=ctx["pb"]))
    assert nb, "B should have notifications"
    err(client.post(f"/api/v1/me/notifications/{nb[0]['id']}/read", headers=ctx["pa"]), 403, "FORBIDDEN")
    err(client.post(f"/api/v1/me/tasks/{plans['B']['tasks'][0]['id']}/confirm", headers=ctx["pa"], json={"text": "x"}), 403)
    mine = ok(client.get("/api/v1/me/plan", headers=ctx["pa"]))
    assert {p["patient_id"] for p in mine["plans"]} == {ctx["A"]}
    assert all(n["plan_id"] != plans["B"]["plan"]["id"] for n in ok(client.get("/api/v1/me/notifications", headers=ctx["pa"])))


# ---------------------------------------------------------------------------------------------------- patient app
def test_patient_app_flow(client, ctx, plans):
    me = ok(client.get("/api/v1/me", headers=ctx["pa"]))
    assert me["patient_id"] == ctx["A"] and me["given_name"] and me["chw"]["name"] == "CHW (Synthetic)"
    ns = ok(client.get("/api/v1/me/notifications", headers=ctx["pa"]))
    app = [n for n in ns if n["channel"] == "APP"]
    assert app and app[0]["greeting"] == f"Hi {me['given_name']},"
    assert me["given_name"] not in app[0]["body"]  # the name is only in the on-screen greeting
    assert not [n for n in ns if n["channel"] == "CHW"]  # CHW messages are for the CHW
    r = ok(client.post(f"/api/v1/me/notifications/{app[0]['id']}/read", headers=ctx["pa"]))
    assert r["read_sim"] == SIM
    r = ok(client.post(f"/api/v1/me/notifications/{app[0]['id']}/acted", headers=ctx["pa"]))
    assert r["acted_sim"] == SIM
    plan = ok(client.get("/api/v1/me/plan", headers=ctx["pa"]))["plans"][0]
    for k in ("note", "model_id", "risk_at_approval", "propensity", "band_at_approval", "context"):
        assert k not in plan
    assert plan["pathway_name"] == "Endoscopy referral"
    assert all("result" not in t and "evidence" not in t for t in plan["tasks"])
    ok(client.post(f"/api/v1/me/tasks/{plan['tasks'][0]['id']}/confirm", headers=ctx["pa"], json={"text": "Booked for Monday"}), 201)
    c = ok(client.post("/api/v1/me/checkins", headers=ctx["pa"],
                       json={"appetite": 6, "pain": 2, "energy": 7, "dumping": False, "weight_kg": 60}), 201)
    assert c["emr_encounter_id"]
    err(client.post("/api/v1/me/checkins", headers=ctx["pa"], json={"appetite": 60}), 400)
    ok(client.post("/api/v1/me/doses", headers=ctx["pa"], json={"course": "HP_ERADICATION", "taken": True}), 201)
    j = ok(client.get("/api/v1/me/journey", headers=ctx["pa"]))
    from care.messages import forbidden_hits
    import json as _json
    assert not forbidden_hits(_json.dumps(j))
    demo = ok(client.get("/api/v1/patient-app/demo-patients"))
    assert {d["patient_id"] for d in demo} >= {ctx["A"], ctx["B"]}
    assert all(set(d) == {"patient_id", "display_id", "plan_count", "has_notifications"} for d in demo)


# ---------------------------------------------------------------------------------------------------- ministry
def _walk(x):
    if isinstance(x, dict):
        for k, v in x.items():
            yield k, v
            yield from _walk(v)
    elif isinstance(x, list):
        for v in x:
            yield from _walk(v)


@pytest.mark.parametrize("url", ["/api/v1/care/funnel", "/api/v1/care/adherence?by=channel", "/api/v1/care/adherence?by=district",
                                 "/api/v1/care/impact", "/api/v1/care/chw-workload"])
def test_ministry_aggregates_are_suppressed_and_anonymous(client, ctx, url):
    data = ok(client.get(url, headers=ctx["min"]))
    for k, v in _walk(data):
        assert k not in PII - {"name"}, k
        if k in ("n", "flagged", "approved", "notified", "attended", "endoscopy", "cancer_found", "early_stage", "adhered",
                 "open_visits", "overdue", "completed_30d", "n_surv_eligible") and v is not None:
            assert v == 0 or v >= 5, (k, v)
    err(client.get(url, headers=ctx["doc"]), 403)


def test_suppress_helper():
    from api.routers.care import suppress
    assert suppress({"n": 3, "rate": 0.0, "adhered": 0}, ("n", "adhered"), ("rate",)) == \
        {"n": None, "n_label": "<5", "rate": None, "adhered": None, "adhered_label": "<5"}
    assert suppress({"n": 9, "rate": 0.3, "adhered": 3}, ("n", "adhered")) == \
        {"n": 9, "rate": 0.3, "adhered": None, "adhered_label": "<5"}
    assert suppress({"n": 7, "rate": 0.5}, ("n",), ("rate",)) == {"n": 7, "rate": 0.5}
    assert suppress({"n": 0}, ("n",)) == {"n": 0}


def test_admin_sim_routes(client):
    r = client.get("/api/v1/admin/sim/status")
    assert r.status_code in (200, 503)
    if r.status_code == 503:
        assert r.json()["error"]["code"] == "SIM_UNAVAILABLE"
    err(client.get("/api/v1/admin/sim/jobs/nope"), 404)
    err(client.post("/api/v1/admin/sim", json={"action": "advance", "days": 0}), 400, "INVALID_DAYS")
