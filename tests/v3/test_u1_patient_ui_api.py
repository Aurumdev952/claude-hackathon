"""Small additive API fields used by the U1 screens: GET /me/doses, the patient-app journey recovery scalars and the
journey fields on the doctor's diagnosed list. Care state and EMR writes stay in a temp store / in memory."""
from __future__ import annotations

import pytest

from shared.config import ANALYTICS_DIR

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


def ok(r, code=200):
    assert r.status_code == code, r.text[:500]
    return r.json()["data"]


@pytest.fixture(scope="module")
def ids(client):
    from api.deps import SERVE
    alive = SERVE.one("SELECT patient_id FROM pt_patient WHERE NOT dead ORDER BY patient_id LIMIT 1")
    other = SERVE.one("SELECT patient_id FROM pt_patient WHERE NOT dead AND patient_id > ? ORDER BY patient_id LIMIT 1",
                      [alive["patient_id"]])
    fac = SERVE.one("""SELECT f.facility_id FROM pt_patient_facility f JOIN pt_patient p USING (patient_id) WHERE p.is_case
                       GROUP BY 1 ORDER BY count(*) DESC LIMIT 1""")
    rec = SERVE.one("SELECT patient_id FROM pt_recovery WHERE chemo_planned > 0 ORDER BY patient_id LIMIT 1") \
        if SERVE.has_table("pt_recovery") else None
    return {"a": alive["patient_id"], "b": other["patient_id"], "fac": fac["facility_id"],
            "rec": rec["patient_id"] if rec else None}


def test_doses_round_trip_and_scoping(client, ids):
    pa = {"X-Role": "patient", "X-Patient-Id": str(ids["a"])}
    pb = {"X-Role": "patient", "X-Patient-Id": str(ids["b"])}
    assert ok(client.get("/api/v1/me/doses", headers=pa)) == []
    ok(client.post("/api/v1/me/doses", headers=pa, json={"course": "HP_ERADICATION", "taken": True}), 201)
    ok(client.post("/api/v1/me/doses", headers=pa, json={"course": "HP_ERADICATION", "taken": False}), 201)
    doses = ok(client.get("/api/v1/me/doses", headers=pa))
    assert len(doses) == 2 and {d["taken"] for d in doses} == {True, False}
    assert all(d["course"] == "HP_ERADICATION" and d["created_sim"] for d in doses)
    assert ok(client.get("/api/v1/me/doses", headers=pb)) == []          # another patient sees none of them
    r = client.get("/api/v1/me/doses", headers={"X-Role": "doctor", "X-Facility-Id": str(ids["fac"])})
    assert r.status_code == 403


def test_patient_journey_carries_recovery_scalars(client, ids):
    if ids["rec"] is None:
        pytest.skip("no pt_recovery rows with chemotherapy")
    from api.deps import SERVE
    row = SERVE.one("SELECT chemo_done, chemo_planned, missed_visits_12m FROM pt_recovery WHERE patient_id = ?", [ids["rec"]])
    j = ok(client.get("/api/v1/me/journey", headers={"X-Role": "patient", "X-Patient-Id": str(ids["rec"])}))
    assert j["recovery"]["treatment_cycles"] == {"done": row["chemo_done"], "planned": row["chemo_planned"]}
    assert j["recovery"]["missed_visits"] == row["missed_visits_12m"]


def test_diagnosed_list_has_journey_fields(client, ids):
    doc = {"X-Role": "doctor", "X-Facility-Id": str(ids["fac"])}
    rows = ok(client.get("/api/v1/patients?status=diagnosed&page_size=100", headers=doc))
    assert rows and all("journey" in x for x in rows)
    keys = {"phase", "phase_status", "missed_visits", "next_visit", "intent", "gastrectomy", "recurrence"}
    assert keys <= set(rows[0]["journey"])
    flagged = ok(client.get("/api/v1/patients?status=flagged&page_size=5", headers=doc))
    assert all("journey" not in x for x in flagged)                      # only the diagnosed list pays for the join


def test_my_plan_names_the_target_facility(client, ids):
    from api.deps import SERVE
    pid = ids["a"]
    fac = SERVE.one("SELECT facility_id FROM pt_patient_facility WHERE patient_id = ? LIMIT 1", [pid])
    if fac is None:
        pytest.skip("patient has no facility link")
    doc = {"X-Role": "doctor", "X-Facility-Id": str(fac["facility_id"])}
    r = client.post("/api/v1/care/plans", headers=doc, json={"patient_id": pid, "pathway": "HP_TEST_AND_TREAT", "channels": ["APP"]})
    assert r.status_code in (201, 409), r.text[:300]
    plans = ok(client.get("/api/v1/me/plan", headers={"X-Role": "patient", "X-Patient-Id": str(pid)}))["plans"]
    assert plans and all(p["target_facility_name"] and "(Synthetic)" in p["target_facility_name"] for p in plans)
