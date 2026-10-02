"""National cancer registry history 2000-2026 (gastric, C16) by district, sex, 5-year age band.

Expected diagnosed cases = population x diagnosed-case rate from the EMR generator's hazard model (model.dx_rate),
with the baseline multiplier calibrated exactly as the generator calibrates its own (world-standard ASR of diagnosed
cases in 2024 = config/generator.yaml gastric_cancer.calibration.target_asr_2024, D-03/D-33). The registry then captures
a completeness share (40% in 2000 rising to 85% from 2015) and counts get Poisson noise. National scale: not limited by
the EMR's sample.
"""
from __future__ import annotations

import numpy as np
import polars as pl

from shared.geo import DISTRICT_CODES

from .model import BANDS, SEXES, asr, dx_rate, to_bands

STAGES = ["I", "II", "III", "IV"]


def _interp(table: dict, y: int):
    ks = sorted(int(k) for k in table)
    vals = np.array([table[k] if k in table else table[str(k)] for k in ks], dtype=float)
    if vals.ndim == 1:
        return float(np.interp(y, ks, vals))
    return np.array([np.interp(y, ks, vals[:, j]) for j in range(vals.shape[1])])


def calibrate(grid: dict, gen: dict, rc: dict) -> float:
    cal = gen["gastric_cancer"].get("calibration", {})
    target = float(cal.get("target_asr_2024", gen["gastric_cancer"]["targets"]["national_asr_2024"]))
    r = dx_rate(2024, gen, 1.0, float(rc["dx_lag_years"]), float(rc["diag_fraction"]))
    P = grid[2024]
    a = asr(to_bands((P * r).sum(axis=(0, 1))), to_bands(P.sum(axis=(0, 1))))
    return target / a


def build(grid: dict, gen: dict, cfg: dict, rng: np.random.Generator) -> tuple[pl.DataFrame, float]:
    rc = cfg["registry"]
    h_mult = calibrate(grid, gen, rc)
    y0, y1 = rc["years"]
    rows = []
    comp_tab = {int(k): float(v) for k, v in rc["completeness"].items()}
    young_band = np.array([int(b[:2]) < 50 for b in BANDS])
    for y in range(y0, y1 + 1):
        P = grid[y]
        r = dx_rate(y, gen, h_mult, float(rc["dx_lag_years"]), float(rc["diag_fraction"]))
        exp_b = to_bands(P * r)                       # [district, sex, band] expected diagnosed cases
        pop_b = to_bands(P)
        comp = _interp(comp_tab, y)
        cases = rng.poisson(exp_b * comp)
        stage_p = _interp({int(k): v for k, v in rc["stage_mix"].items()}, y)
        stage_p = stage_p / stage_p.sum()
        ish = np.where(young_band, rc["intestinal_share"]["young"], rc["intestinal_share"]["older"])
        for di, k in enumerate(DISTRICT_CODES):
            for si, s in enumerate(SEXES):
                n = cases[di, si]
                st = np.array([rng.multinomial(int(x), stage_p) for x in n])
                inte = rng.binomial(n, ish)
                for b, band in enumerate(BANDS):
                    c = int(n[b])
                    rows.append((y, k, s, band, c, round(comp, 3), float(exp_b[di, si, b]), float(pop_b[di, si, b]),
                                 round(inte[b] / c * 100, 1) if c else None,
                                 *[round(st[b, j] / c * 100, 1) if c else None for j in range(4)],
                                 y >= int(rc["provisional_from"])))
    schema = {"year": pl.Int16, "district_code": pl.String, "sex": pl.String, "age_band": pl.String, "cases": pl.Int32,
              "completeness": pl.Float64, "expected_true_cases": pl.Float64, "population": pl.Float64,
              "morphology_intestinal_pct": pl.Float64, "stage_I_pct": pl.Float64, "stage_II_pct": pl.Float64,
              "stage_III_pct": pl.Float64, "stage_IV_pct": pl.Float64, "provisional": pl.Boolean}
    df = pl.DataFrame(rows, schema=schema, orient="row").with_columns(
        pl.lit(f"National cancer registry, stomach C16 {cfg['source_note']}").alias("source_note"))
    return df, h_mult
