"""Unit tests for epidemiological methods (SPEC §12.2, §12.3 validation)."""
import math

import numpy as np
import pytest

from pipeline.metrics.asr import asr, fay_feuer
from pipeline.metrics.joinpoint import fit_joinpoint


def test_asr_equals_crude_for_flat_rates():
    pop = np.full(18, 10000.0)
    cases = np.full(18, 5.0)
    r = asr(cases, pop)
    assert math.isclose(r["asr"], 50.0, rel_tol=1e-9) and math.isclose(r["crude_rate"], 50.0)
    assert r["asr_lci"] < 50 < r["asr_uci"]


def test_asr_age_adjusts_older_population():
    rate = np.linspace(0.1, 50, 18) / 1e5
    young = np.array([10000] * 9 + [1000] * 9, float)
    old = np.array([1000] * 9 + [10000] * 9, float)
    ry, ro = asr(rate * young, young), asr(rate * old, old)
    assert ro["crude_rate"] > 2 * ry["crude_rate"]
    assert math.isclose(ry["asr"], ro["asr"], rel_tol=1e-9)


def test_fay_feuer_zero_cases_has_positive_upper():
    lo, hi = fay_feuer(0.0, 0.0, 2.0)
    assert lo == 0 and hi > 0


@pytest.mark.parametrize("jp,apc1,apc2", [(2019, 0.5, 8.0), (2018, -2.0, 6.0)])
def test_joinpoint_recovers_known_series(jp, apc1, apc2):
    years = np.arange(2015, 2026)
    b1, b2 = math.log(1 + apc1 / 100), math.log(1 + apc2 / 100)
    ln = np.log(10) + b1 * (years - 2015) + (b2 - b1) * np.clip(years - jp, 0, None)
    asr_ = np.exp(ln)
    var = (asr_ * 0.01) ** 2
    r = fit_joinpoint(years, asr_, var)
    assert r["n_joinpoints"] >= 1
    assert abs(r["joinpoints"][0] - jp) <= 1
    assert abs(r["segments"][-1]["apc"] - apc2) <= 1.0
    assert abs(r["segments"][0]["apc"] - apc1) <= 1.0


def test_joinpoint_flat_series_selects_zero_joinpoints():
    rng = np.random.default_rng(1)
    years = np.arange(2015, 2026)
    asr_ = 10 * np.exp(rng.normal(0, 0.02, len(years)))
    r = fit_joinpoint(years, asr_, (asr_ * 0.05) ** 2)
    assert r["n_joinpoints"] == 0 and not r["segments"][0]["significant"]
