"""In-house joinpoint regression (SPEC §12.3), NCI-Joinpoint in spirit.

ln(ASR_y) = b0 + b1*y + sum_k d_k*(y - tau_k)_+  fitted by weighted least squares, w = 1/Var(ln ASR) = ASR^2/Var(ASR).
0-2 joinpoints at integer years, >= 2 observations from each end and between joinpoints; selection by weighted BIC.
"""
from __future__ import annotations

import itertools
import math

import numpy as np
from scipy import stats


def _design(years: np.ndarray, taus: tuple) -> np.ndarray:
    cols = [np.ones_like(years), years - years[0]]
    for t in taus:
        cols.append(np.clip(years - t, 0, None))
    return np.column_stack(cols)


def _fit(years, y, w, taus):
    X = _design(years, taus)
    sw = np.sqrt(w)
    Xw, yw = X * sw[:, None], y * sw
    beta, *_ = np.linalg.lstsq(Xw, yw, rcond=None)
    resid = yw - Xw @ beta
    rss = float(resid @ resid)
    n, p = X.shape
    dof = max(n - p, 1)
    sigma2 = rss / dof
    try:
        cov = sigma2 * np.linalg.inv(Xw.T @ Xw)
    except np.linalg.LinAlgError:
        cov = np.full((p, p), np.nan)
    k = p + len(taus)  # joinpoint locations count as parameters
    bic = n * math.log(max(rss / n, 1e-12)) + k * math.log(n)
    return beta, cov, rss, dof, bic


def candidates(years: np.ndarray, k: int, min_obs: int = 2):
    inner = years[min_obs - 1: len(years) - min_obs + 1]
    for taus in itertools.combinations(inner[1:-1] if len(inner) > 2 else [], k):
        pts = (years[0],) + taus + (years[-1],)
        if all(sum(1 for y in years if a <= y <= b) >= min_obs + (0 if i == 0 else 0) for i, (a, b) in enumerate(zip(pts, pts[1:]))):
            if all(b - a >= min_obs for a, b in zip(pts, pts[1:])):
                yield taus


def fit_joinpoint(years, asr, var, max_joinpoints: int = 2, min_obs: int = 2) -> dict | None:
    years = np.asarray(years, float)
    asr = np.asarray(asr, float)
    var = np.asarray(var, float)
    ok = np.isfinite(asr) & (asr > 0) & np.isfinite(var) & (var > 0)
    if ok.sum() < 5:
        return None
    years, asr, var = years[ok], asr[ok], var[ok]
    y = np.log(asr)
    w = asr**2 / var
    best = None
    for k in range(0, max_joinpoints + 1):
        if len(years) < 2 * min_obs + k * min_obs:
            break
        for taus in (candidates(years, k, min_obs) if k else [()]):
            beta, cov, rss, dof, bic = _fit(years, y, w, taus)
            if best is None or bic < best["bic"] - 1e-9:
                best = {"taus": taus, "beta": beta, "cov": cov, "rss": rss, "dof": dof, "bic": bic}
    if best is None:
        return None
    taus, beta, cov, dof = best["taus"], best["beta"], best["cov"], best["dof"]
    tcrit = stats.t.ppf(0.975, dof)
    pts = [years[0], *taus, years[-1]]
    segments = []
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        L = np.zeros(len(beta))
        L[1] = 1
        L[2:2 + i] = 1
        slope = float(L @ beta)
        se = float(math.sqrt(max(L @ cov @ L, 0))) if np.all(np.isfinite(cov)) else float("nan")
        lo, hi = slope - tcrit * se, slope + tcrit * se
        segments.append({"segment_no": i + 1, "start_year": int(a), "end_year": int(b),
                         "apc": 100 * (math.exp(slope) - 1), "apc_lci": 100 * (math.exp(lo) - 1),
                         "apc_uci": 100 * (math.exp(hi) - 1), "significant": bool(lo > 0 or hi < 0), "_L": L})
    # AAPC over the last 10 years: duration-weighted mean slope, delta-method CI
    last = years[-1]
    start = max(years[0], last - 9 if len(years) >= 10 else years[0])
    Lw = np.zeros(len(beta))
    tot = 0.0
    for sgm in segments:
        a, b = max(sgm["start_year"], start), min(sgm["end_year"], last)
        dur = max(0.0, b - a)
        Lw += dur * sgm["_L"]
        tot += dur
    Lw = Lw / tot if tot else Lw
    s = float(Lw @ beta)
    se = float(math.sqrt(max(Lw @ cov @ Lw, 0))) if np.all(np.isfinite(cov)) else float("nan")
    fitted = np.exp(_design(years, taus) @ beta)
    for sgm in segments:
        sgm.pop("_L")
    return {"n_joinpoints": len(taus), "joinpoints": [int(t) for t in taus], "segments": segments,
            "aapc_last10": {"value": 100 * (math.exp(s) - 1), "lci": 100 * (math.exp(s - tcrit * se) - 1),
                            "uci": 100 * (math.exp(s + tcrit * se) - 1), "start_year": int(start), "end_year": int(last)},
            "fitted": [{"year": int(a), "asr": float(f)} for a, f in zip(years, fitted)], "bic": best["bic"]}
