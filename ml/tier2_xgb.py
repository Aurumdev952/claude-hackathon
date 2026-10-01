"""Tier 2: XGBoost + isotonic calibration + SHAP reasons (SPEC §13.6)."""
from __future__ import annotations

import json
import math
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
import yaml
from sklearn.isotonic import IsotonicRegression

from shared.config import models_cfg

REASONS = yaml.safe_load(open(Path(__file__).parent / "reasons.yaml"))


def train(Xtr: pd.DataFrame, ytr, Xva: pd.DataFrame, yva, seed: int = 42):
    p = models_cfg()["tier2"]["params"]
    spw = float((len(ytr) - ytr.sum()) / max(1, ytr.sum()))
    clf = xgb.XGBClassifier(objective="binary:logistic", n_estimators=p["n_estimators"], max_depth=p["max_depth"],
                            learning_rate=p["learning_rate"], subsample=p["subsample"], colsample_bytree=p["colsample_bytree"],
                            min_child_weight=p["min_child_weight"], scale_pos_weight=spw, eval_metric="aucpr",
                            early_stopping_rounds=p["early_stopping_rounds"], tree_method="hist", random_state=seed, n_jobs=4)
    clf.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
    raw_va = clf.predict_proba(Xva)[:, 1]
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw_va, yva)
    return clf, iso


def predict(clf, iso, X: pd.DataFrame) -> np.ndarray:
    return iso.predict(clf.predict_proba(X[clf.get_booster().feature_names])[:, 1])


def shap_values(clf, X: pd.DataFrame) -> np.ndarray:
    """TreeSHAP contributions (log-odds) via XGBoost's native pred_contribs (identical to shap.TreeExplainer)."""
    d = xgb.DMatrix(X[clf.get_booster().feature_names])
    return clf.get_booster().predict(d, pred_contribs=True)[:, :-1]


def _fmt(feature: str, value) -> str | None:
    t = REASONS.get(feature)
    if t is None:
        return None
    try:
        v = float(value)
        if math.isnan(v):
            return None
        return t.format(value=v, direction="down" if v < 0 else "up")
    except (TypeError, ValueError):
        return t


def top_reasons(feature_names, contribs: np.ndarray, X: pd.DataFrame, raw: pd.DataFrame, k: int = 5) -> list[list[dict]]:
    out = []
    for i in range(contribs.shape[0]):
        order = np.argsort(-contribs[i])
        rs = []
        for j in order:
            if contribs[i, j] <= 0 or len(rs) >= k:
                break
            f = feature_names[j]
            base = f.split("=")[0]
            if "=" in f and X.iloc[i][f] != 1:
                continue
            label = _fmt(f, raw.iloc[i][base] if base in raw.columns and "=" not in f else 1)
            if label is None:
                continue
            rs.append({"feature": f, "label": label, "contribution": round(float(contribs[i, j]), 3),
                       "value": None if "=" in f or pd.isna(raw.iloc[i].get(base)) else float(raw.iloc[i][base])})
        out.append(rs)
    return out


def save(clf, iso, path: Path, meta: dict):
    clf.save_model(path / "xgb.json")
    joblib.dump(iso, path / "isotonic.joblib")
    json.dump(meta, open(path / "meta.json", "w"), indent=1, default=str)


def load(path: Path):
    clf = xgb.XGBClassifier()
    clf.load_model(path / "xgb.json")
    return clf, joblib.load(path / "isotonic.joblib"), json.load(open(path / "meta.json"))
