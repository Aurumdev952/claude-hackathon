"""Age-standardised rates, WHO World Standard (2000-2025), Fay-Feuer gamma CIs (SPEC §12.2)."""
from __future__ import annotations

import numpy as np
from scipy.stats import chi2

from shared.geo import WHO_STD

W_ALL = np.array(WHO_STD, dtype=float) / sum(WHO_STD)
AGE_BANDS = {"ALL": list(range(18)), "<50": list(range(10)), "50-64": [10, 11, 12], "65+": [13, 14, 15, 16, 17]}


def band_weights(band: str) -> tuple[np.ndarray, np.ndarray]:
    idx = np.array(AGE_BANDS[band])
    w = W_ALL[idx]
    return idx, w / w.sum()


def fay_feuer(asr: float, var: float, wm: float, alpha: float = 0.05) -> tuple[float, float]:
    """Fay & Feuer (1997) gamma interval for a directly standardised rate."""
    if asr <= 0 or var <= 0:
        lo = 0.0
    else:
        lo = var / (2 * asr) * chi2.ppf(alpha / 2, 2 * asr**2 / var)
    v2, a2 = var + wm**2, asr + wm
    hi = v2 / (2 * a2) * chi2.ppf(1 - alpha / 2, 2 * a2**2 / v2) if a2 > 0 else 0.0
    return float(lo), float(hi)


def asr(cases_by_age: np.ndarray, pop_by_age: np.ndarray, band: str = "ALL", per: float = 1e5) -> dict:
    """cases/pop arrays have 18 WHO age groups. Returns crude, asr, CI, cases, population."""
    idx, w = band_weights(band)
    d = np.asarray(cases_by_age, float)[idx]
    n = np.asarray(pop_by_age, float)[idx]
    ok = n > 0
    cases, popn = float(d.sum()), float(n.sum())
    crude = cases / popn * per if popn > 0 else None
    if not ok.any():
        return {"cases": cases, "population": popn, "crude_rate": None, "asr": None, "asr_lci": None, "asr_uci": None}
    rate = np.where(ok, d / np.where(ok, n, 1), 0.0)
    a = float((w * rate).sum() * per)
    var = float((w**2 * np.where(ok, d / np.where(ok, n, 1) ** 2, 0.0)).sum() * per**2)
    wm = float(np.max(np.where(ok, w / np.where(ok, n, 1), 0.0)) * per)
    lo, hi = fay_feuer(a, var, wm)
    return {"cases": cases, "population": popn, "crude_rate": crude, "asr": a, "asr_lci": lo, "asr_uci": hi, "asr_var": var}
