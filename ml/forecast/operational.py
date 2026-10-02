"""Next-12-months operational forecast by district: GI visits, expected HIGH flags, endoscopy demand, care tasks.

- GI visits and baseline endoscopies: Poisson GLM (quasi-Poisson dispersion -> negative-binomial bands) on monthly
  counts by facility district with district effects, a linear trend and two Fourier harmonics for seasonality.
- Expected HIGH flags = forecast GI visits x the current share of recently seen GI patients scored HIGH.
- Endoscopy demand = baseline endoscopies + HIGH flags x endoscopy uptake (care outcomes, or a config prior).
- Care tasks = care-task creation GLM when care data exists, else HIGH flags x approval prior x tasks per plan.
- endoscopy_capacity (extra metric) = capacity multiplier x p90 of monthly endoscopies in the last 24 months.
Cheap enough (well under a second on dev data) to rebuild on every pipeline run.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
from scipy import stats

from shared.geo import DISTRICT_CODES

from .data import has_table


def monthly_counts(con, sql_events: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """sql_events must yield (t TIMESTAMP, district_code). Returns district_code x month counts (zeros filled)."""
    d = con.execute(f"""SELECT district_code, date_trunc('month', t) AS month, count(*) AS n FROM ({sql_events}) e
                        WHERE t >= TIMESTAMP '{start}' AND t < TIMESTAMP '{end}' AND district_code IS NOT NULL GROUP BY ALL""").df()
    months = pd.date_range(start, end - pd.Timedelta(days=1), freq="MS")
    grid = pd.MultiIndex.from_product([DISTRICT_CODES, months], names=["district_code", "month"]).to_frame(index=False)
    if d.empty:
        return grid.assign(n=0.0)
    d["month"] = pd.to_datetime(d["month"])
    return grid.merge(d, on=["district_code", "month"], how="left").fillna({"n": 0.0})


def _design(df: pd.DataFrame, t0: pd.Timestamp, districts: list[str]) -> np.ndarray:
    k = ((df["month"].dt.year - t0.year) * 12 + df["month"].dt.month - t0.month).values.astype(float)
    m = df["month"].dt.month.values.astype(float)
    cols = [np.ones(len(df)), k / 12.0]
    for h in (1, 2):
        cols += [np.sin(2 * np.pi * h * m / 12), np.cos(2 * np.pi * h * m / 12)]
    for d in districts[1:]:
        cols.append((df["district_code"] == d).values.astype(float))
    return np.column_stack(cols)


def glm_forecast(hist: pd.DataFrame, future_months: pd.DatetimeIndex) -> pd.DataFrame:
    """Poisson GLM with district effects; returns district_code, month, mean, phi."""
    import statsmodels.api as sm
    active = [d for d in DISTRICT_CODES if hist.loc[hist["district_code"] == d, "n"].sum() > 0]
    fut = pd.MultiIndex.from_product([DISTRICT_CODES, future_months], names=["district_code", "month"]).to_frame(index=False)
    if not active or hist["n"].sum() < 10:
        fut["mean"], fut["phi"] = 0.0, 1.0
        return fut
    h = hist[hist["district_code"].isin(active)]
    t0 = h["month"].min()
    X = _design(h, t0, active)
    try:
        r = sm.GLM(h["n"].values.astype(float), X, family=sm.families.Poisson()).fit(maxiter=100)
        mu = r.fittedvalues
        phi = max(1.0, float(np.sum((h["n"].values - mu) ** 2 / np.maximum(mu, 1e-9)) / max(1, len(h) - X.shape[1])))
        f = fut[fut["district_code"].isin(active)]
        pred = np.exp(np.clip(_design(f, t0, active) @ r.params, -30, 30))
        # guard against runaway trends on short series: cap at 2x the last-12-month district mean
        last = h[h["month"] > h["month"].max() - pd.DateOffset(months=12)].groupby("district_code")["n"].mean()
        cap = 2.0 * f["district_code"].map(last).fillna(0).values + 1.0
        fut["mean"] = 0.0
        fut.loc[f.index, "mean"] = np.minimum(pred, cap)
    except Exception:
        last = h[h["month"] > h["month"].max() - pd.DateOffset(months=12)].groupby("district_code")["n"].mean()
        fut["mean"] = fut["district_code"].map(last).fillna(0.0)
        phi = 1.0
    fut["phi"] = phi
    return fut


def nb_interval(mean: np.ndarray, phi: float, lo: float = 0.10, hi: float = 0.90) -> tuple[np.ndarray, np.ndarray]:
    mean = np.maximum(np.asarray(mean, float), 1e-9)
    if phi <= 1.0001:
        return stats.poisson.ppf(lo, mean), stats.poisson.ppf(hi, mean)
    n = mean / (phi - 1.0)
    p = n / (n + mean)
    return stats.nbinom.ppf(lo, n, p), stats.nbinom.ppf(hi, n, p)


def build(con, sim_time: dt.datetime, c: dict) -> pd.DataFrame:
    oc = c["operational"]
    now = pd.Timestamp(sim_time)
    end = (now + pd.Timedelta(seconds=1)).to_period("M").to_timestamp()      # first month not fully observed
    if (now + pd.Timedelta(seconds=1)).day == 1 and (now + pd.Timedelta(seconds=1)).hour == 0:
        end = (now + pd.Timedelta(seconds=1)).normalize()
    start = end - pd.DateOffset(months=int(oc["history_months"]))
    fut = pd.date_range(end, periods=int(oc["horizon_months"]), freq="MS")
    gi = monthly_counts(con, """SELECT g.datetime AS t, l.district_code FROM core_gi_encounter g
                                JOIN core_dim_location l USING (location_id)""", start, end)
    endo = monthly_counts(con, """SELECT e.encounter_datetime AS t, l.district_code FROM core_fact_encounter e
                                  JOIN core_dim_location l USING (location_id) WHERE e.encounter_type = 5""", start, end)
    out = []
    f_gi = glm_forecast(gi, fut)
    f_en = glm_forecast(endo, fut)
    p_high = _p_high(con)
    uptake = _uptake(con, float(oc["endoscopy_uptake_prior"]))
    f_hi = f_gi.assign(mean=f_gi["mean"] * p_high)
    f_dem = f_en.assign(mean=f_en["mean"] + f_hi["mean"].values * uptake)
    tasks = None
    if has_table(con, "care_tasks"):
        try:
            ct = monthly_counts(con, """SELECT CAST(t.created_sim AS TIMESTAMP) AS t, p.district_code FROM care_tasks t
                                        JOIN core_dim_patient p USING (patient_id)""", start, end)
            if ct["n"].sum() >= 20:
                tasks = glm_forecast(ct, fut)
        except Exception:
            tasks = None
    if tasks is None:
        tasks = f_hi.assign(mean=f_hi["mean"] * float(oc["approval_prior"]) * _tasks_per_plan(oc))
    for metric, f in (("gi_visits", f_gi), ("high_flags", f_hi), ("endoscopy_demand", f_dem), ("care_tasks", tasks)):
        lo, hi = nb_interval(f["mean"].values, float(f["phi"].iloc[0]) if len(f) else 1.0)
        out.append(pd.DataFrame({"district_code": f["district_code"], "month": f["month"], "metric": metric, "mean": f["mean"],
                                 "lo80": np.minimum(lo, f["mean"]), "hi80": np.maximum(hi, f["mean"])}))
    cap_hist = endo[endo["month"] >= end - pd.DateOffset(months=24)]
    cap = cap_hist.groupby("district_code")["n"].quantile(0.9) * float(oc["capacity_multiplier"])
    capf = pd.MultiIndex.from_product([DISTRICT_CODES, fut], names=["district_code", "month"]).to_frame(index=False)
    capf["mean"] = capf["district_code"].map(cap).fillna(0.0).round(1)
    out.append(capf.assign(metric="endoscopy_capacity", lo80=np.nan, hi80=np.nan))
    df = pd.concat(out, ignore_index=True)
    # national totals: sum of means, NB band with a pooled dispersion
    nat = df.groupby(["metric", "month"], as_index=False)["mean"].sum().assign(district_code="RW")
    phis = {"gi_visits": f_gi["phi"].iloc[0], "high_flags": f_gi["phi"].iloc[0], "endoscopy_demand": f_en["phi"].iloc[0],
            "care_tasks": tasks["phi"].iloc[0] if "phi" in tasks else 1.0}
    lo, hi = [], []
    for r in nat.itertuples():
        if r.metric == "endoscopy_capacity":
            lo.append(np.nan)
            hi.append(np.nan)
            continue
        a, b = nb_interval(np.array([r.mean]), float(phis.get(r.metric, 1.0)))
        lo.append(float(min(a[0], r.mean)))
        hi.append(float(max(b[0], r.mean)))
    nat["lo80"], nat["hi80"] = lo, hi
    df = pd.concat([df, nat], ignore_index=True)
    df["month"] = pd.to_datetime(df["month"]).dt.date
    df["as_of"] = now
    return df[["district_code", "month", "metric", "mean", "lo80", "hi80", "as_of"]]


def history(con, sim_time: dt.datetime, months: int = 36) -> pd.DataFrame:
    """Observed monthly actuals (gi_visits, endoscopies) by district + national, for tracking."""
    now = pd.Timestamp(sim_time)
    end = (now + pd.Timedelta(seconds=1)).to_period("M").to_timestamp()
    start = end - pd.DateOffset(months=months)
    gi = monthly_counts(con, """SELECT g.datetime AS t, l.district_code FROM core_gi_encounter g
                                JOIN core_dim_location l USING (location_id)""", start, end).assign(metric="gi_visits")
    en = monthly_counts(con, """SELECT e.encounter_datetime AS t, l.district_code FROM core_fact_encounter e
                                JOIN core_dim_location l USING (location_id) WHERE e.encounter_type = 5""", start, end
                        ).assign(metric="endoscopy_demand")
    d = pd.concat([gi, en], ignore_index=True)
    nat = d.groupby(["metric", "month"], as_index=False)["n"].sum().assign(district_code="RW")
    return pd.concat([d, nat], ignore_index=True)


def _p_high(con) -> float:
    """Share of recently seen GI patients (last GI visit <= 30 days) currently scored HIGH."""
    try:
        if not (has_table(con, "pt_risk") and has_table(con, "pt_features")):
            return 0.02
        r = con.execute("""SELECT avg((r.risk_band = 'HIGH')::INT) FROM pt_risk r JOIN pt_features f USING (patient_id)
                           WHERE f.days_since_last_gi_visit <= 30""").fetchone()[0]
        return float(r) if r is not None else 0.02
    except Exception:
        return 0.02


def _uptake(con, prior: float) -> float:
    for t in ("care_recommendation_outcomes", "recommendation_outcomes"):
        try:
            if has_table(con, t):
                r = con.execute(f"SELECT avg(adhered), count(*) FROM {t} WHERE pathway ILIKE '%ENDOSCOPY%'").fetchone()
                if r[1] and r[1] >= 20:
                    return float(r[0])
        except Exception:
            pass
    return prior


def _tasks_per_plan(oc: dict) -> float:
    try:
        from shared.config import load_yaml
        pw = load_yaml("care_pathways.yaml")
        items = pw.get("pathways", pw) if isinstance(pw, dict) else pw
        vals = items.values() if isinstance(items, dict) else items
        n = [len(p.get("tasks", [])) for p in vals if isinstance(p, dict) and p.get("tasks")]
        if n:
            return float(np.mean(n))
    except Exception:
        pass
    return float(oc["tasks_per_plan_prior"])
