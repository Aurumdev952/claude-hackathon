"""F1 #1, #2, #11: verified labels from care plans, verification propensity and stabilised IPW weights, adherence
training on decided outcomes only. In-memory DuckDB fixtures only."""
from __future__ import annotations

import datetime as dt
import json

import duckdb
import numpy as np
import pandas as pd
import pytest

T = dt.datetime(2026, 10, 1, 23, 59, 59)


def _con(plans, tasks, cases=()):
    con = duckdb.connect()
    con.register("_p", pd.DataFrame(plans))
    con.execute("CREATE TABLE care_plans AS SELECT * FROM _p")
    con.register("_t", pd.DataFrame(tasks))
    con.execute("CREATE TABLE care_tasks AS SELECT * FROM _t")
    con.execute("CREATE TABLE core_gc_case (patient_id BIGINT, dx_date DATE, stage_group VARCHAR)")
    for c in cases:
        con.execute("INSERT INTO core_gc_case VALUES (?, ?, ?)", list(c))
    return con


def _plan(pid, pathway, approved="2026-07-01T23:59:59", risk=0.2, band="HIGH", fac=1201, i=None):
    return {"id": f"CP-{i if i is not None else pid}", "patient_id": pid, "pathway": pathway, "approved_at": approved,
            "risk_at_approval": risk, "band_at_approval": band, "facility_id": fac, "status": "COMPLETED",
            "closed_sim": None, "propensity": None}


def _task(plan_id, pid, ttype, result, when, seq=1, status="COMPLETED"):
    return {"id": f"{plan_id}-{seq}", "plan_id": plan_id, "patient_id": pid, "seq": seq, "type": ttype, "status": status,
            "result": result, "completed_at": when, "due_at": when, "opens_at": when}


@pytest.fixture()
def F(tmp_path, monkeypatch):
    import ml.feedback as F
    monkeypatch.setattr(F, "ANALYTICS_DIR", tmp_path)
    return F


def test_only_screening_endoscopies_give_cancer_labels(F):
    plans = [_plan(1, "ENDOSCOPY_REFERRAL"), _plan(2, "ENDOSCOPY_REFERRAL"), _plan(3, "ENDOSCOPY_REFERRAL"),
             _plan(4, "SURVIVORSHIP"), _plan(5, "HP_TEST_AND_TREAT"), _plan(6, "ENDOSCOPY_REFERRAL"),
             _plan(7, "ANAEMIA_WORKUP"), _plan(8, "ONCOLOGY_TREATMENT")]
    tasks = [_task("CP-1", 1, "ENDOSCOPY", "NORMAL", "2026-07-10T10:00:00"),          # negative, 60+ days ago
             _task("CP-2", 2, "ENDOSCOPY", "GASTRITIS", "2026-09-20T10:00:00"),       # too recent: pending
             _task("CP-3", 3, "ENDOSCOPY", "SUSPICIOUS", "2026-07-05T10:00:00"),      # then a diagnosis
             _task("CP-4", 4, "FOLLOWUP_VISIT", "DONE", "2026-07-20T10:00:00"),       # known cancer: no label
             _task("CP-5", 5, "HP_TEST", "NEGATIVE", "2026-07-08T10:00:00"),
             _task("CP-5", 5, "HP_TEST_OF_CURE", "POSITIVE", "2026-09-01T10:00:00", seq=3),
             _task("CP-6", 6, "ENDOSCOPY", "SUSPICIOUS", "2026-07-08T10:00:00"),      # diagnosed before approval
             _task("CP-7", 7, "HB_RECHECK", "STABLE", "2026-08-01T10:00:00"),         # never escalated to endoscopy
             _task("CP-8", 8, "MDT_PLAN", "CURATIVE", "2026-07-15T10:00:00")]
    cases = [(3, dt.date(2026, 7, 25), "II"), (4, dt.date(2025, 3, 1), "II"), (6, dt.date(2026, 5, 1), "III"),
             (8, dt.date(2026, 6, 1), "III")]
    df = F._care_outcomes(_con(plans, tasks, cases), T)
    got = {(r.patient_id, r.label_kind): r.label for r in df.itertuples()}
    assert got == {(1, "cancer"): 0, (3, "cancer"): 1, (5, "hp"): 0}   # first H. pylori test, not the test of cure
    assert set(df["source"]) == {"care_outcome"}
    assert df.loc[df["patient_id"] == 3, "outcome_date"].iloc[0] == dt.date(2026, 7, 25)


def test_propensity_is_p_verified_not_the_risk_score(F):
    rng = np.random.default_rng(4)
    plans, tasks = [], []
    for i in range(200):
        risk = float(rng.uniform(0.01, 0.6))
        band = "HIGH" if risk > 0.3 else "MEDIUM"
        plans.append(_plan(1000 + i, "ENDOSCOPY_REFERRAL", approved="2026-01-15T23:59:59", risk=risk, band=band, i=i))
        if rng.uniform() < 0.25 + risk:        # higher risk -> scoped more often (selective labels)
            tasks.append(_task(f"CP-{i}", 1000 + i, "ENDOSCOPY", "NORMAL", "2026-02-20T10:00:00"))
    plans.append(_plan(5000, "ENDOSCOPY_REFERRAL", approved="2026-01-15T23:59:59", risk=0.034, band="LOW", i=5000))
    tasks.append(_task("CP-5000", 5000, "ENDOSCOPY", "NORMAL", "2026-02-20T10:00:00"))
    df = F._care_outcomes(_con(plans, tasks), T)
    cancer = df[df["label_kind"] == "cancer"]
    assert len(cancer) == len(tasks)
    low = cancer[cancer["patient_id"] == 5000].iloc[0]
    assert low["propensity"] != pytest.approx(0.034) and 0.05 < low["propensity"] < 1   # not the risk score
    assert low["ipw_weight"] < 20                                                       # was clip(1/0.034) = 20
    w = cancer["ipw_weight"].astype(float)
    assert np.isfinite(w).all() and w.between(*F.IPW_CLIP).all()
    assert 0.8 < w.mean() < 1.25                          # stabilised: about 1 among the verified rows
    hi, lo = cancer.sort_values("risk_at_landmark").iloc[-1], cancer.sort_values("risk_at_landmark").iloc[0]
    assert hi["propensity"] > lo["propensity"]            # verified more often at high risk -> smaller weight
    assert hi["ipw_weight"] < lo["ipw_weight"]


def test_build_labels_with_a_legacy_backfill_table(F):
    con = _con([_plan(1, "ENDOSCOPY_REFERRAL")], [_task("CP-1", 1, "ENDOSCOPY", "NORMAL", "2026-07-10T10:00:00")])
    con.execute("""CREATE TABLE ml_feedback_backfill AS SELECT 9 AS patient_id, DATE '2025-12-31' AS landmark_date, 0 AS label,
                   'cancer' AS label_kind, 'flag_backfill' AS source, TRUE AS verified, 0.3 AS propensity,
                   0.2 AS risk_at_landmark, DATE '2026-02-01' AS outcome_date, 'm' AS model_id, NULL AS plan_id""")
    df = F.build_feedback_labels(con, T, log=lambda *_: None)
    assert set(df["source"]) == {"care_outcome", "flag_backfill"}
    cols = [r[0] for r in con.execute("DESCRIBE ml_feedback_labels").fetchall()]
    assert "ipw_weight" in cols


def test_adherence_ignores_pending_outcomes(tmp_path, monkeypatch, F):
    import ml.adherence as A
    monkeypatch.setattr(A, "MODEL_PATH", tmp_path / "m.joblib")
    monkeypatch.setattr(A, "META_PATH", tmp_path / "meta.json")
    A._CACHE.clear()
    rng = np.random.default_rng(5)
    n_done, n_pending = 120, 400
    dist = rng.uniform(1, 60, n_done + n_pending)
    on_time = (rng.uniform(size=n_done) < 1 / (1 + np.exp(-(1.5 - 0.04 * dist[:n_done])))).astype(float)
    ro = pd.DataFrame({"plan_id": [f"CP-{i}" for i in range(n_done + n_pending)], "patient_id": range(n_done + n_pending),
                       "pathway": "ENDOSCOPY_REFERRAL", "channels": json.dumps(["APP"]), "distance_km": dist, "sex": "F",
                       "age_band": "50-59", "risk_at_approval": 0.3,
                       "adhered": list(on_time) + [None] * n_pending, "on_time": list(on_time) + [None] * n_pending})
    con = duckdb.connect()
    con.register("_ro", ro)
    con.execute("CREATE TABLE recommendation_outcomes AS SELECT * FROM _ro")
    meta = A.train(con, log=lambda *_: None)
    assert meta["status"] == "model" and meta["n"] == n_done        # was 520 (pending counted as late)
    assert meta["rate"] == pytest.approx(on_time.mean())
