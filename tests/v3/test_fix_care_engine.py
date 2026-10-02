"""Regression tests for the F1 review fixes in the care engine (care/engine.py, care/evidence.py, care/store.py,
care/emr_bridge.py). Same in-memory fixtures as test_care_engine.py: never touches data/."""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading
import time

import duckdb
import pytest

from care import emr_bridge, engine, evidence
from care import store as st
from shared.concepts import C
from test_care_engine import FAC, PID, PID2, T0, Clock, add_endoscopy, advance, env, fake_db, plan  # noqa: F401

ISO = "%Y-%m-%dT%H:%M:%S"


def _detail(pid):
    return engine.plan_detail(pid)


# ---------------------------------------------------------------------------------------------------- #3 calendar day
def test_fact_on_the_opening_day_counts_even_before_opens_at(env):
    """A task that opens at 23:59:59 on day X is closed by a visit at 10:00 on day X (the care world acts in clinic
    hours on the opening day). Before the fix the evidence was rejected and the task stayed open forever."""
    env["clock"].t = dt.datetime(2026, 7, 1, 23, 59, 59)
    p = plan(env, pathway="SURVIVORSHIP", pid=PID2, channels=["APP"])["plan"]
    fu = next(t for t in _detail(p["id"])["tasks"] if t["type"] == "FOLLOWUP_VISIT")
    opens = dt.datetime.fromisoformat(fu["opens_at"])
    assert opens.time() == dt.time(23, 59, 59)
    visit = dt.datetime.combine(opens.date(), dt.time(10, 0))
    env["con"].execute("INSERT INTO raw_encounter VALUES (7001, 3, ?, 1201, ?, 0)", [PID2, visit])
    advance(env, (opens.date() - env["clock"].t.date()).days + 1)
    fu = next(t for t in _detail(p["id"])["tasks"] if t["type"] == "FOLLOWUP_VISIT")
    assert fu["status"] == "COMPLETED" and fu["evidence"]["id"] == 7001
    assert fu["completed_at"] == visit.strftime(ISO)


def test_fact_earlier_on_the_creation_day_does_not_count(env):
    """...but a fact from before the task existed (same day, earlier hour) never closes it."""
    env["clock"].t = dt.datetime(2026, 7, 1, 23, 59, 59)
    add_endoscopy(env["con"], dt.datetime(2026, 7, 1, 10, 0))
    plan(env)
    assert advance(env, 3)["completed"] == 0


def test_lower_bound_rule():
    t = {"opens_at": "2026-07-10T23:59:59", "created_sim": "2026-07-01T23:59:59"}
    assert evidence.lower_bound(t) == dt.datetime(2026, 7, 10)
    t = {"opens_at": "2026-07-10T14:00:00", "created_sim": "2026-07-10T14:00:00"}  # spawned at 14:00, opens at once
    assert evidence.lower_bound(t) == dt.datetime(2026, 7, 10, 14)


# ---------------------------------------------------------------------------------------------------- #14 fact keys
def test_serve_db_facts_have_unique_keys():
    con = duckdb.connect()
    con.execute("""CREATE TABLE pt_timeline (patient_id BIGINT, ts TIMESTAMP, event_type VARCHAR, concept_id INT,
                   label VARCHAR, value_num DOUBLE, value_text VARCHAR, encounter_id BIGINT)""")
    rows = [(1, "2026-07-02 09:00", "LAB", C.HB, "Hb", 10.1, None, 55),     # two Hb results in one encounter
            (1, "2026-07-20 09:00", "LAB", C.HB, "Hb", 10.9, None, 55),
            (1, "2026-07-03 09:00", "DRUG", C.IRON, "iron", None, None, None),  # drug orders without an encounter
            (1, "2026-08-03 09:00", "DRUG", C.IRON, "iron", None, None, None)]
    con.executemany("INSERT INTO pt_timeline VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    facts = evidence.fetch_facts(con, [1], dt.datetime(2026, 7, 1), dt.datetime(2026, 9, 1))[1]
    keys = [evidence.fact_key(f) for f in facts]
    assert len(keys) == 4 and len(set(keys)) == 4  # was ("obs", 55) twice and ("drug_order", 0) twice
    hb = [f for f in facts if f["code"] == C.HB]
    task = {"type": "HB_RECHECK", "opens_at": "2026-07-01T00:00:00", "created_sim": "2026-07-01T00:00:00"}
    first = evidence.find(task, facts, set(), dt.datetime(2026, 9, 1))
    second = evidence.find(task, facts, {evidence.fact_key(first)}, dt.datetime(2026, 9, 1))
    assert first is hb[0] and second is hb[1]
    assert evidence.evidence_key(evidence.as_evidence(second)) == evidence.fact_key(second)


# ---------------------------------------------------------------------------------------------------- #9 concurrency
def test_double_submit_creates_one_plan_and_one_emr_encounter(env):
    errors, results = [], []

    def submit():
        try:
            results.append(plan({**env, "con": env["con"].cursor()}))  # one DuckDB cursor per thread
        except engine.CareError as e:
            errors.append(e)

    th = [threading.Thread(target=submit) for _ in range(4)]
    for t in th:
        t.start()
    for t in th:
        t.join()
    assert len(results) == 1 and len(errors) == 3 and all(e.status == 409 for e in errors)
    assert env["store"].one("SELECT count(*) AS n FROM care_plans")["n"] == 1
    assert [e["encounter_type"] for e in env["emr"].rows["encounter"]] == [15]  # checked before any EMR write


def test_unique_index_guards_open_plans(env):
    p = plan(env)["plan"]
    row = env["store"].one("SELECT * FROM care_plans WHERE id = ?", [p["id"]])
    with pytest.raises(sqlite3.IntegrityError):
        env["store"].insert("care_plans", {**row, "id": "CP-DUPLICATE"})
    env["store"].insert("care_plans", {**row, "id": "CP-CLOSED01", "status": "COMPLETED"})  # closed plans may repeat


def test_reconcile_does_not_overwrite_a_concurrent_patch(env, monkeypatch):
    """A doctor's decline that arrives while reconcile is computing is kept (before: reconcile wrote OVERDUE over it)."""
    p = plan(env, channels=["APP"])
    tid = p["tasks"][0]["id"]
    real = evidence.fetch_facts
    th: list[threading.Thread] = []

    def slow_fetch(*a, **k):
        t = threading.Thread(target=lambda: engine.patch_task(tid, "decline", reason="moved away"))
        th.append(t)
        t.start()
        time.sleep(0.3)  # the patch runs now if nothing serialises it
        return real(*a, **k)

    monkeypatch.setattr(evidence, "fetch_facts", slow_fetch)
    advance(env, 35)  # the task is overdue at day 35: reconcile wants to write OVERDUE
    th[0].join(10)
    t = env["store"].one("SELECT status, result FROM care_tasks WHERE id = ?", [tid])
    assert t == {"status": "DECLINED", "result": "DECLINED"}


# ---------------------------------------------------------------------------------------------------- #10 declines
def test_care_world_decline_closes_task_as_declined(env):
    p = plan(env, channels=["APP", "SMS"])
    tid = p["tasks"][0]["id"]
    env["store"].drain()
    t0 = env["clock"].t
    env["clock"].t = t0 + dt.timedelta(days=5)
    day = (t0 + dt.timedelta(days=3)).date().isoformat()
    out = engine.reconcile(t0, env["clock"].t, env["con"],
                           outcomes=[{"task_id": tid, "status": "declined", "date": day, "reason": "patient declined"},
                                     {"task_id": "CT-UNKNOWN", "status": "declined", "date": day}])
    assert out["declined"] == 1
    d = _detail(p["plan"]["id"])
    task = d["tasks"][0]
    assert task["status"] == "DECLINED" and task["result"] == "DECLINED" and task["completed_at"].startswith(day)
    assert task["evidence"]["source"] == "care_world" and task["evidence"]["reason"] == "patient declined"
    ev = [e for e in d["events"] if e["kind"] == "DECLINED"]
    assert len(ev) == 1 and ev[0]["actor"] == "patient"
    assert d["plan"]["status"] == "CANCELLED"
    assert any(o["concept_id"] == C.TASK_OUTCOME and o["value_coded"] == C.OUTCOME_DECLINED for o in env["emr"].rows["obs"])
    assert any(m["type"] == "care_update" and m["kind"] == "declined" and m["facility_id"] == FAC for m in env["store"].drain())
    o = env["store"].one("SELECT adhered FROM recommendation_outcomes WHERE plan_id = ?", [p["plan"]["id"]])
    assert o["adhered"] == 0
    # a repeated report (next tick) changes nothing
    again = engine.reconcile(env["clock"].t, env["clock"].t, env["con"], outcomes=[{"task_id": tid, "status": "declined", "date": day}])
    assert again["declined"] == 0


# ---------------------------------------------------------------------------------------------------- #16 determinism
def _run_once():
    old_store = st.set_store(st.Store(":memory:"))
    mem = emr_bridge.MemoryEMR()
    old_emr = emr_bridge.set_adapter(mem)
    clock = Clock(T0)
    st.set_clock(clock)
    try:
        e = {"con": fake_db(), "emr": mem, "clock": clock, "store": st.get_store()}
        a = plan(e, channels=["APP", "SMS", "CHW"])
        b = plan(e, pathway="HP_TEST_AND_TREAT", pid=PID2, channels=["APP"])
        advance(e, 45)
        ids = sorted(r["id"] for r in e["store"].rows("SELECT id FROM care_tasks"))
        notes = sorted(r["id"] for r in e["store"].rows("SELECT id FROM notifications"))
        uu = sorted(r["uuid"] for t in ("encounter", "obs", "visit") for r in mem.rows[t])
        return a["plan"]["id"], b["plan"]["id"], ids, notes, uu
    finally:
        st.set_clock(None)
        st.set_store(old_store)
        emr_bridge.set_adapter(old_emr)


def test_ids_and_row_uuids_are_deterministic_and_unique():
    r1, r2 = _run_once(), _run_once()
    assert r1 == r2
    pa, pb, tasks, notes, uu = r1
    assert pa != pb and pa.startswith("CP-") and len(pa) == 11
    assert len(tasks) == len(set(tasks)) >= 3 and len(notes) == len(set(notes)) > 0 and len(uu) == len(set(uu))


def test_id_collision_is_resolved():
    taken = {engine._new_id("CT", "x", 1)}
    other = engine._new_id("CT", "x", 1, taken=lambda i: i in taken)
    assert other not in taken and other.startswith("CT-")


# ---------------------------------------------------------------------------------------------------- #1 outcomes
@pytest.fixture()
def dx_env(env):
    env["con"].execute("CREATE TABLE core_gc_case (patient_id BIGINT, dx_date DATE, stage_group VARCHAR)")
    return env


def _outcome(env, plan_id):
    return env["store"].one("SELECT cancer_found, stage_at_dx, finding FROM recommendation_outcomes WHERE plan_id = ?", [plan_id])


def test_negative_endoscopy_label_is_final_only_after_60_days(dx_env):
    p = plan(dx_env)["plan"]
    add_endoscopy(dx_env["con"], T0 + dt.timedelta(days=5), impression=7110)
    dx_env["con"].execute("INSERT INTO raw_encounter VALUES (3001, 3, ?, 1201, ?, 0)", [PID, T0 + dt.timedelta(days=9)])
    advance(dx_env, 10)
    assert _detail(p["id"])["plan"]["status"] == "COMPLETED"
    assert _outcome(dx_env, p["id"])["cancer_found"] is None        # pending
    advance(dx_env, 60)                                               # closed plan, still refreshed
    assert _outcome(dx_env, p["id"])["cancer_found"] == 0


def test_suspicious_endoscopy_then_diagnosis_is_positive(dx_env):
    p = plan(dx_env)["plan"]
    add_endoscopy(dx_env["con"], T0 + dt.timedelta(days=5), impression=7113)  # suspicious -> pathology pending
    advance(dx_env, 10)
    assert _outcome(dx_env, p["id"])["cancer_found"] is None
    dx_env["con"].execute("INSERT INTO core_gc_case VALUES (?, ?, 'II')", [PID, (T0 + dt.timedelta(days=20)).date()])
    advance(dx_env, 15)
    assert _outcome(dx_env, p["id"]) == {"cancer_found": 1, "stage_at_dx": "II", "finding": "SUSPICIOUS"}


def test_non_screening_and_prior_diagnosis_give_null(dx_env):
    con = dx_env["con"]
    hp = plan(dx_env, pathway="HP_TEST_AND_TREAT", pid=PID2, channels=["APP"])["plan"]
    con.execute("INSERT INTO raw_obs VALUES (1, ?, 3120, 11, ?, 7002, NULL, 0)", [PID2, T0 + dt.timedelta(days=3)])
    con.execute("INSERT INTO core_gc_case VALUES (?, DATE '2025-01-01', 'III')", [PID])  # diagnosed before approval
    surv = plan(dx_env, pathway="SURVIVORSHIP", channels=["APP"])["plan"]
    endo = plan(dx_env)["plan"]
    add_endoscopy(con, T0 + dt.timedelta(days=4), impression=7110)
    advance(dx_env, 90)
    assert _detail(hp["id"])["tasks"][0]["status"] == "COMPLETED"
    for pid_ in (hp["id"], surv["id"], endo["id"]):
        assert _outcome(dx_env, pid_)["cancer_found"] is None, pid_
