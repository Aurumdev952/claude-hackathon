"""Next-plan suggestions (F2): a NEXT_PATHWAY_SUGGESTED event becomes an open suggestion the doctor can start, until a plan
on that pathway exists. Engine part on an in-memory DuckDB + care store; API part on the published serve DB with a temp
care store and an in-memory EMR (never touches the live care.sqlite)."""
from __future__ import annotations

import datetime as dt

import duckdb
import pytest

from care import emr_bridge, engine
from care import store as st
from shared.config import ANALYTICS_DIR

T0 = dt.datetime(2026, 7, 1, 9, 0, 0)
PID, FAC, ENDO_FAC, OTHER_FAC = 101, 1201, 1001, 1299


def fake_db() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("""CREATE TABLE pt_patient AS SELECT * FROM (VALUES
        (101, 'GAS-0000101X', 'Aline', 'Test', 'F', 62, DATE '1964-01-01', 'KIG-GAS', 1201, FALSE, NULL::DATE, FALSE, NULL::DATE))
        t(patient_id, display_id, given_name, family_name, sex, age, birthdate, district_code, home_facility_id, is_case, dx_date,
          dead, death_date)""")
    con.execute("""CREATE TABLE core_dim_location AS SELECT * FROM (VALUES
        (1201, 'Gasabo District Hospital (Synthetic)', 'DISTRICT', 'KIG-GAS', -1.90, 30.10, NULL::DATE),
        (1001, 'Referral Hospital A (Synthetic)', 'REFERRAL', 'KIG-NYA', -1.95, 30.06, DATE '2010-01-01'),
        (1299, 'Other District Hospital (Synthetic)', 'DISTRICT', 'KIG-KIC', -1.80, 30.20, NULL::DATE))
        t(location_id, name, facility_type, district_code, lat, lon, endoscopy_from_date)""")
    con.execute("CREATE TABLE pt_patient_facility AS SELECT 101 AS patient_id, 1201 AS facility_id")
    con.execute("CREATE TABLE pt_risk AS SELECT 101 AS patient_id, 0.31 AS ensemble_prob, 'HIGH' AS risk_band")
    con.execute("""CREATE TABLE pt_alerts AS SELECT 'AL-1' AS alert_id, 101 AS patient_id, 'RISK_BAND_HIGH' AS "trigger",
                   TIMESTAMP '2026-06-30 23:59:59' AS created_at, 1201 AS facility_id""")
    con.execute("""CREATE TABLE ml_model_registry AS SELECT 'tier2-xgb-test' AS model_id, 2 AS tier, TRUE AS is_active,
                   TIMESTAMP '2026-06-01' AS trained_at""")
    con.execute("""CREATE TABLE raw_encounter (encounter_id BIGINT, encounter_type SMALLINT, patient_id BIGINT, location_id INT,
                   encounter_datetime TIMESTAMP, voided TINYINT)""")
    con.execute("""CREATE TABLE raw_obs (obs_id BIGINT, person_id BIGINT, concept_id INT, encounter_id BIGINT,
                   obs_datetime TIMESTAMP, value_coded INT, value_numeric DOUBLE, voided TINYINT)""")
    con.execute("""CREATE TABLE raw_orders (order_id BIGINT, order_type_id SMALLINT, concept_id INT, patient_id BIGINT,
                   encounter_id BIGINT, date_activated TIMESTAMP, voided TINYINT)""")
    con.execute("CREATE TABLE raw_drug_order (order_id BIGINT)")
    return con


class Clock:
    def __init__(self, t: dt.datetime):
        self.t = t

    def __call__(self) -> str:
        return self.t.strftime("%Y-%m-%dT%H:%M:%S")


@pytest.fixture()
def env():
    old_store = st.set_store(st.Store(":memory:"))
    old_emr = emr_bridge.set_adapter(emr_bridge.MemoryEMR())
    clock = Clock(T0)
    st.set_clock(clock)
    yield {"con": fake_db(), "clock": clock, "store": st.get_store()}
    st.set_clock(None)
    st.set_store(old_store)
    emr_bridge.set_adapter(old_emr)


def advance(env, days: int):
    t0 = env["clock"].t
    env["clock"].t = t0 + dt.timedelta(days=days)
    return engine.reconcile(t0, env["clock"].t, env["con"])


def cancer_found(env) -> dict:
    """Endoscopy referral: suspicious endoscopy, then histology with cancer (EMR evidence, as the simulator writes it)."""
    p = engine.create_plan(PID, FAC, "ENDOSCOPY_REFERRAL", alert_id="AL-1", con=env["con"], set_alert_status=False)["plan"]
    con = env["con"]
    con.execute("INSERT INTO raw_encounter VALUES (5001, 5, ?, 1001, ?, 0)", [PID, T0 + dt.timedelta(days=9)])
    con.execute("INSERT INTO raw_obs VALUES (50010, ?, 5002, 5001, ?, 7113, NULL, 0)", [PID, T0 + dt.timedelta(days=9)])
    advance(env, 10)
    con.execute("INSERT INTO raw_encounter VALUES (6001, 6, ?, 1001, ?, 0)", [PID, T0 + dt.timedelta(days=15)])
    con.execute("INSERT INTO raw_obs VALUES (60010, ?, 5021, 6001, ?, 7130, NULL, 0)", [PID, T0 + dt.timedelta(days=15)])
    advance(env, 10)
    return p


def test_cancer_found_gives_one_suggestion(env):
    p = cancer_found(env)
    assert engine.suggestions(con=env["con"]) == engine.suggestions(facility_id=FAC, con=env["con"])
    (s,) = engine.suggestions(facility_id=FAC, con=env["con"])
    assert s["patient_id"] == PID and s["display_id"] == "GAS-0000101X"
    assert s["pathway"] == "ONCOLOGY_TREATMENT" and s["pathway_name"] == "Specialist treatment"
    assert s["reason"] == "Cancer found at the referral endoscopy"
    assert s["from_plan_id"] == p["id"] and s["since"].startswith("2026-07-16")
    assert set(s) == {"patient_id", "display_id", "pathway", "pathway_name", "reason", "since", "from_plan_id"}
    # the referral target sees it too (plan targeted to it), a facility with no link and no plan does not
    assert [x["patient_id"] for x in engine.suggestions(facility_id=ENDO_FAC, con=env["con"])] == [PID]
    assert engine.suggestions(facility_id=OTHER_FAC, con=env["con"]) == []
    assert engine.suggestions(patient_id=PID, con=env["con"]) == [s]
    assert engine.suggestions(patient_id=PID + 1, con=env["con"]) == []
    # a suggestion never creates a plan by itself
    assert env["store"].one("SELECT count(*) AS n FROM care_plans WHERE pathway = 'ONCOLOGY_TREATMENT'")["n"] == 0


def test_starting_the_plan_clears_it_and_a_cancelled_plan_does_not(env):
    cancer_found(env)
    r = engine.create_plan(PID, FAC, "ONCOLOGY_TREATMENT", con=env["con"], set_alert_status=False)
    assert engine.suggestions(facility_id=FAC, con=env["con"]) == []
    # cancelling that plan brings the suggestion back (CANCELLED plans do not count as acting on it)
    env["store"].update("care_plans", r["plan"]["id"], {"status": "CANCELLED"})
    assert [s["pathway"] for s in engine.suggestions(facility_id=FAC, con=env["con"])] == ["ONCOLOGY_TREATMENT"]


def test_dead_patients_get_no_suggestion(env):
    cancer_found(env)
    env["con"].execute("UPDATE pt_patient SET dead = TRUE")
    assert engine.suggestions(facility_id=FAC, con=env["con"]) == []


# ---------------------------------------------------------------------------------------------------- API
@pytest.fixture(scope="module")
def client(tmp_path_factory):
    if not (ANALYTICS_DIR / "current.json").exists():
        pytest.skip("no published serve DB")
    from fastapi.testclient import TestClient

    from api import app_state
    app_state.CON = app_state._con(":memory:")
    old_store = st.set_store(st.Store(tmp_path_factory.mktemp("care") / "care.sqlite"))
    old_emr = emr_bridge.set_adapter(emr_bridge.MemoryEMR())
    st.set_clock(lambda: "2026-06-30T23:59:59")
    from api.main import app
    with TestClient(app) as c:
        yield c
    st.set_clock(None)
    st.set_store(old_store)
    emr_bridge.set_adapter(old_emr)


def ok(r, code=200):
    assert r.status_code == code, r.text[:500]
    return r.json()["data"]


def test_api_suggestions_scoping_and_guards(client):
    from api.deps import SERVE
    a = SERVE.one("""SELECT a.alert_id, a.patient_id, f.facility_id FROM pt_alerts a JOIN pt_patient_facility f USING (patient_id)
                     JOIN pt_patient p USING (patient_id) WHERE NOT p.dead AND a."trigger" IN ('RISK_BAND_HIGH', 'ALARM_NO_SCOPE_90D')
                     ORDER BY a.alert_id LIMIT 1""")
    other = SERVE.one("""SELECT location_id FROM core_dim_location WHERE facility_type = 'HEALTH_CENTRE' AND location_id NOT IN
                         (SELECT facility_id FROM pt_patient_facility WHERE patient_id = ?) ORDER BY location_id LIMIT 1""",
                      [a["patient_id"]])["location_id"]
    pid = a["patient_id"]
    doc = {"X-Role": "doctor", "X-Facility-Id": str(a["facility_id"])}
    other_doc = {"X-Role": "doctor", "X-Facility-Id": str(other)}
    assert ok(client.get("/api/v1/care/suggestions", headers=doc)) == []
    plan = ok(client.post("/api/v1/care/plans", headers=doc,
                          json={"patient_id": pid, "pathway": "ENDOSCOPY_REFERRAL", "alert_id": a["alert_id"]}), 201)
    tid = plan["tasks"][0]["id"]
    ok(client.patch(f"/api/v1/care/tasks/{tid}", headers=doc,
                    json={"action": "complete", "result": "cancer_found", "reason": "histology in the record"}))
    (s,) = ok(client.get("/api/v1/care/suggestions", headers=doc))
    assert s["patient_id"] == pid and s["pathway"] == "ONCOLOGY_TREATMENT" and s["from_plan_id"] == plan["plan"]["id"]
    assert "given_name" not in s and "family_name" not in s
    care = ok(client.get(f"/api/v1/patients/{pid}/care", headers=doc))
    assert care["suggested_next"] == [s] and care["plans"][0]["id"] == plan["plan"]["id"]
    # another facility's doctor: nothing listed, and the patient's care stays closed
    assert ok(client.get("/api/v1/care/suggestions", headers=other_doc)) == []
    assert client.get(f"/api/v1/patients/{pid}/care", headers=other_doc).status_code == 403
    # role guards
    assert client.get("/api/v1/care/suggestions", headers={"X-Role": "ministry"}).status_code == 403
    assert client.get("/api/v1/care/suggestions", headers={"X-Role": "patient", "X-Patient-Id": str(pid)}).status_code == 403
    assert client.get("/api/v1/care/suggestions").status_code == 403  # default role is ministry
    # the doctor starts the suggested plan: the suggestion is gone everywhere
    ok(client.post("/api/v1/care/plans", headers=doc, json={"patient_id": pid, "pathway": "ONCOLOGY_TREATMENT"}), 201)
    assert ok(client.get("/api/v1/care/suggestions", headers=doc)) == []
    assert ok(client.get(f"/api/v1/patients/{pid}/care", headers=doc))["suggested_next"] == []
