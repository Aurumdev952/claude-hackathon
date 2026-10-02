"""Das Gupta (1993) decomposition of the change in expected cases into population growth, ageing and risk.

cases = sum_c P * s_c * r_c over sex x age cells c, where P is the total population, s_c the population share of the
cell (the age-sex structure) and r_c the cell rate. For a product of three factors the effect of factor A is

    A_eff = sum_c (A2 - A1) * [ (B1 C1 + B2 C2) / 3 + (B1 C2 + B2 C1) / 6 ]

and likewise for B and C. The three effects add up exactly to the total change (a property tested in
tests/v3/test_forecast_drivers.py).
"""
from __future__ import annotations

import numpy as np


def das_gupta(pop1: np.ndarray, rate1: np.ndarray, pop2: np.ndarray, rate2: np.ndarray) -> dict:
    """pop*/rate* are cell arrays (same shape). Returns population/ageing/risk effects, totals and base/target cases."""
    pop1, pop2 = np.asarray(pop1, float), np.asarray(pop2, float)
    rate1, rate2 = np.asarray(rate1, float), np.asarray(rate2, float)
    P1, P2 = pop1.sum(), pop2.sum()
    s1 = pop1 / P1 if P1 > 0 else np.zeros_like(pop1)
    s2 = pop2 / P2 if P2 > 0 else np.zeros_like(pop2)

    def eff(a1, a2, b1, b2, c1, c2):
        return float(np.sum((a2 - a1) * ((b1 * c1 + b2 * c2) / 3 + (b1 * c2 + b2 * c1) / 6)))

    A1, A2 = np.full_like(s1, P1), np.full_like(s2, P2)
    population = eff(A1, A2, s1, s2, rate1, rate2)
    ageing = eff(s1, s2, A1, A2, rate1, rate2)
    risk = eff(rate1, rate2, A1, A2, s1, s2)
    c1 = float(np.sum(pop1 * rate1))
    c2 = float(np.sum(pop2 * rate2))
    return {"population": population, "ageing": ageing, "risk": risk, "total": c2 - c1, "cases_from": c1, "cases_to": c2}
