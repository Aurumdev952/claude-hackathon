"""Learning loop (track L3): gates, IPW weights, feedback labels, registry promote/rollback, adherence prior/model,
drift metrics and the learning-loop API guards. Uses in-memory DuckDB fixtures only (never the live work/serve DBs)."""
from __future__ import annotations

import datetime as dt
import json

import duckdb
import numpy as np
import pandas as pd
import pytest

from shared.config import load_yaml

GC = load_yaml("forecast.yaml")["learning_loop"]["gates"]
BASE = {"auroc": 0.95, "auprc": 0.35, "brier": 0.020, "calib_slope": 1.05, "ppv_at_high": 0.40}


def _gates(chall: dict, sub_drop: float = 0.0, vol: tuple = (100, 110), population: int = 0):
    from ml.retrain import gates
    sub = [{"var": "sex", "value": "F", "champion": 0.9, "challenger": 0.9 - sub_drop, "drop": sub_drop}]
    volume = {"champion": vol[0], "challenger": vol[1], "change": (vol[1] - vol[0]) / vol[0], "population": population}
    return {g["name"]: g["pass"] for g in gates(BASE, {**BASE, **chall}, sub, volume, GC)}


def test_gates_pass_when_challenger_is_as_good():
    g = _gates({"auroc": 0.945, "auprc": 0.36, "brier": 0.021, "calib_slope": 0.96, "ppv_at_high": 0.395})
    assert all(g.values()), g


@pytest.mark.parametrize("chall,failing", [
    ({"auroc": 0.93}, "auroc"), ({"auprc": 0.33}, "auprc"), ({"brier": 0.035}, "brier"),
    ({"calib_slope": 0.80}, "calibration_slope"), ({"ppv_at_high": 0.38}, "ppv_at_high")])
def test_gates_fail_on_any_worse_metric(chall, failing):
    g = _gates(chall)
    assert not g[failing] and all(v for k, v in g.items() if k != failing)


def test_gates_subgroup_and_volume():
    assert not _gates({}, sub_drop=0.06)["subgroup_auroc_drop"]
    assert _gates({}, sub_drop=0.04)["subgroup_auroc_drop"]
    assert not _gates({}, vol=(100, 130))["high_volume_change"]
    assert not _gates({}, vol=(100, 70))["high_volume_change"]
    assert _gates({}, vol=(100, 80))["high_volume_change"]


def test_volume_gate_relative_or_absolute():
    """+/-25% relative OR an absolute change of at most max(10, 0.5% of the scored population)."""
    # small champion counts (dev data): +10 flags on 20 is +50% but only 10 patients -> pass; +11 -> fail
    assert _gates({}, vol=(20, 30), population=1_000)["high_volume_change"]
    assert not _gates({}, vol=(20, 31), population=1_000)["high_volume_change"]
    assert _gates({}, vol=(20, 10), population=1_000)["high_volume_change"]
    # 0.5% of a large population widens the absolute slack: 40 -> 80 with 10,000 scored (slack 50) passes
    assert _gates({}, vol=(40, 80), population=10_000)["high_volume_change"]
    assert not _gates({}, vol=(40, 100), population=10_000)["high_volume_change"]
    # large counts still need the relative band: 1,000 -> 1,300 is +30% and +300 (slack 50) -> fail
    assert not _gates({}, vol=(1_000, 1_300), population=10_000)["high_volume_change"]
    assert _gates({}, vol=(1_000, 1_240), population=10_000)["high_volume_change"]
    # no current population scored: champion/challenger unknown, change 0 -> pass
    from ml.retrain import gates
    g = gates(BASE, BASE, [], {"champion": None, "challenger": None, "change": 0.0}, GC)
    assert {x["name"]: x["pass"] for x in g}["high_volume_change"]


def test_ipw_weights_finite_and_clipped():
    from ml.feedback import propensity_model
    rng = np.random.default_rng(0)
    risk = np.concatenate([rng.uniform(0, 1, 500), [0.0, 1.0, 1e-12, 1 - 1e-12]])
    scoped = rng.uniform(size=len(risk)) < 0.1 + 0.8 * risk
    f = propensity_model(pd.DataFrame({"risk": risk, "scoped": scoped}))
    p = f(risk)
    lo, hi = load_yaml("forecast.yaml")["learning_loop"]["ipw_clip"]
    w = np.clip(1 / np.clip(p, 1e-3, 1), lo, hi)
    assert np.isfinite(p).all() and ((p > 0) & (p < 1)).all()
    assert np.isfinite(w).all() and w.min() >= lo and w.max() <= hi
    assert p[np.argmax(risk)] > p[np.argmin(risk)]          # higher risk -> more likely to be scoped
    # thin data falls back to a constant (still finite) rate
    g = propensity_model(pd.DataFrame({"risk": [0.5, 0.6], "scoped": [True, True]}))
    assert np.isfinite(g([0.1, 0.9])).all()


# ------------------------------------------------------------------------------------------------ registry
def _registry_con():
    con = duckdb.connect()
    # v1 schema and v1 rows (9 columns), as written by ml.train before v3
    con.execute("""CREATE TABLE ml_model_registry (model_id VARCHAR, tier INTEGER, version VARCHAR, trained_at TIMESTAMP,
                   train_window VARCHAR, features_hash VARCHAR, params_json VARCHAR, artefact_path VARCHAR, is_active BOOLEAN)""")
    for mid, tier in (("tier1-points-v1", 1), ("tier2-xgb-v1", 2)):
        con.execute("INSERT INTO ml_model_registry VALUES (?, ?, 'v1', now(), '2016Q1-2023Q2', 'h', ?, '/tmp/x', TRUE)",
                    [mid, tier, json.dumps({"high_cut": 0.30, "medium_cut": 0.06})])
    con.execute("CREATE TABLE ml_thresholds AS SELECT 0.30::DOUBLE AS high_cut, 0.06::DOUBLE AS medium_cut, 'v1' AS version, 5 AS hiv_shap_rank")
    from ml.retrain import RUNS_DDL
    con.execute(RUNS_DDL)
    return con


def _active(con, tier=2):
    return con.execute("SELECT model_id FROM ml_model_registry WHERE is_active AND tier = ?", [tier]).fetchall()


def test_promote_then_rollback_restores_champion(tmp_path, monkeypatch):
    from ml import registry
    monkeypatch.setattr(registry, "MODELS_DIR", tmp_path)
    con = _registry_con()
    registry.register(con, "tier2-xgb-ch-1", 2, "v2", {"high_cut": 0.42, "medium_cut": 0.08}, ["a", "b"], "2016Q1-2025Q2",
                      active=False, status="challenger", parent_model_id="tier2-xgb-v1", n_feedback_labels=36)
    con.execute("INSERT INTO ml_retrain_runs (run_id, challenger_id, champion_id, decision) VALUES ('rt-1', 'tier2-xgb-ch-1', 'tier2-xgb-v1', 'pending')")
    assert _active(con) == [("tier2-xgb-v1",)]                      # registering a challenger leaves the champion alone
    st = dict(con.execute("SELECT model_id, status FROM ml_model_registry").fetchall())
    assert st == {"tier1-points-v1": "champion", "tier2-xgb-v1": "champion", "tier2-xgb-ch-1": "challenger"}

    r = registry.promote(con, "tier2-xgb-ch-1", "analyst@moh (test)", "better AUPRC", dt.datetime(2026, 7, 1))
    assert r["previous_model_id"] == "tier2-xgb-v1"
    assert _active(con) == [("tier2-xgb-ch-1",)] and _active(con, 1) == [("tier1-points-v1",)]
    assert con.execute("SELECT high_cut FROM ml_thresholds").fetchone()[0] == pytest.approx(0.42)
    assert con.execute("SELECT status FROM ml_model_registry WHERE model_id = 'tier2-xgb-v1'").fetchone()[0] == "retired"
    assert con.execute("SELECT decision FROM ml_retrain_runs WHERE run_id = 'rt-1'").fetchone()[0] == "promoted"

    r = registry.rollback(con, "tier2-xgb-ch-1", "analyst@moh (test)", "volume too high")   # current champion -> predecessor
    assert r["model_id"] == "tier2-xgb-v1" and r["previous_model_id"] == "tier2-xgb-ch-1"
    assert _active(con) == [("tier2-xgb-v1",)]
    assert con.execute("SELECT high_cut FROM ml_thresholds").fetchone()[0] == pytest.approx(0.30)
    assert con.execute("SELECT decision FROM ml_retrain_runs WHERE run_id = 'rt-1'").fetchone()[0] == "rolled_back"
    audit = con.execute("SELECT action, model_id, previous_model_id, actor FROM ml_model_audit ORDER BY audit_at").fetchall()
    assert [a[0] for a in audit] == ["promote", "rollback"] and all(a[3] == "analyst@moh (test)" for a in audit)
    with pytest.raises(KeyError):
        registry.promote(con, "nope", "x", "y")
    # rolling back the restored champion goes back to the model it replaced (an undo of the rollback)
    assert registry.rollback(con, "tier2-xgb-v1", "x", "undo")["model_id"] == "tier2-xgb-ch-1"
    with pytest.raises(ValueError):    # a champion with no recorded predecessor cannot be rolled back
        registry.rollback(_registry_con(), "tier2-xgb-v1", "x", "y")


def test_register_v1_behaviour_still_replaces_champion(tmp_path, monkeypatch):
    from ml import registry
    monkeypatch.setattr(registry, "MODELS_DIR", tmp_path)
    con = _registry_con()
    registry.register(con, "tier2-xgb-v2", 2, "v2", {"high_cut": 0.3}, ["a"], "w")
    assert _active(con) == [("tier2-xgb-v2",)]
    assert con.execute("SELECT count(*) FROM ml_model_registry WHERE tier = 2").fetchone()[0] == 2


# ------------------------------------------------------------------------------------------------ feedback labels
def test_feedback_labels_from_flags_and_empty_care(tmp_path, monkeypatch):
    import ml.feedback as F
    monkeypatch.setattr(F, "ANALYTICS_DIR", tmp_path)        # no care.sqlite: care outcomes are simply absent
    con = duckdb.connect()
    T = dt.datetime(2026, 6, 30, 23, 59, 59)
    hist = []
    rng = np.random.default_rng(1)
    for pid in range(1, 201):   # 200 patients scored on 2025-06-30 (complete 180-day follow-up)
        hist.append((pid, dt.datetime(2025, 6, 30), float(rng.uniform(0, 1)), "LOW"))
    hist += [(1001, dt.datetime(2025, 9, 30), 0.9, "HIGH"), (1002, dt.datetime(2025, 9, 30), 0.8, "HIGH"),
             (1003, dt.datetime(2026, 6, 1), 0.85, "HIGH")]
    con.execute("CREATE TABLE ml_risk_history (patient_id INT, as_of TIMESTAMP, ensemble_prob DOUBLE, risk_band VARCHAR)")
    con.executemany("INSERT INTO ml_risk_history VALUES (?, ?, ?, ?)", hist)
    enc = [(pid, dt.datetime(2025, 8, 1)) for pid in range(1, 201) if rng.uniform() < 0.2]
    enc += [(1001, dt.datetime(2025, 11, 1)), (1002, dt.datetime(2025, 10, 15)), (1003, dt.datetime(2026, 6, 20))]
    con.execute("CREATE TABLE core_fact_encounter (patient_id INT, encounter_type INT, encounter_datetime TIMESTAMP)")
    con.executemany("INSERT INTO core_fact_encounter VALUES (?, 5, ?)", enc)
    con.execute("CREATE TABLE core_fact_lab (patient_id INT, concept_id INT, datetime TIMESTAMP, value_coded INT)")
    con.execute("INSERT INTO core_fact_lab VALUES (1002, 3120, TIMESTAMP '2025-10-01', 7001)")
    con.execute("CREATE TABLE core_gc_case (patient_id INT, dx_date DATE)")
    con.execute("INSERT INTO core_gc_case VALUES (1001, DATE '2025-11-20')")
    df = F.build_feedback_labels(con, T, log=lambda *_: None)
    lab = {(r.patient_id, r.label_kind): r for r in df.itertuples()}
    assert lab[(1001, "cancer")].label == 1                   # cancer found after the flag
    assert lab[(1002, "cancer")].label == 0                   # scoped, no cancer, 60+ days ago
    assert (1003, "cancer") not in lab                       # endoscopy too recent: pathology pending
    assert lab[(1002, "hp")].label == 1
    p = df.loc[df["label_kind"] == "cancer", "propensity"]
    assert p.notna().all() and ((p > 0) & (p < 1)).all()
    n = con.execute("SELECT count(*) FROM ml_feedback_labels").fetchone()[0]
    assert n == len(df) == 3
    # with no flags / no care data at all the table still exists, empty
    con2 = duckdb.connect()
    assert len(F.build_feedback_labels(con2, T, log=lambda *_: None)) == 0
    assert con2.execute("SELECT count(*) FROM ml_feedback_labels").fetchone()[0] == 0


def test_loop_features(tmp_path, monkeypatch):
    import ml.feedback as F
    monkeypatch.setattr(F, "ANALYTICS_DIR", tmp_path)
    con = duckdb.connect()
    con.execute("CREATE TABLE core_fact_encounter (patient_id INT, encounter_type INT, encounter_datetime TIMESTAMP)")
    con.execute("INSERT INTO core_fact_encounter VALUES (1, 5, TIMESTAMP '2025-01-01'), (1, 5, TIMESTAMP '2025-12-15'), (2, 3, TIMESTAMP '2025-01-01')")
    con.execute("CREATE TABLE care_plans (patient_id INT, approved_at VARCHAR, closed_sim VARCHAR)")
    con.execute("INSERT INTO care_plans VALUES (2, '2025-12-01T00:00:00', NULL)")
    con.execute("CREATE TABLE care_tasks (patient_id INT, due_at VARCHAR, completed_at VARCHAR)")
    con.execute("INSERT INTO care_tasks VALUES (2, '2025-12-20T00:00:00', NULL), (2, '2025-12-10T00:00:00', '2025-12-05T00:00:00')")
    feats = pd.DataFrame({"patient_id": [1, 2], "L": pd.to_datetime(["2026-01-01", "2026-01-01"])})
    X = F.add_loop_features(con, feats, pd.DataFrame({"x": [0.0, 1.0]}))
    assert X.loc[0, "prior_negative_endoscopy_months"] == pytest.approx(365 / 30.44, rel=1e-3)   # Dec scope too recent (< 60 d)
    assert np.isnan(X.loc[1, "prior_negative_endoscopy_months"])
    assert list(X["care_plan_open"]) == [0.0, 1.0] and list(X["missed_followups_12m"]) == [0.0, 1.0]


# ------------------------------------------------------------------------------------------------ adherence + monitoring
def test_adherence_prior_then_model(tmp_path, monkeypatch):
    import ml.adherence as A
    import ml.feedback as F
    monkeypatch.setattr(A, "MODEL_PATH", tmp_path / "m.joblib")
    monkeypatch.setattr(A, "META_PATH", tmp_path / "meta.json")
    monkeypatch.setattr(F, "ANALYTICS_DIR", tmp_path)
    A._CACHE.clear()
    con = duckdb.connect()
    meta = A.train(con, log=lambda *_: None)
    assert meta["status"] == "prior"
    p = A.predict_p_adhere([{"pathway": "ENDOSCOPY_REFERRAL", "channels": '["APP"]'}])
    assert p.shape == (1,) and 0 < p[0] < 1
    rng = np.random.default_rng(3)
    n = 300
    dist = rng.uniform(1, 60, n)
    chw = rng.uniform(size=n) < 0.5
    on_time = (rng.uniform(size=n) < 1 / (1 + np.exp(-(1.0 - 0.05 * dist + 1.2 * chw)))).astype(int)
    ro = pd.DataFrame({"plan_id": [f"CP-{i}" for i in range(n)], "patient_id": range(n), "pathway": "ENDOSCOPY_REFERRAL",
                       "channels": [json.dumps(["APP", "CHW"] if c else ["APP"]) for c in chw], "distance_km": dist,
                       "sex": "F", "age_band": "50-59", "risk_at_approval": 0.3, "adhered": on_time, "on_time": on_time})
    con.register("_ro", ro)
    con.execute("CREATE TABLE recommendation_outcomes AS SELECT * FROM _ro")
    meta = A.train(con, log=lambda *_: None)
    assert meta["status"] == "model" and meta["auroc_cv"] > 0.6
    near, far = A.predict_p_adhere([{"channels": ["APP", "CHW"], "distance_km": 2}, {"channels": ["APP"], "distance_km": 55}])
    assert near > far


def test_psi_detects_shift():
    from ml.monitoring import psi
    rng = np.random.default_rng(0)
    a = rng.normal(0, 1, 5000)
    assert psi(a, rng.normal(0, 1, 5000)) < 0.02
    assert psi(a, rng.normal(1.0, 1, 5000)) > 0.25
    assert psi(np.array([0, 1] * 500, float), np.array([1] * 900 + [0] * 100, float)) > 0.25


# ------------------------------------------------------------------------------------------------ API guards
@pytest.fixture()
def loop_api(tmp_path):
    from fastapi.testclient import TestClient

    from api.deps import SERVE
    from api.main import app
    path = tmp_path / "serve.duckdb"
    con = _registry_con()
    con.execute(f"ATTACH '{path}' AS s")
    from ml import registry
    registry.ensure_columns(con)
    con.execute("""INSERT INTO ml_model_registry (model_id, tier, version, trained_at, train_window, features_hash, params_json,
                   artefact_path, is_active, status, parent_model_id, n_feedback_labels)
                   VALUES ('tier2-xgb-ch-1', 2, 'v2', now(), 'w', 'h', '{"high_cut": 0.4}', '/tmp/x', FALSE, 'challenger', 'tier2-xgb-v1', 3)""")
    gates = [{"name": "auroc", "pass": True}, {"name": "high_volume_change", "pass": False, "value": 0.4}]
    con.execute("""INSERT INTO ml_retrain_runs (run_id, sim_time, champion_id, challenger_id, metrics, gates, decision, started_at)
                   VALUES ('rt-1', TIMESTAMP '2026-06-30', 'tier2-xgb-v1', 'tier2-xgb-ch-1', '{}', ?, 'gates_failed', now())""",
                [json.dumps(gates)])
    con.execute("CREATE TABLE ml_eval_metrics (model_id VARCHAR, split VARCHAR, auroc DOUBLE)")
    for t in ("ml_model_registry", "ml_retrain_runs", "ml_model_audit", "ml_thresholds", "ml_eval_metrics"):
        con.execute(f"CREATE TABLE s.{t} AS SELECT * FROM main.{t}")
    con.execute("DETACH s")
    saved = (SERVE._con, SERVE.current, SERVE._cache)
    SERVE._con = duckdb.connect(str(path), read_only=True)
    SERVE.current, SERVE._cache = {"run_id": -2, "active": "test"}, {}
    yield TestClient(app)
    SERVE._con.close()
    SERVE._con, SERVE.current, SERVE._cache = saved


def test_learning_loop_api(loop_api):
    doc = {"X-Role": "doctor", "X-Facility-Id": "1"}
    assert loop_api.get("/api/v1/models/learning-loop", headers=doc).status_code == 403
    assert loop_api.post("/api/v1/models/tier2-xgb-ch-1/promote", json={"reason": "test"}, headers=doc).status_code == 403
    d = loop_api.get("/api/v1/models/learning-loop").json()["data"]
    assert d["champion"]["model_id"] == "tier2-xgb-v1" and d["challenger"]["model_id"] == "tier2-xgb-ch-1"
    assert d["decision"] == "gates_failed" and any(not g["pass"] for g in d["gates"])
    r = loop_api.post("/api/v1/models/tier2-xgb-ch-1/promote", json={"reason": "looks good"}, headers={"X-Actor": "tester"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "GATES_FAILED"
    assert loop_api.post("/api/v1/models/nope/promote", json={"reason": "xyz"}).status_code == 404
    assert loop_api.post("/api/v1/models/tier2-xgb-v1/promote", json={"reason": "xyz"}).status_code == 409   # already champion
    assert loop_api.post("/api/v1/models/tier2-xgb-ch-1/promote", json={}).status_code == 422                # reason required
    assert loop_api.get("/api/v1/models/jobs/unknown").status_code == 404
