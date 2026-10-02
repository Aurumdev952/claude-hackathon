"""Care engine: create -> evidence -> completion, overdue escalation over simulated days, snapshot, CARE_OVERDUE.

Runs on a tiny in-memory DuckDB that mimics the work DB (pt_patient, core_dim_location, raw_* EMR tables), an in-memory
care store and an in-memory EMR adapter, so it never touches data/ (track L2).
"""
from __future__ import annotations

import datetime as dt
import json

import duckdb
import pytest

from care import emr_bridge, engine, snapshot
from care import store as st

T0 = dt.datetime(2026, 7, 1, 9, 0, 0)
PID, PID2, FAC, ENDO_FAC = 101, 102, 1201, 1001


def fake_db() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("""CREATE TABLE pt_patient AS SELECT * FROM (VALUES
        (101, 'GAS-0000101X', 'Aline', 'Test', 'F', 62, DATE '1964-01-01', 'KIG-GAS', 1201, FALSE, NULL::DATE, FALSE, NULL::DATE),
        (102, 'GAS-0000102Y', 'Eric', 'Test', 'M', 55, DATE '1971-01-01', 'KIG-GAS', 1201, FALSE, NULL::DATE, FALSE, NULL::DATE))
        t(patient_id, display_id, given_name, family_name, sex, age, birthdate, district_code, home_facility_id, is_case, dx_date,
          dead, death_date)""")
    con.execute("""CREATE TABLE core_dim_location AS SELECT * FROM (VALUES
        (1201, 'Gasabo District Hospital (Synthetic)', 'DISTRICT', 'KIG-GAS', -1.90, 30.10, NULL::DATE),
        (1001, 'Referral Hospital A (Synthetic)', 'REFERRAL', 'KIG-NYA', -1.95, 30.06, DATE '2010-01-01'))
        t(location_id, name, facility_type, district_code, lat, lon, endoscopy_from_date)""")
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
    mem = emr_bridge.MemoryEMR()
    old_emr = emr_bridge.set_adapter(mem)
    clock = Clock(T0)
    st.set_clock(clock)
    con = fake_db()
    yield {"con": con, "emr": mem, "clock": clock, "store": st.get_store()}
    st.set_clock(None)
    st.set_store(old_store)
    emr_bridge.set_adapter(old_emr)


def advance(env, days: int):
    t0 = env["clock"].t
    env["clock"].t = t0 + dt.timedelta(days=days)
    return engine.reconcile(t0, env["clock"].t, env["con"])


def add_endoscopy(con, when: dt.datetime, impression: int = 7111, pid: int = PID, eid: int = 5001):
    con.execute("INSERT INTO raw_encounter VALUES (?, 5, ?, 1001, ?, 0)", [eid, pid, when])
    con.execute("INSERT INTO raw_obs VALUES (?, ?, 5002, ?, ?, ?, NULL, 0)", [eid * 10, pid, eid, when, impression])


def plan(env, pathway="ENDOSCOPY_REFERRAL", **kw):
    kw.setdefault("alert_id", "AL-1" if pathway == "ENDOSCOPY_REFERRAL" else None)
    return engine.create_plan(kw.pop("pid", PID), FAC, pathway, con=env["con"], set_alert_status=False, **kw)


# ---------------------------------------------------------------------------------------------------- creation
def test_create_plan_writes_emr_tasks_notifications(env):
    r = plan(env, channels=["APP", "SMS"])
    p, tasks = r["plan"], r["tasks"]
    assert p["id"].startswith("CP-") and p["status"] == "ACTIVE" and p["trigger"] == "RISK_BAND_HIGH"
    assert p["display_id"] == "GAS-0000101X"
    # the risk score is not a propensity: P(verified | features) is estimated when feedback labels are built (F1 #2)
    assert p["propensity"] is None and p["risk_at_approval"] == pytest.approx(0.31)
    assert p["model_id"] == "tier2-xgb-test" and p["band_at_approval"] == "HIGH"
    assert p["target_facility_id"] == ENDO_FAC  # nearest endoscopy-capable facility (home facility has none)
    assert [t["type"] for t in tasks] == ["ENDOSCOPY"]
    assert tasks[0]["due_at"] == (T0 + dt.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    assert {n["channel"] for n in r["notifications"]} == {"APP", "SMS"}
    for n in r["notifications"]:
        assert "Aline" not in n["body"] and "Referral Hospital A (Synthetic)" in n["body"]
    rows = env["emr"].rows
    (enc,) = rows["encounter"]
    assert enc["encounter_type"] == 15 and enc["patient_id"] == PID and enc["creator"] == 2
    assert enc["encounter_id"] >= emr_bridge.CARE_ID_BASE and p["emr_encounter_id"] == enc["encounter_id"]
    obs = {(o["concept_id"], o["value_coded"], o["value_text"]) for o in rows["obs"]}
    assert (1010, 7240, None) in obs and (1011, None, "ENDOSCOPY") in obs
    assert {(1012, 7250, None), (1012, 7251, None)} <= obs
    assert [o["concept_id"] for o in rows["orders"]] == [8000]
    assert len({o["obs_id"] for o in rows["obs"]}) == len(rows["obs"])  # unique ids
    # WS outbox: patient notification + doctor care_update for the facility
    out = env["store"].drain()
    assert any(m["type"] == "notification" and m["patient_id"] == PID for m in out)
    assert any(m["type"] == "care_update" and m["facility_id"] == FAC for m in out)


def test_duplicate_open_plan_is_rejected(env):
    plan(env)
    with pytest.raises(engine.CareError) as e:
        plan(env)
    assert e.value.status == 409


def test_bad_inputs(env):
    with pytest.raises(engine.CareError) as e:
        plan(env, pathway="NOPE")
    assert e.value.code == "INVALID_PATHWAY"
    with pytest.raises(engine.CareError) as e:
        plan(env, channels=["FAX"])
    assert e.value.code == "INVALID_CHANNEL"
    with pytest.raises(engine.CareError) as e:
        plan(env, pid=PID2, pathway="ENDOSCOPY_REFERRAL", alert_id="AL-1")
    assert e.value.code == "INVALID_ALERT"


def test_preview_writes_nothing(env):
    pv = engine.preview(PID, "ENDOSCOPY_REFERRAL", facility_id=FAC, channels=["APP", "SMS", "CHW"], con=env["con"])
    assert [t["type"] for t in pv["tasks"]] == ["ENDOSCOPY"]
    assert {m["channel"] for m in pv["messages"]} == {"APP", "SMS", "CHW"}
    app = next(m for m in pv["messages"] if m["channel"] == "APP")
    assert app["greeting"] == "Hi Aline," and "Aline" not in app["body"]
    assert env["store"].one("SELECT count(*) AS n FROM care_plans")["n"] == 0 and not env["emr"].rows


# ---------------------------------------------------------------------------------------------------- evidence
def test_evidence_completes_task_and_spawns_next_step(env):
    p = plan(env)["plan"]
    add_endoscopy(env["con"], T0 + dt.timedelta(days=9), impression=7113)  # suspicious -> pathology review
    s = advance(env, 10)
    assert s["completed"] == 1
    d = engine.plan_detail(p["id"])
    endo = d["tasks"][0]
    assert endo["status"] == "COMPLETED" and endo["result"] == "SUSPICIOUS"
    assert endo["evidence"]["table"] == "encounter" and endo["evidence"]["id"] == 5001 and endo["evidence"]["concept_id"] == 5
    assert endo["completed_at"].startswith((T0 + dt.timedelta(days=9)).strftime("%Y-%m-%d"))
    assert [t["type"] for t in d["tasks"]] == ["ENDOSCOPY", "PATHOLOGY_REVIEW"]
    # pathology encounter + histology, then a return visit closes the plan
    env["con"].execute("INSERT INTO raw_encounter VALUES (6001, 6, ?, 1001, ?, 0)", [PID, T0 + dt.timedelta(days=15)])
    env["con"].execute("INSERT INTO raw_obs VALUES (60010, ?, 5021, 6001, ?, 7131, NULL, 0)", [PID, T0 + dt.timedelta(days=15)])
    env["con"].execute("INSERT INTO raw_encounter VALUES (3001, 3, ?, 1201, ?, 0)", [PID, T0 + dt.timedelta(days=19)])
    advance(env, 10)
    d = engine.plan_detail(p["id"])
    assert [(t["type"], t["status"], t["result"]) for t in d["tasks"]] == [
        ("ENDOSCOPY", "COMPLETED", "SUSPICIOUS"), ("PATHOLOGY_REVIEW", "COMPLETED", "GASTRITIS"),
        ("RESULT_DISCUSSED", "COMPLETED", "DONE")]
    assert d["plan"]["status"] == "COMPLETED" and d["plan"]["closed_sim"]
    o = env["store"].one("SELECT * FROM recommendation_outcomes WHERE plan_id = ?", [p["id"]])
    assert o["adhered"] == 1 and o["on_time"] == 1 and o["days_to_completion"] == 9 and o["finding"] == "GASTRITIS"
    assert o["propensity"] is None and o["risk_at_approval"] == pytest.approx(0.31)
    assert o["sex"] == "F" and o["age_band"] == "60-69"
    assert o["cancer_found"] is None  # endoscopy 1 day ago: a negative is only final 60 days after it (F1 #1)
    # a completion message went to the app
    keys = [n["template_key"] for n in engine.notifications_for(PID)]
    assert "default.ENDOSCOPY.completed" in keys


def test_evidence_before_the_window_does_not_count(env):
    add_endoscopy(env["con"], T0 - dt.timedelta(days=30))
    plan(env)
    assert advance(env, 5)["completed"] == 0


def test_reconcile_is_idempotent(env):
    plan(env)
    advance(env, 29)
    n1 = env["store"].one("SELECT count(*) AS n FROM notifications")["n"]
    engine.reconcile(env["clock"].t, env["clock"].t, env["con"])
    assert env["store"].one("SELECT count(*) AS n FROM notifications")["n"] == n1


# ---------------------------------------------------------------------------------------------------- escalation
def test_overdue_escalation_ladder_over_simulated_days(env):
    p = plan(env, channels=["APP", "SMS", "CHW"])["plan"]
    due = T0 + dt.timedelta(days=30)
    advance(env, 26)  # before T-3: only the approval messages
    t = engine.plan_detail(p["id"])["tasks"][0]
    assert t["reminders"] == 0 and t["status"] == "NOTIFIED"
    advance(env, 2)  # T-2: app reminder fired at T-3
    t = engine.plan_detail(p["id"])["tasks"][0]
    assert t["reminders"] == 1 and t["escalation_level"] == 0
    advance(env, 3)  # T+1: due-day app + SMS, then overdue
    t = engine.plan_detail(p["id"])["tasks"][0]
    assert t["status"] == "OVERDUE" and t["escalation_level"] == 1
    advance(env, 7)  # T+8: CHW home visit
    d = engine.plan_detail(p["id"])
    t = d["tasks"][0]
    assert t["escalation_level"] == 2
    chw = [x for x in d["tasks"] if x["type"] == "CHW_VISIT"]
    assert len(chw) == 1 and chw[0]["due_at"].startswith((due + dt.timedelta(days=14)).strftime("%Y-%m-%d"))
    assert 8009 in [o["concept_id"] for o in env["emr"].rows["orders"]]
    assert any(n["channel"] == "CHW" for n in env["store"].rows("SELECT channel FROM notifications"))
    advance(env, 7)  # T+15: doctor escalation
    d = engine.plan_detail(p["id"])
    t = d["tasks"][0]
    assert t["status"] == "ESCALATED" and t["escalation_level"] == 3 and d["plan"]["status"] == "ESCALATED"
    kinds = [e["kind"] for e in d["events"]]
    assert kinds.index("OVERDUE") < kinds.index("CHW_ASSIGNED") < kinds.index("ESCALATED")
    stamps = [e["sim_time"] for e in d["events"]]
    assert stamps == sorted(stamps)  # history is in sim-time order
    o = env["store"].one("SELECT adhered, escalation_level FROM recommendation_outcomes WHERE plan_id = ?", [p["id"]])
    assert o == {"adhered": 0, "escalation_level": 3}
    # CARE_OVERDUE alert from the DuckDB snapshot (ml/score.py)
    snapshot.to_duckdb(env["con"])
    from ml.score import _care_overdue
    al = _care_overdue(env["con"], env["clock"].t, set())
    assert [(a["patient_id"], a["trigger"], a["facility_id"]) for a in al] == [(PID, "CARE_OVERDUE", FAC)]
    assert _care_overdue(env["con"], env["clock"].t, {(PID, "CARE_OVERDUE")}) == []  # dedupe
    # late attendance still completes the task and de-escalates the plan
    add_endoscopy(env["con"], env["clock"].t + dt.timedelta(days=1))
    advance(env, 2)
    d = engine.plan_detail(p["id"])
    assert d["tasks"][0]["status"] == "COMPLETED" and d["plan"]["status"] == "ACTIVE"
    o = env["store"].one("SELECT adhered, on_time FROM recommendation_outcomes WHERE plan_id = ?", [p["id"]])
    assert o == {"adhered": 1, "on_time": 0}


def test_without_chw_channel_ladder_skips_home_visit(env):
    p = plan(env, channels=["APP"])["plan"]
    advance(env, 50)
    d = engine.plan_detail(p["id"])
    assert not [t for t in d["tasks"] if t["type"] == "CHW_VISIT"]
    assert d["tasks"][0]["status"] == "ESCALATED"
    assert {n["channel"] for n in env["store"].rows("SELECT channel FROM notifications")} == {"APP"}


def test_hp_chain_test_of_cure_waits_four_weeks(env):
    p = plan(env, pathway="HP_TEST_AND_TREAT", channels=["APP"])["plan"]
    con = env["con"]
    con.execute("INSERT INTO raw_obs VALUES (1, ?, 3120, 11, ?, 7001, NULL, 0)", [PID, T0 + dt.timedelta(days=3)])  # positive
    con.execute("INSERT INTO raw_orders VALUES (21, 1, 6001, ?, 12, ?, 0)", [PID, T0 + dt.timedelta(days=6)])
    con.execute("INSERT INTO raw_drug_order VALUES (21)")
    advance(env, 10)
    d = engine.plan_detail(p["id"])
    assert [(t["type"], t["status"]) for t in d["tasks"]] == [("HP_TEST", "COMPLETED"), ("HP_TREATMENT", "COMPLETED"),
                                                               ("HP_TEST_OF_CURE", "SCHEDULED")]
    toc = d["tasks"][2]
    opens = dt.datetime.fromisoformat(toc["opens_at"])
    assert (opens - (T0 + dt.timedelta(days=6))).days >= 14 + 28
    # a negative test inside the window closes the plan
    con.execute("INSERT INTO raw_obs VALUES (2, ?, 3120, 13, ?, 7002, NULL, 0)", [PID, opens + dt.timedelta(days=2)])
    advance(env, 60)
    d = engine.plan_detail(p["id"])
    assert d["tasks"][2]["status"] == "COMPLETED" and d["tasks"][2]["result"] == "NEGATIVE"
    assert d["plan"]["status"] == "COMPLETED"


def test_survivorship_recurring_visits_and_missed(env):
    p = plan(env, pathway="SURVIVORSHIP", pid=PID2, channels=["APP"])["plan"]
    con = env["con"]
    con.execute("INSERT INTO raw_encounter VALUES (900, 3, ?, 1201, ?, 0)", [PID2, T0 + dt.timedelta(days=85)])
    advance(env, 100)
    d = engine.plan_detail(p["id"])
    fu = [t for t in d["tasks"] if t["type"] == "FOLLOWUP_VISIT"]
    assert fu[0]["status"] == "COMPLETED" and fu[1]["status"] == "SCHEDULED"
    assert fu[1]["due_at"].startswith((T0 + dt.timedelta(days=182)).strftime("%Y-%m-%d"))
    advance(env, 200)  # visit 2 is never attended; visit 3's window opens -> visit 2 recorded as missed
    fu = [t for t in engine.plan_detail(p["id"])["tasks"] if t["type"] == "FOLLOWUP_VISIT"]
    assert fu[1]["status"] == "CANCELLED" and fu[1]["result"] == "MISSED"
    assert [t["occurrence"] for t in fu] == list(range(len(fu)))


def test_patch_task_actions(env):
    p = plan(env)
    tid = p["tasks"][0]["id"]
    with pytest.raises(engine.CareError):
        engine.patch_task(tid, "decline")  # reason required
    env["clock"].t = T0 + dt.timedelta(days=2)
    r = engine.patch_task(tid, "reschedule", due_at="2026-08-20", reason="patient travelling")
    assert r["task"]["due_at"] == "2026-08-20T00:00:00" and r["task"]["reminders"] == 0
    r = engine.patch_task(tid, "complete", reason="done at another hospital", result="normal")
    assert r["task"]["status"] == "COMPLETED" and r["task"]["evidence"]["manual"] is True
    assert 1014 in [o["concept_id"] for o in env["emr"].rows["obs"]]  # outcome recorded in the EMR
    with pytest.raises(engine.CareError) as e:
        engine.patch_task(tid, "complete")
    assert e.value.status == 409


def test_patient_reports_write_patient_reported_encounters(env):
    plan(env)
    with pytest.raises(engine.CareError):
        engine.record_checkin(PID, {"appetite": 11, "pain": 1, "energy": 5, "dumping": False}, con=env["con"])
    rep = engine.record_checkin(PID, {"appetite": 6, "pain": 2, "energy": 5, "dumping": True, "weight_kg": 61.5}, con=env["con"])
    assert rep["kind"] == "CHECKIN" and rep["emr_encounter_id"] >= emr_bridge.CARE_ID_BASE
    encs = [e for e in env["emr"].rows["encounter"] if e["encounter_type"] == 16]
    assert len(encs) == 1
    cids = {o["concept_id"] for o in env["emr"].rows["obs"] if o["encounter_id"] == encs[0]["encounter_id"]}
    assert cids == {4020, 4021, 4022, 4023, 4024}
    task = env["store"].one("SELECT id FROM care_tasks LIMIT 1")["id"]
    engine.confirm_task(PID, task, "I booked for Monday", con=env["con"])
    with pytest.raises(engine.CareError) as e:
        engine.confirm_task(PID2, task, "not mine", con=env["con"])
    assert e.value.status == 403
    engine.record_dose(PID, "HP_ERADICATION", True, con=env["con"])
    kinds = [r["kind"] for r in env["store"].rows("SELECT kind FROM patient_reports ORDER BY created_sim")]
    assert sorted(kinds) == ["CHECKIN", "CONFIRM", "DOSE"]


def test_worklist_ranks_overdue_first(env):
    plan(env, channels=["APP"])
    plan(env, pathway="HP_TEST_AND_TREAT", pid=PID2, channels=["APP"])
    advance(env, 25)  # HP test (due 21) overdue, endoscopy (due 30) not yet
    wl = engine.worklist(FAC, con=env["con"])
    assert wl[0]["task"]["type"] == "HP_TEST" and wl[0]["task"]["status"] == "OVERDUE"
    assert 0 < wl[0]["p_adhere"] < 1 and wl[0]["priority"] >= wl[-1]["priority"]
    assert wl[0]["patient"]["display_id"] == "GAS-0000102Y"


def test_snapshot_tables_and_types(env):
    plan(env)
    advance(env, 3)
    out = snapshot.to_duckdb(env["con"])
    assert set(out) == {"care_plans", "care_tasks", "care_events", "care_notifications", "care_patient_reports",
                        "care_recommendation_outcomes"}
    types = dict(env["con"].execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'care_tasks'")
                 .fetchall())
    assert types["due_at"] == "TIMESTAMP" and types["escalation_level"] == "BIGINT"
    assert env["con"].execute("SELECT count(*) FROM care_patient_reports").fetchone()[0] == 0  # empty but typed
    ctx = json.loads(env["con"].execute("SELECT context FROM care_plans").fetchone()[0])
    assert ctx["district_code"] == "KIG-GAS"
