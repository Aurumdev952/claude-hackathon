"""Adherence model: P(a care recommendation is completed on time) for ranking the outreach worklist (plan §2c).

Logistic regression on `recommendation_outcomes` (care engine, L2) with pre-approval features only: pathway, channels
(SMS, CHW), distance, sex, age band, risk at approval. It is retrained in the learning loop (ml/retrain.py) and stores
AUROC/Brier (5-fold CV) once enough outcomes exist. Until then (< 50 outcomes or < 10 per class) it falls back to the
prior from config/care_world.yaml (or config/forecast.yaml `adherence.prior_rate`).

`predict_p_adhere(rows)` is what L2's worklist calls: rows are dicts or a DataFrame with any of
pathway, channels (JSON list or list), distance_km, sex, age_band, risk_at_approval.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from shared.config import CONFIG_DIR, MODELS_DIR, load_yaml

MODEL_PATH = MODELS_DIR / "adherence" / "model.joblib"
META_PATH = MODELS_DIR / "adherence" / "meta.json"
AGE_BANDS = ["<40", "40-49", "50-59", "60-69", "70+"]
_CACHE: dict = {}


def _channels(v) -> list[str]:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except json.JSONDecodeError:
            v = [x.strip() for x in v.split(",") if x.strip()]
    return [str(x).upper() for x in (v or [])]


def _age_band(v) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "unknown"
    s = str(v)
    if s in AGE_BANDS:
        return s
    try:
        a = float(s.split("-")[0].replace("+", "").replace("<", ""))
    except ValueError:
        return "unknown"
    return "<40" if a < 40 else "40-49" if a < 50 else "50-59" if a < 60 else "60-69" if a < 70 else "70+"


def features(rows) -> pd.DataFrame:
    d = pd.DataFrame(rows if isinstance(rows, pd.DataFrame) else list(rows))
    n = len(d)
    get = lambda c, default: d[c] if c in d else pd.Series([default] * n)  # noqa: E731
    ch = get("channels", None).map(_channels)
    pw = get("pathway", "").astype(str).str.upper()
    ab = get("age_band", None).map(_age_band)
    X = pd.DataFrame({
        "sms": ch.map(lambda c: float("SMS" in c)).values, "chw": ch.map(lambda c: float("CHW" in c)).values,
        "app": ch.map(lambda c: float("APP" in c)).values,
        "distance_km": pd.to_numeric(get("distance_km", np.nan), errors="coerce").fillna(10.0).clip(0, 200).values,
        "male": (get("sex", "").astype(str).str.upper().str[:1] == "M").astype(float).values,
        "risk": pd.to_numeric(get("risk_at_approval", np.nan), errors="coerce").fillna(0.1).clip(0, 1).values,
        "pw_endoscopy": pw.str.contains("ENDOSCOP").astype(float).values, "pw_hp": pw.str.contains("HP").astype(float).values,
    })
    for b in AGE_BANDS:
        X[f"age_{b}"] = (ab == b).astype(float).values
    return X


def prior() -> dict:
    """Adherence prior from config/care_world.yaml (L1), tolerant to its exact layout."""
    rate, effects = float(load_yaml("forecast.yaml")["adherence"]["prior_rate"]), {}
    p = CONFIG_DIR / "care_world.yaml"
    if p.exists():
        try:
            cw = load_yaml("care_world.yaml")
            sec = cw.get("adherence", cw) if isinstance(cw, dict) else {}
            for k in ("base", "base_rate", "p_base", "base_adherence", "prior", "rate", "p_adhere"):
                if isinstance(sec, dict) and isinstance(sec.get(k), (int, float)):
                    rate = float(sec[k])
                    break
            for k in ("channel_effects", "channels", "channel_or", "channel_multipliers"):
                if isinstance(sec, dict) and isinstance(sec.get(k), dict):
                    effects = {str(a).upper(): float(b) for a, b in sec[k].items() if isinstance(b, (int, float))}
                    break
        except Exception:
            pass
    return {"rate": float(np.clip(rate, 0.01, 0.99)), "channel_effects": effects}


def train(con, log=print) -> dict:
    """Fit on recommendation_outcomes (target on_time, else adhered). Saves data/models/adherence/."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    import joblib

    from .feedback import care_table
    cfg = load_yaml("forecast.yaml")["adherence"]
    ro = care_table(con, "recommendation_outcomes")
    target = "on_time" if ro is not None and "on_time" in ro and ro["on_time"].notna().any() else "adhered"
    # plans still pending (target NULL: not yet due / not yet decided) are not failures: they are left out
    if ro is not None and len(ro) and target in ro:
        ro = ro[ro[target].notna()].reset_index(drop=True)
    n = 0 if ro is None else len(ro)
    y = ro[target].astype(int).values if n else np.array([])
    if n < int(cfg["min_outcomes"]) or min(y.sum(), n - y.sum()) < int(cfg["min_per_class"]):
        meta = {"status": "prior", "n": int(n), "prior": prior(), "reason": f"{n} outcomes (< {cfg['min_outcomes']} or < "
                f"{cfg['min_per_class']} per class)"}
        _save_meta(meta)
        MODEL_PATH.unlink(missing_ok=True)
        _CACHE.clear()
        log(f"  adherence: prior fallback ({meta['reason']})")
        return meta
    X = features(ro)
    model = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=500))
    k = int(min(5, y.sum(), n - y.sum()))
    p_cv = cross_val_predict(model, X, y, cv=StratifiedKFold(k, shuffle=True, random_state=0), method="predict_proba")[:, 1]
    from sklearn.metrics import brier_score_loss, roc_auc_score
    model.fit(X, y)
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, MODEL_PATH)
    coefs = dict(zip(X.columns, np.round(model[-1].coef_[0], 4).tolist()))
    meta = {"status": "model", "n": int(n), "target": target, "rate": float(y.mean()), "auroc_cv": float(roc_auc_score(y, p_cv)),
            "brier_cv": float(brier_score_loss(y, p_cv)), "coefficients": coefs, "features": list(X.columns)}
    _save_meta(meta)
    _CACHE.clear()
    log(f"  adherence: logistic model on {n} outcomes, CV AUROC {meta['auroc_cv']:.3f}")
    return meta


def _save_meta(meta: dict):
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    json.dump(meta, open(META_PATH, "w"), indent=1, default=str)


def _model():
    if not MODEL_PATH.exists():
        return None
    m = MODEL_PATH.stat().st_mtime
    if _CACHE.get("mtime") != m:
        import joblib
        _CACHE.update(mtime=m, model=joblib.load(MODEL_PATH))
    return _CACHE["model"]


def info() -> dict:
    try:
        return json.load(open(META_PATH))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"status": "prior", "n": 0, "prior": prior()}


def predict_p_adhere(rows) -> np.ndarray:
    """P(completed on time) per row, from the trained model or the configured prior."""
    X = features(rows)
    if len(X) == 0:
        return np.array([])
    m = _model()
    if m is not None:
        try:
            return m.predict_proba(X)[:, 1]
        except Exception:
            pass
    pr = prior()
    logit = np.log(pr["rate"] / (1 - pr["rate"])) * np.ones(len(X))
    for ch, eff in pr["channel_effects"].items():   # effects given as odds ratios (> 0)
        col = ch.lower()
        if col in X and eff > 0:
            logit = logit + np.log(eff) * X[col].values
    return 1 / (1 + np.exp(-logit))


if __name__ == "__main__":
    from pipeline.db import work_connection
    c = work_connection()
    print(json.dumps(train(c), indent=1, default=str))
    c.close()
    print(predict_p_adhere([{"pathway": "ENDOSCOPY_REFERRAL", "channels": ["APP", "SMS"], "distance_km": 12, "sex": "F", "age_band": "50-59"}]))
