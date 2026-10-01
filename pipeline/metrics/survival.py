"""Survival analysis (SPEC §12.4): Kaplan-Meier, log-rank, 1/2-year survival, Cox PH."""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd


def km_tables(df: pd.DataFrame, group_var: str, grid_days: int = 30, max_days: int = 1825):
    from lifelines import KaplanMeierFitter
    from lifelines.statistics import multivariate_logrank_test
    curves, summary = [], []
    d = df.dropna(subset=[group_var])
    groups = sorted(d[group_var].unique())
    p = float("nan")
    if len(groups) > 1:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            p = float(multivariate_logrank_test(d["surv_days"], d[group_var], d["event_death"]).p_value)
    grid = np.arange(0, max_days + 1, grid_days)
    for g in groups:
        s = d[d[group_var] == g]
        if len(s) < 3:
            continue
        kmf = KaplanMeierFitter().fit(s["surv_days"], s["event_death"])
        sf = kmf.survival_function_at_times(grid).values
        ci = kmf.confidence_interval_survival_function_
        lo = np.interp(grid, ci.index.values, ci.iloc[:, 0].values)
        hi = np.interp(grid, ci.index.values, ci.iloc[:, 1].values)
        at_risk = [(s["surv_days"] >= t).sum() for t in grid]
        events = [int(((s["surv_days"] <= t) & s["event_death"]).sum()) for t in grid]
        for t, sv, l, h, n, e in zip(grid, sf, lo, hi, at_risk, events):
            curves.append({"group_var": group_var, "group_value": str(g), "t_days": int(t), "surv": float(sv),
                           "lci": float(l), "uci": float(h), "n_at_risk": int(n), "n_events": int(e)})
        med = kmf.median_survival_time_
        summary.append({"group_var": group_var, "group_value": str(g), "n": int(len(s)),
                        "surv_1y": float(kmf.survival_function_at_times(365).iloc[0]),
                        "surv_2y": float(kmf.survival_function_at_times(730).iloc[0]),
                        "median_surv_days": float(med) if np.isfinite(med) else None, "logrank_p": p})
    return curves, summary


def cox(df: pd.DataFrame, duration: str, event: str, covariates: list[str], model_id: str) -> list[dict]:
    from lifelines import CoxPHFitter
    d = df[[duration, event] + covariates].dropna()
    if len(d) < 30 or d[event].sum() < 10:
        return []
    d = pd.get_dummies(d, columns=[c for c in covariates if d[c].dtype == object], drop_first=True, dtype=float)
    d = d.loc[:, d.std() > 0]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        cph = CoxPHFitter(penalizer=0.01).fit(d, duration_col=duration, event_col=event)
    s = cph.summary
    return [{"model_id": model_id, "term": t, "hr": float(r["exp(coef)"]), "lci": float(r["exp(coef) lower 95%"]),
             "uci": float(r["exp(coef) upper 95%"]), "p": float(r["p"])} for t, r in s.iterrows()]
