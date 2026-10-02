"""Rolling-origin backtests: refit on data up to each origin year (2015/2018/2021) and forecast 5 years ahead.

Per series, origin and horizon: absolute percentage error (MAPE when averaged), whether the actual fell inside the 80%
and 95% bands (cov80/cov95, averaged into coverage rates) and a sample-based CRPS (E|X - y| - E|X - X'| / 2) scaled
by the actual (so series of different sizes can be averaged).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import History
from .incidence import GeoFit, quantiles


def crps_sample(draws: np.ndarray, y: float) -> float:
    x = np.sort(np.asarray(draws, float))
    n = len(x)
    if n == 0:
        return float("nan")
    t1 = np.mean(np.abs(x - y))
    # E|X - X'| = 2 / n^2 * sum_i (2i - n - 1) x_(i)  (sorted sample identity)
    t2 = 2.0 / (n * n) * np.sum((2 * np.arange(1, n + 1) - n - 1) * x)
    return float(t1 - 0.5 * t2)


def run(h: History, c: dict, rng: np.random.Generator, log=print) -> pd.DataFrame:
    bc = c["backtest"]
    H = int(bc["horizon"])
    n = int(bc["draws"])
    rows = []
    for origin in bc["origins"]:
        origin = int(origin)
        if origin - h.first_year + 1 < int(c["min_history_years"]) or origin >= h.last_full:
            log(f"    backtest origin {origin}: skipped (history {h.first_year}-{origin}, last full year {h.last_full})")
            continue
        years = list(range(origin + 1, origin + H + 1))
        hist = h.cells[h.cells["year"] <= origin]
        actual = h.cells[(h.cells["year"] > origin) & (h.cells["year"] <= h.last_full)]
        geos = [("NATIONAL", "RW", hist, actual, h.pop)]
        geos += [("PROVINCE", p, hist[hist["province_code"] == p], actual[actual["province_code"] == p],
                  h.pop[h.pop["province_code"] == p]) for p in sorted(h.cells["province_code"].unique())]
        for level, code, hc, ac, pop in geos:
            try:
                g = GeoFit(hc, pop, years, c, rng, n)
            except Exception as e:  # noqa: BLE001
                log(f"    backtest {level} {code} {origin}: {e.__class__.__name__}: {e}")
                continue
            for sex in (("ALL", "M", "F") if level == "NATIONAL" else ("ALL",)):
                s = g.series(sex, "ALL")
                q = quantiles(s.cases_draws)
                sid = f"{'NATIONAL' if level == 'NATIONAL' else code}|{sex}|ALL|{h.case_def}"
                for j, y in enumerate(years):
                    a = ac[(ac["year"] == y) & ac["sex"].isin(("M", "F") if sex == "ALL" else (sex,))]["cases"].sum()
                    if y > h.last_full:
                        continue
                    a = float(a)
                    rows.append({"series_id": sid, "origin_year": origin, "horizon": j + 1, "year": y, "actual": a,
                                 "forecast": float(s.cases_mean[j]),
                                 "mape": float(100 * abs(s.cases_mean[j] - a) / a) if a > 0 else None,
                                 "cov80": float(q[1, j] <= a <= q[2, j]), "cov95": float(q[0, j] <= a <= q[3, j]),
                                 "crps": crps_sample(s.cases_draws[:, j], a) / max(a, 1.0), "model": s.model})
    return pd.DataFrame(rows)


def summary(bt: pd.DataFrame) -> dict:
    if bt is None or bt.empty:
        return {"mape": None, "cov80": None, "cov95": None, "crps": None, "n": 0}
    return {"mape": float(bt["mape"].mean()), "cov80": float(bt["cov80"].mean()), "cov95": float(bt["cov95"].mean()),
            "crps": float(bt["crps"].mean()), "n": int(len(bt))}
