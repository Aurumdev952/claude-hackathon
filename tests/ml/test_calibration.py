"""Smoothed isotonic calibration (ml/calibration.py, D-58)."""
from __future__ import annotations

import numpy as np

from ml.calibration import SmoothedIsotonic


def _data(seed=0):
    rng = np.random.default_rng(seed)
    raw = rng.random(4000)
    y = (rng.random(4000) < 0.02 + 0.1 * raw ** 4).astype(int)
    # a tiny, all-positive top plateau: plain isotonic would put it at exactly 1.0
    raw = np.concatenate([raw, [1.5, 1.6, 1.7]])
    y = np.concatenate([y, [1, 1, 1]])
    return raw, y


def test_no_certainty_from_three_points():
    from sklearn.isotonic import IsotonicRegression
    raw, y = _data()
    plain = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(raw, y)
    assert plain.predict([1.6])[0] == 1.0  # the problem being fixed
    cal = SmoothedIsotonic(5).fit(raw, y)
    top = cal.predict([1.6])[0]
    assert top < 0.75, top  # (3 + 5 * pi) / 8 is about 0.4
    assert top > cal.predict([0.5])[0]  # still ranks the top plateau highest


def test_monotone_and_close_to_isotonic_on_large_plateaus():
    raw, y = _data(1)
    cal = SmoothedIsotonic(5).fit(raw, y)
    grid = np.linspace(-0.5, 2.0, 400)
    p = cal.predict(grid)
    assert np.all(np.diff(p) >= -1e-12)
    assert 0 <= p.min() and p.max() <= 1
    # calibration in the large: the mean prediction stays near the base rate
    assert abs(cal.predict(raw).mean() - y.mean()) < 0.01


def test_zero_prior_is_plain_isotonic():
    from sklearn.isotonic import IsotonicRegression
    raw, y = _data(2)
    a = SmoothedIsotonic(0).fit(raw, y).predict(raw)
    b = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(raw, y).predict(raw)
    assert np.allclose(a, b)
