"""Funnel plot control limits for proportions (SPEC §12.7), exact binomial."""
from __future__ import annotations

import numpy as np
from scipy.stats import binom


def limits(n: np.ndarray, p0: float, level: float) -> tuple[np.ndarray, np.ndarray]:
    a = (1 - level) / 2
    n = np.maximum(np.asarray(n, int), 1)
    lo = binom.ppf(a, n, p0) / n
    hi = binom.ppf(1 - a, n, p0) / n
    return lo, hi
