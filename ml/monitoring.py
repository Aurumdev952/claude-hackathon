"""Model monitoring mart (docs/contracts/v3-loop.md §5: mart_model_monitoring).

Rows (as_of, model_id, metric, value, n, detail):
- `psi:<feature>` for the champion's top-20 SHAP features: population stability index of the scored population over
  the last 90 sim days (pt_features snapshots kept in ml_monitor_features_hist) against the training landmarks
  (ml_train_features). PSI < 0.1 stable, 0.1-0.25 moderate shift, > 0.25 major shift;
- `calib_slope` and `ppv_verified`: calibration slope (logistic recalibration of logit risk) and PPV of HIGH flags on
  verified outcomes (ml_feedback_labels, cancer labels with a recorded risk);
- `alert_volume` (new alerts per sim day) and `high_count` (patients scored HIGH per scoring run).
History accumulates in ml_monitoring_hist so the charts show drift over time.
"""
from __future__ import annotations

import datetime as dt
import json

import numpy as np
import pandas as pd

HIST_DDL = """CREATE TABLE IF NOT EXISTS ml_monitoring_hist (as_of TIMESTAMP, model_id VARCHAR, metric VARCHAR, value DOUBLE,
              n INTEGER, detail VARCHAR)"""


def _has(con, t: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [t]).fetchone()[0] > 0


def psi(ref: np.ndarray, cur: np.ndarray, bins: int = 10) -> float:
    ref = np.asarray(ref, float)
    cur = np.asarray(cur, float)
    # missing values form their own bin
    rn, cn = np.isnan(ref), np.isnan(cur)
    r, c = ref[~rn], cur[~cn]
    if len(r) == 0 or len(c) + cn.sum() == 0:
        return float("nan")
    u = np.unique(r)
    if len(u) <= bins:
        edges = np.concatenate([[-np.inf], (u[:-1] + u[1:]) / 2, [np.inf]])
    else:
        edges = np.unique(np.quantile(r, np.linspace(0, 1, bins + 1)))
        edges[0], edges[-1] = -np.inf, np.inf
    e = np.histogram(r, edges)[0].astype(float)
    a = np.histogram(c, edges)[0].astype(float)
    e = np.append(e, rn.sum())
    a = np.append(a, cn.sum())
    e = np.clip(e / e.sum(), 1e-4, None)
    a = np.clip(a / max(a.sum(), 1), 1e-4, None)
    return float(np.sum((a - e) * np.log(a / e)))


def calibration_slope(y: np.ndarray, p: np.ndarray) -> float | None:
    y = np.asarray(y, int)
    p = np.clip(np.asarray(p, float), 1e-4, 1 - 1e-4)
    if len(y) < 20 or y.sum() < 3 or y.sum() > len(y) - 3:
        return None
    import statsmodels.api as sm
    x = np.log(p / (1 - p))
    try:
        r = sm.GLM(y, sm.add_constant(x), family=sm.families.Binomial()).fit()
        return float(r.params[1])
    except Exception:
        return None


def _champion(con) -> tuple[str | None, dict]:
    try:
        r = con.execute("SELECT model_id, params_json FROM ml_model_registry WHERE is_active AND tier = 2").fetchone()
        return (r[0], json.loads(r[1])) if r else (None, {})
    except Exception:
        return None, {}


def build_monitoring(con, sim_time: dt.datetime, log=print, cfg: dict | None = None) -> pd.DataFrame:
    from shared.config import load_yaml
    mc = (cfg or load_yaml("forecast.yaml"))["learning_loop"]["monitoring"]
    con.execute(HIST_DDL)
    model_id, params = _champion(con)
    T = pd.Timestamp(sim_time)
    rows = []
    # ---- feature drift
    if model_id and _has(con, "pt_features") and _has(con, "ml_train_features") and _has(con, "ml_feature_importance"):
        feats = [r[0] for r in con.execute("""SELECT feature FROM ml_feature_importance WHERE model_id = ? ORDER BY rank LIMIT ?""",
                                           [model_id, int(mc["top_features"])]).fetchall()]
        if not feats:   # a promoted challenger without importance rows: fall back to any model's ranking
            feats = [r[0] for r in con.execute("""SELECT feature FROM ml_feature_importance GROUP BY feature
                                                  ORDER BY min(rank) LIMIT ?""", [int(mc["top_features"])]).fetchall()]
        cols = set(con.execute("SELECT * FROM pt_features LIMIT 0").df().columns)
        tcols = set(con.execute("SELECT * FROM ml_train_features LIMIT 0").df().columns)
        base = sorted({f.split("=")[0] for f in feats} & cols & tcols)
        if base:
            cur = con.execute(f"SELECT patient_id, as_of, {', '.join(base)} FROM pt_features").df()
            long = cur.melt(id_vars=["patient_id", "as_of"], var_name="feature", value_name="value")
            long["value"] = pd.to_numeric(long["value"], errors="coerce")   # categoricals become NaN; dropped below
            num = [c for c in base if pd.api.types.is_numeric_dtype(cur[c])]
            long = long[long["feature"].isin(num)]
            if len(long):
                con.register("_mon_long", long)
                con.execute("CREATE TABLE IF NOT EXISTS ml_monitor_features_hist AS SELECT * FROM _mon_long WHERE FALSE")
                con.execute("DELETE FROM ml_monitor_features_hist WHERE as_of IN (SELECT DISTINCT as_of FROM _mon_long)")
                con.execute("INSERT INTO ml_monitor_features_hist BY NAME SELECT * FROM _mon_long")
                con.unregister("_mon_long")
                con.execute(f"DELETE FROM ml_monitor_features_hist WHERE as_of < TIMESTAMP '{T}' - INTERVAL {int(mc['window_days'])} DAY")
                win = con.execute("SELECT feature, value FROM ml_monitor_features_hist").df()
                ref = con.execute(f"SELECT {', '.join(num)} FROM ml_train_features USING SAMPLE 20000 ROWS").df()
                for f in num:
                    v = psi(ref[f].values, win.loc[win["feature"] == f, "value"].values, int(mc["psi_bins"]))
                    if np.isfinite(v):
                        rows.append({"metric": f"psi:{f}", "value": v, "n": int((win["feature"] == f).sum()),
                                     "detail": "stable" if v < 0.1 else ("moderate" if v < 0.25 else "major")})
    # ---- calibration and PPV on verified outcomes
    if _has(con, "ml_feedback_labels"):
        fb = con.execute("""SELECT label, risk_at_landmark FROM ml_feedback_labels
                            WHERE label_kind = 'cancer' AND verified AND risk_at_landmark IS NOT NULL""").df()
        if len(fb):
            s = calibration_slope(fb["label"].values, fb["risk_at_landmark"].values)
            if s is not None:
                rows.append({"metric": "calib_slope", "value": s, "n": len(fb), "detail": "verified outcomes"})
            hc = params.get("high_cut")
            if hc is not None:
                hi = fb[fb["risk_at_landmark"] >= hc]
                if len(hi):
                    rows.append({"metric": "ppv_verified", "value": float(hi["label"].mean()), "n": len(hi), "detail": "HIGH flags"})
            rows.append({"metric": "verified_outcomes", "value": float(len(fb)), "n": len(fb), "detail": "cancer labels"})
    out = pd.DataFrame(rows)
    if len(out):
        out["as_of"], out["model_id"] = T, model_id
    # ---- alert volume and HIGH counts per day (history recomputed from source tables)
    vol = []
    if _has(con, "pt_alerts"):
        a = con.execute(f"""SELECT CAST(created_at AS DATE) AS d, count(*) AS n FROM pt_alerts
                            WHERE created_at > TIMESTAMP '{T}' - INTERVAL 365 DAY GROUP BY 1""").df()
        for r in a.itertuples():
            vol.append({"as_of": pd.Timestamp(r.d), "model_id": model_id, "metric": "alert_volume", "value": float(r.n), "n": int(r.n),
                        "detail": "new alerts"})
    if _has(con, "ml_risk_history"):
        h = con.execute(f"""SELECT CAST(as_of AS DATE) AS d, count(*) FILTER (WHERE risk_band = 'HIGH') AS hi, count(*) AS n
                            FROM ml_risk_history WHERE as_of > TIMESTAMP '{T}' - INTERVAL 365 DAY GROUP BY 1""").df()
        for r in h.itertuples():
            vol.append({"as_of": pd.Timestamp(r.d), "model_id": model_id, "metric": "high_count", "value": float(r.hi), "n": int(r.n),
                        "detail": "patients scored HIGH"})
    allrows = pd.concat([out, pd.DataFrame(vol)], ignore_index=True) if len(vol) or len(out) else pd.DataFrame()
    if len(allrows):
        allrows = allrows[["as_of", "model_id", "metric", "value", "n", "detail"]]
        con.register("_mon", allrows)
        con.execute("""DELETE FROM ml_monitoring_hist h WHERE EXISTS (SELECT 1 FROM _mon m WHERE m.as_of = h.as_of AND m.metric = h.metric)""")
        con.execute("INSERT INTO ml_monitoring_hist BY NAME SELECT * FROM _mon")
        con.unregister("_mon")
    con.execute(f"""CREATE OR REPLACE TABLE mart_model_monitoring AS SELECT * FROM ml_monitoring_hist
                    WHERE as_of > TIMESTAMP '{T}' - INTERVAL 730 DAY ORDER BY metric, as_of""")
    n = con.execute("SELECT count(*) FROM mart_model_monitoring").fetchone()[0]
    log(f"      mart_model_monitoring: {n:,} rows ({len(out)} new drift/calibration metrics)")
    return allrows
