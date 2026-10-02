"""v3 forecasting and model-monitoring marts (docs/contracts/v3-loop.md §5, track L3).

Cheap on purpose: the heavy fitting runs in `make forecast` / `make train` / `ml.retrain.maybe_retrain` and is persisted
to `ml_forecast_*`. Here, on every pipeline run:
- mart_forecast, mart_forecast_drivers, mart_risk_factor_forecast: copies of the fitted ml_forecast_* tables, plus
  the monthly EMR risk-factor nowcasts and the national monthly operational totals (freq M);
- mart_operational_forecast: next-12-months GLM by district (refitted each run, it is fast);
- mart_forecast_tracking: earlier forecasts (yearly runs and every monthly operational run) against the new actuals;
- ml_feedback_labels (cheap sources) and mart_model_monitoring (ml/feedback.py, ml/monitoring.py).
Every part is isolated: a failure is logged and never stops the pipeline. Empty tables are created with the contract
schema so the API can answer "no forecast yet" cleanly.
"""
from __future__ import annotations

import time
import traceback

import pandas as pd

SCHEMAS = {
    "mart_forecast": """series_id VARCHAR, geo_level VARCHAR, geo_code VARCHAR, sex VARCHAR, age_band VARCHAR, freq VARCHAR,
        period TIMESTAMP, kind VARCHAR, metric VARCHAR, mean DOUBLE, lo80 DOUBLE, hi80 DOUBLE, lo95 DOUBLE, hi95 DOUBLE,
        model VARCHAR, run_id VARCHAR, cases_obs DOUBLE""",
    "mart_forecast_drivers": """geo_level VARCHAR, geo_code VARCHAR, from_year INTEGER, to_year INTEGER, component VARCHAR,
        cases DOUBLE, pct DOUBLE, cases_from DOUBLE, cases_to DOUBLE, total_change DOUBLE""",
    "mart_risk_factor_forecast": """indicator VARCHAR, geo_code VARCHAR, sex VARCHAR, year INTEGER, kind VARCHAR, value DOUBLE,
        lo95 DOUBLE, hi95 DOUBLE, n DOUBLE, source VARCHAR, period TIMESTAMP, freq VARCHAR""",
    "mart_operational_forecast": """district_code VARCHAR, month DATE, metric VARCHAR, mean DOUBLE, lo80 DOUBLE, hi80 DOUBLE,
        as_of TIMESTAMP""",
    "mart_forecast_tracking": """series_id VARCHAR, period DATE, forecast_run_id VARCHAR, forecast_mean DOUBLE, forecast_lo80 DOUBLE,
        forecast_hi80 DOUBLE, actual DOUBLE, abs_pct_error DOUBLE, in_band80 BOOLEAN""",
    "ml_forecast_backtest": """series_id VARCHAR, origin_year INTEGER, horizon INTEGER, year INTEGER, actual DOUBLE, forecast DOUBLE,
        mape DOUBLE, cov80 DOUBLE, cov95 DOUBLE, crps DOUBLE, model VARCHAR""",
}


def _has(con, t: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [t]).fetchone()[0] > 0


def _empty(con, name: str):
    con.execute(f"CREATE OR REPLACE TABLE {name} ({SCHEMAS[name]})")


def _put(con, name: str, df: pd.DataFrame):
    if df is None or df.empty:
        _empty(con, name)
        return
    con.register("_fm_df", df)
    _empty(con, name)
    con.execute(f"INSERT INTO {name} BY NAME SELECT * FROM _fm_df")
    con.unregister("_fm_df")


def _part(name, fn, log):
    t = time.time()
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - one broken part must not stop the pipeline
        log(f"      ! {name}: {e.__class__.__name__}: {e}")
        traceback.print_exc()
    return time.time() - t


def build_forecast(con, sim_time, log=print):
    from ml.forecast.data import cfg
    c = cfg()
    ops: dict = {}

    def series():
        if _has(con, "ml_forecast_series"):
            con.execute(f"CREATE OR REPLACE TABLE mart_forecast ({SCHEMAS['mart_forecast']})")
            con.execute("INSERT INTO mart_forecast BY NAME SELECT * FROM ml_forecast_series")
        else:
            _empty(con, "mart_forecast")
        if _has(con, "ml_forecast_drivers"):
            con.execute(f"CREATE OR REPLACE TABLE mart_forecast_drivers ({SCHEMAS['mart_forecast_drivers']})")
            con.execute("INSERT INTO mart_forecast_drivers BY NAME SELECT * FROM ml_forecast_drivers")
        else:
            _empty(con, "mart_forecast_drivers")
        if not _has(con, "ml_forecast_backtest"):
            _empty(con, "ml_forecast_backtest")

    def risk_factors():
        from ml.forecast.risk_factors import emr_nowcasts
        _empty(con, "mart_risk_factor_forecast")
        if _has(con, "ml_forecast_risk_factors"):
            con.execute("INSERT INTO mart_risk_factor_forecast BY NAME SELECT * FROM ml_forecast_risk_factors")
        now = emr_nowcasts(con, sim_time, int(c["risk_factors"]["nowcast_months"]))
        if len(now):
            con.register("_fm_now", now)
            con.execute("INSERT INTO mart_risk_factor_forecast BY NAME SELECT * FROM _fm_now")
            con.unregister("_fm_now")

    def operational():
        from ml.forecast import operational as OP
        df = OP.build(con, sim_time, c)
        ops["df"] = df
        _put(con, "mart_operational_forecast", df)
        # national monthly totals also go to mart_forecast (freq M) for the series endpoint
        nat = df[df["district_code"] == "RW"]
        if len(nat):
            m = pd.DataFrame({"series_id": "NATIONAL|ALL|ALL|OPS", "geo_level": "NATIONAL", "geo_code": "RW", "sex": "ALL",
                              "age_band": "ALL", "freq": "M", "period": pd.to_datetime(nat["month"]), "kind": "forecast",
                              "metric": nat["metric"].values, "mean": nat["mean"].values, "lo80": nat["lo80"].values,
                              "hi80": nat["hi80"].values, "lo95": None, "hi95": None, "model": "glm(poisson, seasonal)",
                              "run_id": f"ops-{pd.Timestamp(sim_time):%Y%m%d}", "cases_obs": None})
            con.execute("DELETE FROM mart_forecast WHERE freq = 'M'")
            con.register("_fm_m", m)
            con.execute("INSERT INTO mart_forecast BY NAME SELECT * FROM _fm_m")
            con.unregister("_fm_m")
        # keep every run's operational forecast for tracking (one snapshot per sim day)
        h = df.assign(forecast_run_id=f"ops-{pd.Timestamp(sim_time):%Y-%m-%d}")
        con.register("_fm_h", h)
        con.execute("CREATE TABLE IF NOT EXISTS ml_forecast_ops_hist AS SELECT * FROM _fm_h WHERE FALSE")
        con.execute("DELETE FROM ml_forecast_ops_hist WHERE forecast_run_id = ?", [h["forecast_run_id"].iloc[0]])
        con.execute("INSERT INTO ml_forecast_ops_hist BY NAME SELECT * FROM _fm_h")
        con.unregister("_fm_h")

    def tracking():
        from ml.forecast import operational as OP
        rows = []
        if _has(con, "ml_forecast_ops_hist"):
            act = OP.history(con, sim_time, months=int(c["operational"]["history_months"]))
            act["month"] = pd.to_datetime(act["month"]).dt.date
            f = con.execute("""SELECT district_code, month, metric, mean, lo80, hi80, forecast_run_id FROM ml_forecast_ops_hist
                               WHERE metric IN ('gi_visits', 'endoscopy_demand')""").df()
            if len(f):
                f["month"] = pd.to_datetime(f["month"]).dt.date
                m = f.merge(act, on=["district_code", "month", "metric"], how="inner")
                for r in m.itertuples():
                    rows.append({"series_id": f"OPS|{r.district_code}|{r.metric}", "period": r.month, "forecast_run_id": r.forecast_run_id,
                                 "forecast_mean": r.mean, "forecast_lo80": r.lo80, "forecast_hi80": r.hi80, "actual": float(r.n)})
        if _has(con, "ml_forecast_hist") and _has(con, "mart_forecast"):
            yr = con.execute("""SELECT h.series_id, CAST(h.period AS DATE) AS period, h.forecast_run_id, h.mean, h.lo80, h.hi80, a.mean AS actual
                                FROM ml_forecast_hist h JOIN mart_forecast a ON a.series_id = h.series_id AND a.period = h.period
                                 AND a.kind = 'history' AND a.metric = 'cases'""").df()
            for r in yr.itertuples():
                rows.append({"series_id": r.series_id, "period": r.period, "forecast_run_id": r.forecast_run_id, "forecast_mean": r.mean,
                             "forecast_lo80": r.lo80, "forecast_hi80": r.hi80, "actual": r.actual})
        df = pd.DataFrame(rows)
        if len(df):
            df["abs_pct_error"] = (100 * (df["forecast_mean"] - df["actual"]).abs() / df["actual"].where(df["actual"] > 0))
            df["in_band80"] = (df["actual"] >= df["forecast_lo80"]) & (df["actual"] <= df["forecast_hi80"])
        _put(con, "mart_forecast_tracking", df)

    def feedback():
        from ml.feedback import build_feedback_labels
        build_feedback_labels(con, sim_time, log)

    def monitoring():
        from ml.monitoring import build_monitoring
        build_monitoring(con, sim_time, log)

    t = {n: _part(n, fn, log) for n, fn in (("forecast series", series), ("risk factors", risk_factors),
                                           ("operational", operational), ("tracking", tracking),
                                           ("feedback labels", feedback), ("monitoring", monitoring))}
    log("      forecast marts: " + ", ".join(f"{k} {v:.1f}s" for k, v in t.items()))
