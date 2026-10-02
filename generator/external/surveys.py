"""DHS/STEPS-style risk-factor survey rounds by province, sex and age band (15-29, 30-49, 50+).

True prevalence = population-weighted mean of the generator's per-person prevalences (model.prevalences) in the survey
year. Each cell's sample is the round's n split by the cell's share of adults; the estimate has binomial noise inflated
by a design effect, and the 95% CI is logit-based with that design effect.
"""
from __future__ import annotations

import numpy as np
import polars as pl

from .model import PROV, SEXES, prevalences

AGE_BANDS = {"15-29": (15, 30), "30-49": (30, 50), "50+": (50, 101)}
PROVINCES = ["KGL", "NOR", "SOU", "EAS", "WES"]


def build(grid: dict, gen: dict, cfg: dict, rng: np.random.Generator) -> pl.DataFrame:
    sc = cfg["surveys"]
    lo_d, hi_d = sc["design_effect"]
    rows = []
    for rd in sc["rounds"]:
        y = int(rd["year"])
        P = grid[y]
        pv = prevalences(y + 0.5, gen)
        adults = P[:, :, 15:].sum()
        deff = float(rng.uniform(lo_d, hi_d))
        for prov in PROVINCES:
            dm = PROV == prov
            for si, s in enumerate(SEXES):
                for band, (a0, a1) in AGE_BANDS.items():
                    w = P[dm, si, a0:a1]
                    n = max(30, int(round(rd["n"] * w.sum() / adults)))
                    for ind in rd["indicators"]:
                        p_true = float((pv[ind][dm, si, a0:a1] * w).sum() / w.sum())
                        n_eff = max(1, int(round(n / deff)))
                        p_hat = rng.binomial(n_eff, min(max(p_true, 0.0), 1.0)) / n_eff
                        p_c = min(max(p_hat, 0.5 / n_eff), 1 - 0.5 / n_eff)
                        se_l = np.sqrt(deff / (n * p_c * (1 - p_c)))
                        lg = np.log(p_c / (1 - p_c))
                        lo = min(p_hat, float(1 / (1 + np.exp(-(lg - 1.96 * se_l)))))  # 0 or n events: CI keeps the estimate
                        hi = max(p_hat, float(1 / (1 + np.exp(-(lg + 1.96 * se_l)))))
                        rows.append((rd["survey"], y, prov, s, band, ind, round(p_hat, 4), round(lo, 4), round(hi, 4),
                                     n, round(deff, 2)))
    schema = {"survey": pl.String, "year": pl.Int16, "province_code": pl.String, "sex": pl.String, "age_band": pl.String,
              "indicator": pl.String, "value": pl.Float64, "lo95": pl.Float64, "hi95": pl.Float64, "n": pl.Int32,
              "design_effect": pl.Float64}
    return pl.DataFrame(rows, schema=schema, orient="row").with_columns(
        pl.lit(f"DHS/STEPS-style household survey {cfg['source_note']}").alias("source_note"))
