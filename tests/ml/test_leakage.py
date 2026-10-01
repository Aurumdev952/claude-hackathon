"""Leakage tests (SPEC §19.4).

1. Future invariance: for 1,000 random landmarks, deleting every source row recorded after L leaves every feature
   unchanged (so no feature can depend on data after L).
2. Exclusions: deleting every row of the excluded diagnostic pathway (§13.3) leaves every feature unchanged.
3. Shuffle-label: XGBoost trained on shuffled labels has test AUROC 0.45-0.55.
"""
from __future__ import annotations

import inspect

import numpy as np
import pandas as pd
import pytest

from shared.config import ANALYTICS_DIR

FACTS = {  # table -> (patient column, datetime column)
    "core_fact_encounter": ("patient_id", "encounter_datetime"), "core_gi_encounter": ("patient_id", "datetime"),
    "core_fact_symptom": ("patient_id", "datetime"), "core_fact_diagnosis": ("patient_id", "dx_datetime"),
    "core_fact_lab": ("patient_id", "datetime"), "core_fact_vital": ("patient_id", "datetime"),
    "core_fact_drug": ("patient_id", "datetime"), "stg_obs": ("person_id", "obs_datetime"),
    "stg_address": ("person_id", "start_date"),
}
SUBSET = {"core_dim_patient": "patient_id", "core_gi_cohort": "patient_id"}
FULL = ("core_dim_location", "ref_district", "ml_district_prior", "ml_facility_tier")


@pytest.fixture(scope="module")
def mem():
    import duckdb
    work = ANALYTICS_DIR / "work.duckdb"
    if not work.exists():
        pytest.skip("no work DB")
    con = duckdb.connect()
    try:
        con.execute(f"ATTACH '{work.as_posix()}' AS w (READ_ONLY)")
    except duckdb.IOException:
        pytest.skip("work DB is locked by a running pipeline / training job")
    have = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_catalog = 'w'").fetchall()}
    if not {"ml_landmarks", "ml_district_prior", "ml_facility_tier"} <= have:
        pytest.skip("models not trained yet (python -m ml.train)")
    con.execute("""CREATE TABLE _lm AS SELECT patient_id, L FROM (
                     SELECT patient_id, L, row_number() OVER (PARTITION BY patient_id ORDER BY hash(patient_id, L)) AS k
                     FROM w.ml_landmarks) WHERE k = 1 ORDER BY hash(patient_id) LIMIT 1000""")
    yield con
    con.close()


def _load(con, drop_after_l: bool = False, drop_excluded: bool = False):
    from ml.features import (EXCLUDED_DRUGS, EXCLUDED_DX, EXCLUDED_ENC_TYPES, EXCLUDED_LABS)
    for t, (pc, tc) in FACTS.items():
        cond = ""
        if drop_after_l:
            cond += f" AND x.{tc} < CAST(lm.L AS DATE) + INTERVAL 1 DAY"
        con.execute(f"""CREATE OR REPLACE TABLE memory.main.{t} AS SELECT x.* FROM w.main.{t} x
                        JOIN _lm lm ON lm.patient_id = x.{pc} WHERE TRUE {cond}""")
    if drop_excluded:
        enc = ",".join(map(str, EXCLUDED_ENC_TYPES))
        con.execute(f"""CREATE OR REPLACE TEMP TABLE _bad_enc AS SELECT encounter_id FROM memory.main.core_fact_encounter
                        WHERE encounter_type IN ({enc})""")
        for t in ("core_fact_encounter", "core_gi_encounter", "core_fact_symptom", "core_fact_diagnosis", "core_fact_lab",
                  "core_fact_vital", "core_fact_drug", "stg_obs"):
            con.execute(f"DELETE FROM memory.main.{t} WHERE encounter_id IN (SELECT encounter_id FROM _bad_enc)")
        con.execute(f"DELETE FROM memory.main.core_fact_diagnosis WHERE concept_id IN ({','.join(map(str, EXCLUDED_DX))})")
        con.execute(f"DELETE FROM memory.main.core_fact_lab WHERE concept_id IN ({','.join(map(str, EXCLUDED_LABS))})")
        con.execute(f"DELETE FROM memory.main.core_fact_drug WHERE drug_concept_id IN ({','.join(map(str, EXCLUDED_DRUGS))})")
        con.execute(f"DELETE FROM memory.main.stg_obs WHERE concept_id BETWEEN 5000 AND 5062 OR concept_id IN (3108)")
    for t, pc in SUBSET.items():
        con.execute(f"CREATE OR REPLACE TABLE memory.main.{t} AS SELECT x.* FROM w.main.{t} x SEMI JOIN _lm ON _lm.patient_id = x.{pc}")
    for t in FULL:
        con.execute(f"CREATE OR REPLACE TABLE memory.main.{t} AS SELECT * FROM w.main.{t}")


def _features(con, **kw) -> pd.DataFrame:
    from ml.features import build_feature_table, prepare_sources
    _load(con, **kw)
    prepare_sources(con)
    lm = con.execute("SELECT patient_id, L FROM _lm").df()
    f = build_feature_table(con, lm, "_feat")
    return f.sort_values("patient_id").reset_index(drop=True)


def _assert_same(a: pd.DataFrame, b: pd.DataFrame):
    assert list(a["patient_id"]) == list(b["patient_id"])
    diffs = []
    for c in a.columns:
        x, y = a[c], b[c]
        if pd.api.types.is_numeric_dtype(x) and pd.api.types.is_numeric_dtype(y):
            same = np.isclose(x.astype(float), y.astype(float), equal_nan=True, rtol=1e-9, atol=1e-9)
        else:
            same = (x.astype(str) == y.astype(str)).values
        if not same.all():
            diffs.append((c, int((~same).sum())))
    assert not diffs, diffs


def test_features_ignore_data_after_landmark(mem):
    full = _features(mem)
    trunc = _features(mem, drop_after_l=True)
    assert len(full) >= 900
    _assert_same(full, trunc)


def test_features_ignore_excluded_pathway(mem):
    full = _features(mem, drop_after_l=True)
    clean = _features(mem, drop_after_l=True, drop_excluded=True)
    _assert_same(full, clean)


def test_no_case_table_in_feature_code():
    import ml.features as F
    src = inspect.getsource(F)
    assert "core_gc_case" not in src.split('"""', 2)[2]   # the docstring may mention it; the code must not


def test_shuffle_label_auroc(mem):
    import xgboost as xgb
    from sklearn.metrics import roc_auc_score
    from ml.features import design_matrix
    df = mem.execute("""SELECT f.*, l.label, l.split FROM w.ml_train_features f
                        JOIN w.ml_landmarks l ON l.patient_id = f.patient_id AND CAST(l.L AS DATE) = CAST(f.L AS DATE)""").df()
    if df.empty:
        pytest.skip("no training features")
    X = design_matrix(df).values
    y = df["label"].astype(int).values
    rng = np.random.default_rng(0)
    tr, te = (df["split"] == "train").values, (df["split"] == "test").values
    ys = y.copy()
    ys[tr] = rng.permutation(ys[tr])
    m = xgb.XGBClassifier(n_estimators=150, max_depth=4, learning_rate=0.1, subsample=0.8, n_jobs=4, eval_metric="logloss")
    m.fit(X[tr], ys[tr])
    auc = roc_auc_score(y[te], m.predict_proba(X[te])[:, 1])
    assert 0.45 <= auc <= 0.55, auc
