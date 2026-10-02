"""Isotonic calibration with small-sample shrinkage (D-58).

Plain isotonic regression sets each plateau to the event rate of the validation points in it. A plateau resting on a
handful of points can therefore be exactly 1.0 (three validation landmarks, all positive), which then shows as a "100%"
12-month cancer probability in the doctor UI: not credible, and not supported by three observations.

`SmoothedIsotonic` keeps the isotonic shape (monotone in the raw score, as SPEC §13.6 asks) but replaces each plateau's
rate k / n by the Beta-prior posterior mean (k + m * pi) / (n + m), where pi is the validation base rate and m the prior
strength in pseudo-observations (config `tier2.calibration_prior`, default 5). Large plateaus barely move; tiny ones are
pulled towards the base rate. Shrinking plateaus by different amounts can break monotonicity, so a second, count-weighted
isotonic fit over the smoothed plateau values restores it (pool adjacent violators).
"""
from __future__ import annotations

import numpy as np
from sklearn.isotonic import IsotonicRegression

DEFAULT_PRIOR = 5.0


class SmoothedIsotonic:
    def __init__(self, prior_strength: float = DEFAULT_PRIOR):
        self.prior_strength = float(prior_strength)
        self.iso_: IsotonicRegression | None = None
        self.base_rate_: float | None = None

    def fit(self, raw, y, sample_weight=None) -> "SmoothedIsotonic":
        raw = np.asarray(raw, dtype=float)
        y = np.asarray(y, dtype=float)
        w = np.ones_like(y) if sample_weight is None else np.asarray(sample_weight, dtype=float)
        first = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, y, sample_weight=w)
        plateau = first.predict(raw)
        pi = float(np.average(y, weights=w)) if len(y) else 0.0
        m = self.prior_strength
        smoothed = np.empty_like(plateau)
        for v in np.unique(plateau):  # plateaus are the distinct fitted values
            sel = plateau == v
            n, k = w[sel].sum(), (w[sel] * y[sel]).sum()
            smoothed[sel] = (k + m * pi) / (n + m)
        self.iso_ = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, smoothed, sample_weight=w)
        self.base_rate_ = pi
        return self

    def predict(self, raw) -> np.ndarray:
        assert self.iso_ is not None, "fit first"
        return self.iso_.predict(np.asarray(raw, dtype=float))

    # sklearn-style alias so callers that used IsotonicRegression.transform keep working
    transform = predict


def fit_calibrator(raw, y, sample_weight=None, prior_strength: float | None = None) -> SmoothedIsotonic:
    if prior_strength is None:
        try:
            from shared.config import models_cfg
            prior_strength = float(models_cfg()["tier2"].get("calibration_prior", DEFAULT_PRIOR))
        except Exception:  # noqa: BLE001 - config is optional for library use
            prior_strength = DEFAULT_PRIOR
    return SmoothedIsotonic(prior_strength).fit(raw, y, sample_weight)
