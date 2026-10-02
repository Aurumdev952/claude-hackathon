"""Regression tests for the F1 review fixes in the learning loop and its API: one lock for model jobs and sim advances
(#8), HIGH counts and cuts on the production ensemble (#12), rollback lineage and atomic activation (#17), the
patient-role guard on POST /admin/sim (#18a) and the live running_job (#18c). In-memory / tmp fixtures only."""
# ruff: noqa: F811
from __future__ import annotations

import threading
import time

import numpy as np
import pytest

from shared import config
from test_retrain_loop import _active, _registry_con, loop_api  # noqa: F401 (loop_api: fixture)
from test_sim_api import FakeLocal, sim  # noqa: F401 (sim: fixture)

MIN = {"X-Role": "ministry"}


# ---------------------------------------------------------------------------------------------------- #17 registry
def _reg(tmp_path, monkeypatch):
    from ml import registry
    monkeypatch.setattr(registry, "MODELS_DIR", tmp_path)
    con = _registry_con()
    for mid in ("tier2-b", "tier2-c"):
        registry.register(con, mid, 2, "v", {"high_cut": 0.4}, ["a"], "w", active=False, status="challenger")
    return registry, con


def test_rollback_follows_the_promotion_lineage(tmp_path, monkeypatch):
    R, con = _reg(tmp_path, monkeypatch)
    R.promote(con, "tier2-b", "t", "b better")          # v1 -> b
    R.promote(con, "tier2-c", "t", "c better")          # b -> c
    assert R.rollback(con, "tier2-c", "t", "c bad")["model_id"] == "tier2-b"
    assert R.rollback(con, "tier2-b", "t", "b bad")["model_id"] == "tier2-xgb-v1"   # further back, not c again
    with pytest.raises(ValueError):
        R.rollback(con, "tier2-xgb-v1", "t", "nothing before v1")
    assert _active(con) == [("tier2-xgb-v1",)]


def test_rollback_of_a_restored_champion_does_not_ping_pong(tmp_path, monkeypatch):
    R, con = _reg(tmp_path, monkeypatch)
    R.promote(con, "tier2-c", "t", "try c")             # A (v1) -> C
    R.rollback(con, "tier2-c", "t", "undo")             # C -> A
    with pytest.raises(ValueError):                     # before the fix: restored C again
        R.rollback(con, "tier2-xgb-v1", "t", "again")
    assert _active(con) == [("tier2-xgb-v1",)]


def test_activation_is_atomic(tmp_path, monkeypatch):
    R, con = _reg(tmp_path, monkeypatch)
    con.execute("DROP TABLE ml_model_audit")
    con.execute("CREATE TABLE ml_model_audit (audit_at TIMESTAMP)")   # the audit insert will fail mid-activation
    monkeypatch.setattr(R, "ensure_columns", lambda c: None)
    with pytest.raises(Exception):
        R.promote(con, "tier2-b", "t", "x")
    assert _active(con) == [("tier2-xgb-v1",)]                         # nothing half-applied
    st = dict(con.execute("SELECT model_id, status FROM ml_model_registry WHERE tier = 2").fetchall())
    assert st == {"tier2-xgb-v1": "champion", "tier2-b": "challenger", "tier2-c": "challenger"}
    assert con.execute("SELECT high_cut FROM ml_thresholds").fetchone()[0] == pytest.approx(0.30)


def test_rollback_api_without_predecessor_is_409(loop_api):
    r = loop_api.post("/api/v1/models/tier2-xgb-v1/rollback", json={"reason": "nothing before"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NO_PREDECESSOR"


# ---------------------------------------------------------------------------------------------------- #12 ensemble
def test_high_volume_and_ppv_use_the_production_ensemble():
    from ml.retrain import ensemble, high_volume, model_metrics
    t2_ca = np.array([0.10, 0.20, 0.30, 0.50])
    t2_ch = np.array([0.10, 0.25, 0.30, 0.50])
    t3 = np.array([0.90, 0.10, np.nan, 0.60])            # NaN: no Tier 3 for that patient -> Tier 2 alone
    assert np.allclose(ensemble(t2_ca, t3), [0.50, 0.15, 0.30, 0.55])
    v = high_volume(t2_ca, t2_ch, t3, 0.45, 0.45)
    assert v["champion"] == 2 and v["challenger"] == 2   # tier 2 alone would count 1 each (only 0.50 >= 0.45)
    assert high_volume(t2_ca, t2_ch, None, 0.45, 0.45)["champion"] == 1
    y = np.array([1, 0, 0, 0])
    m = model_metrics(y, t2_ca, 0.45, ensemble(t2_ca, t3))
    assert m["n_high"] == 2 and m["ppv_at_high"] == pytest.approx(0.5)


def test_current_tier3_is_aligned_to_the_scored_rows():
    import duckdb
    import pandas as pd

    from ml.retrain import _current_tier3
    con = duckdb.connect()
    con.execute("CREATE TABLE pt_risk AS SELECT * FROM (VALUES (2, 0.7), (1, NULL), (3, 0.2)) t(patient_id, t3_prob)")
    v = _current_tier3(con, pd.DataFrame({"patient_id": [1, 2, 3, 4]}))
    assert np.isnan(v[0]) and v[1] == pytest.approx(0.7) and v[2] == pytest.approx(0.2) and np.isnan(v[3])
    con.execute("UPDATE pt_risk SET t3_prob = NULL")
    assert _current_tier3(con, pd.DataFrame({"patient_id": [1, 2]})) is None   # Tier 3 not scored: Tier 2 alone


# ---------------------------------------------------------------------------------------------------- #8 one lock
@pytest.fixture()
def clock_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SIM_STATE_DIR", tmp_path / "sim_state")
    from simulator import local
    return local


def _wait(pred, timeout=5.0):
    t = time.time()
    while time.time() - t < timeout:
        if pred():
            return True
        time.sleep(0.02)
    return False


def test_model_job_holds_the_advance_lock_while_it_runs(clock_dir):
    from api import jobs
    from api.deps import APIError
    from api.routers import models
    local = clock_dir
    go = threading.Event()
    out = models._submit("promote", lambda progress: go.wait(5) and {"ok": True})
    try:
        assert not local.lock_free()
        with pytest.raises(local.BusyError, match="models: promote"):        # a sim advance (any process) waits
            local.advance(1, run_pipeline=False, care_world=False, log=lambda *_: None)
        with pytest.raises(APIError) as e:                                    # a second model job is refused
            models._submit("retrain", lambda progress: None)
        assert e.value.status_code == 409
    finally:
        go.set()
    assert _wait(lambda: jobs.get(out["job_id"])["status"] == "done")
    assert _wait(local.lock_free)                                             # released when the job ends


def test_model_job_refused_while_an_advance_runs(clock_dir):
    from api.deps import APIError
    from api.routers import models
    local = clock_dir
    lk = local.acquire("advance")          # an advance in progress (here or in `simulator.local --auto`)
    try:
        with pytest.raises(APIError) as e:
            models._submit("promote", lambda progress: None)
        assert e.value.status_code == 409 and e.value.detail["code"] == "MODEL_JOB_BUSY"
    finally:
        lk.release()


def test_sim_advance_refused_while_a_model_job_runs(sim):
    from api import jobs
    c, fake, admin = sim
    fake.lock_free = lambda: True
    with jobs._LOCK:
        jobs._RUNNING["models"] = "models-test"
    try:
        r = c.post("/api/v1/admin/sim", json={"action": "advance", "days": 1}, headers=MIN)
        assert r.status_code == 409 and r.json()["error"]["code"] == "SIM_BUSY"
    finally:
        with jobs._LOCK:
            jobs._RUNNING.pop("models", None)
    fake.lock_free = lambda: False         # held by another process (e.g. a retrain from the CLI)
    r = c.post("/api/v1/admin/sim", json={"action": "advance", "days": 1}, headers=MIN)
    assert r.status_code == 409 and r.json()["error"]["code"] == "SIM_BUSY" and fake.calls == 0


# ---------------------------------------------------------------------------------------------------- #18 guards
def test_admin_sim_needs_a_role_and_records_it(sim):
    """Coordinator revision of #18a: a demo control that every role may drive (the patient app has a Simulate strip),
    but never without a recognised X-Role; the requesting role is recorded on the job and in control.json."""
    from api import jobs
    c, fake, admin = sim
    r = c.post("/api/v1/admin/sim", json={"action": "pause"})                     # no X-Role: no silent default
    assert r.status_code == 400 and r.json()["error"]["code"] == "ROLE_REQUIRED"
    assert c.post("/api/v1/admin/sim", json={"action": "pause"}, headers={"X-Role": "nurse"}).status_code == 400
    r = c.post("/api/v1/admin/sim", json={"action": "pause"}, headers={"X-Role": "doctor", "X-Facility-Id": "1207"})
    assert r.status_code == 200 and r.json()["data"]["updated_by"] == "doctor:1207"
    r = c.post("/api/v1/admin/sim", json={"action": "advance", "days": 1}, headers={"X-Role": "patient", "X-Patient-Id": "5"})
    assert r.status_code == 200, r.text
    job_id = r.json()["data"]["job_id"]
    assert r.json()["data"]["requested_by"] == "patient:5"
    assert _wait(lambda: jobs.get(job_id)["status"] == "done") and fake.calls == 1
    assert c.get(f"/api/v1/admin/sim/jobs/{job_id}").json()["data"]["requested_by"] == "patient:5"


def test_learning_loop_running_job_is_live(loop_api):
    from api import jobs
    assert loop_api.get("/api/v1/models/learning-loop").json()["data"]["running_job"] is None   # cached state built
    with jobs._LOCK:
        jobs._JOBS["models-live"] = {"id": "models-live", "kind": "models", "status": "running", "progress": 0.3}
        jobs._RUNNING["models"] = "models-live"
    try:
        d = loop_api.get("/api/v1/models/learning-loop").json()["data"]
        assert d["running_job"]["id"] == "models-live"      # was frozen by the per-publish cache
    finally:
        with jobs._LOCK:
            jobs._RUNNING.pop("models", None)
            jobs._JOBS.pop("models-live", None)
    assert loop_api.get("/api/v1/models/learning-loop").json()["data"]["running_job"] is None
