"""Spatial analysis (SPEC §12.5): queen contiguity, EB smoothing, global Moran's I, LISA (FDR), Getis-Ord Gi*, SIR."""
from __future__ import annotations

import json
import warnings

import numpy as np
from scipy.stats import chi2

from shared.config import REF_DIR


def weights(codes: list[str]):
    from libpysal.weights import W
    adj = json.load(open(REF_DIR / "district_adjacency.json"))["adjacency"]
    neigh = {c: [n for n in adj[c] if n in codes] for c in codes}
    w = W(neigh, id_order=codes, silence_warnings=True)
    w.transform = "r"
    return w


def eb_smooth(cases: np.ndarray, pop: np.ndarray) -> np.ndarray:
    """Global empirical Bayes (Marshall 1991) smoothing of crude rates."""
    r = cases / pop
    b = cases.sum() / pop.sum()
    s2 = (pop * (r - b) ** 2).sum() / pop.sum() - b / (pop.sum() / len(pop))
    s2 = max(s2, 0.0)
    shrink = s2 / (s2 + b / pop)
    return b + shrink * (r - b)


def sir_ci(obs: float, exp: float, alpha: float = 0.05) -> tuple[float, float, float]:
    if exp <= 0:
        return float("nan"), float("nan"), float("nan")
    lo = chi2.ppf(alpha / 2, 2 * obs) / 2 / exp if obs > 0 else 0.0
    hi = chi2.ppf(1 - alpha / 2, 2 * (obs + 1)) / 2 / exp
    return obs / exp, lo, hi


def bh_fdr(p: np.ndarray) -> np.ndarray:
    n = len(p)
    order = np.argsort(p)
    q = np.empty(n)
    prev = 1.0
    for rank, i in reversed(list(enumerate(order, start=1))):
        prev = min(prev, p[i] * n / rank)
        q[i] = prev
    return q


def analyse(codes: list[str], value: np.ndarray, permutations: int = 999, seed: int = 42) -> dict:
    from esda.getisord import G_Local
    from esda.moran import Moran, Moran_Local
    w = weights(codes)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        mi = Moran(value, w, permutations=permutations)
        np.random.seed(seed)
        lm = Moran_Local(value, w, permutations=permutations, seed=seed)
        g = G_Local(value, w, star=True, permutations=permutations, seed=seed)
    quad = {1: "HH", 2: "LH", 3: "LL", 4: "HL"}
    q_fdr = bh_fdr(lm.p_sim)
    lisa = [quad[int(qd)] if p < 0.05 else "NS" for qd, p in zip(lm.q, lm.p_sim)]
    return {"global_morans_i": float(mi.I), "global_p": float(mi.p_sim), "lisa_quadrant": lisa,
            "lisa_p": lm.p_sim.tolist(), "lisa_q_fdr": q_fdr.tolist(), "lisa_quadrant_fdr":
            [quad[int(qd)] if q < 0.05 else "NS" for qd, q in zip(lm.q, q_fdr)], "gi_star_z": np.asarray(g.Zs).tolist()}
