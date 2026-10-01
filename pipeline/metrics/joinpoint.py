"""In-house joinpoint regression (SPEC §12.3), NCI-Joinpoint in spirit.

ln(ASR_y) = b0 + b1*y + sum_k d_k*(y - tau_k)_+  fitted by weighted least squares, w = 1/Var(ln ASR) = ASR^2/Var(ASR).
0-2 joinpoints at integer years, >= 2 observations from each end and between joinpoints.
Model selection: sequential permutation tests (Kim et al. 2000, the NCI Joinpoint default; SPEC P2) or weighted BIC.
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


def _best_rss(years, y, w, cands):
    best = None
    for taus in cands:
        beta, cov, rss, dof, bic = _fit(years, y, w, taus)
        if best is None or rss < best[1] - 1e-12:
            best = (taus, rss, beta)
    return best


def _select_permutation(years, y, w, by_k: dict, alpha: float, n_perm: int, seed: int) -> int:
    """Sequential tests H0: k vs H1: k+1 joinpoints. Null data = H0 fit + permuted (weighted) residuals; the statistic is
    the relative RSS reduction of the best (k+1)-joinpoint fit. Bonferroni over the number of tests keeps the overall
    level at alpha. Returns the selected number of joinpoints."""
    rng = np.random.default_rng(seed)
    kmax = max(by_k)
    sw = np.sqrt(w)
    level = alpha / max(kmax, 1)
    k = 0
    while k < kmax:
        taus0, rss0, beta0 = _best_rss(years, y, w, by_k[k])
        _, rss1, _ = _best_rss(years, y, w, by_k[k + 1])
        t_obs = (rss0 - rss1) / max(rss1, 1e-12)
        fit0 = _design(years, taus0) @ beta0
        r = (y - fit0) * sw
        hits = 0
        for _ in range(n_perm):
            ys = fit0 + rng.permutation(r) / sw
            _, a0, _ = _best_rss(years, ys, w, by_k[k])
            _, a1, _ = _best_rss(years, ys, w, by_k[k + 1])
            hits += (a0 - a1) / max(a1, 1e-12) >= t_obs
        if (hits + 1) / (n_perm + 1) >= level:
            break
        k += 1
    return k


def fit_joinpoint(years, asr, var, max_joinpoints: int = 2, min_obs: int = 2, selection: str = "permutation",
                  alpha: float = 0.05, n_perm: int = 499, seed: int = 20150101) -> dict | None:
    years = np.asarray(years, float)
    asr = np.asarray(asr, float)
    var = np.asarray(var, float)
    ok = np.isfinite(asr) & (asr > 0) & np.isfinite(var) & (var > 0)
    if ok.sum() < 5:
        return None
    years, asr, var = years[ok], asr[ok], var[ok]
    y = np.log(asr)
    w = asr**2 / var
    by_k: dict[int, list] = {}
    for k in range(0, max_joinpoints + 1):
        if len(years) < 2 * min_obs + k * min_obs:
            break
        c = list(candidates(years, k, min_obs)) if k else [()]
        if c:
            by_k[k] = c
    best = None
    if selection == "permutation" and len(by_k) > 1:
        k_sel = _select_permutation(years, y, w, by_k, alpha, n_perm, seed)
        taus, _, _ = _best_rss(years, y, w, by_k[k_sel])
        beta, cov, rss, dof, bic = _fit(years, y, w, taus)
        best = {"taus": taus, "beta": beta, "cov": cov, "rss": rss, "dof": dof, "bic": bic}
    else:
        for k, cands in by_k.items():
            for taus in cands:
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
