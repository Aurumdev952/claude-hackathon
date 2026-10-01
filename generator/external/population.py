"""NISR-style population estimates 2000-2025 and projections 2026-2035 by district, sex and 5-year age band.

Base 2020 structure = the generator's pyramid (shared.geo.PYRAMID, the same one generator/population.py samples), census
district shares, and the INS-1b older structure of SOU-NYG. Earlier years by reverse survival with the generator's
Gompertz background mortality (higher in the past), rescaled to the national anchors; later years by cohort component
(births from a falling crude birth rate, the same mortality improving each year, net migration towards Kigali).
"""
from __future__ import annotations

import numpy as np
import polars as pl

from shared.geo import DISTRICT_CODES, PYRAMID, normalised_weights

from .model import AGES, BANDS, D, PROV, SEXES, to_bands

YEARS = list(range(2000, 2036))


def _interp_anchor(anchors: dict, y: int) -> float:
    ks = sorted(int(k) for k in anchors)
    v = np.log([float(anchors[k]) for k in ks])
    if y <= ks[-1]:
        return float(np.exp(np.interp(y, ks, v)))
    g = (v[-1] - v[-2]) / (ks[-1] - ks[-2])
    return float(np.exp(v[-1] + g * (y - ks[-1])))


def _q(year: int, pc: dict) -> np.ndarray:
    """Annual death probability by single age (generator/population.py hazard x period multiplier)."""
    a = AGES.astype(float)
    h = 0.0006 + 0.00005 * np.exp(0.085 * a) + np.where(a < 5, 0.006, 0.0)
    m = float(pc["mortality_multiplier_2020"]) * (1 - float(pc["mortality_improvement_per_year"])) ** (year - 2020)
    return 1 - np.exp(-h * m)


def _migration(P: np.ndarray, pc: dict, sign: float) -> np.ndarray:
    """Net internal migration for one year (sign -1 undoes it when back-projecting); national total unchanged."""
    rates = np.array([pc["net_migration_pct"].get(p, pc["net_migration_pct"]["default"]) for p in PROV]) / 100
    tot_d = P.sum(axis=(1, 2))
    gain = np.where(rates > 0, rates * tot_d, 0.0)
    loss_w = np.where(rates < 0, -rates * tot_d, 0.0)
    flow = gain - loss_w / max(loss_w.sum(), 1e-9) * gain.sum()
    f = 1 + sign * flow / np.maximum(tot_d, 1e-9)
    return P * f[:, None, None]


def base_2020(pc: dict) -> np.ndarray:
    """[district, sex, age] mid-2020 population at the national anchor."""
    dens = np.zeros(101)
    for b, share in enumerate(PYRAMID):
        if b == 16:  # open 80+ bin: the generator spreads it over 80-94; here it thins out with age
            tail = 0.8 ** np.arange(15)
            dens[80:95] = share * tail / tail.sum()
        else:
            dens[5 * b:5 * b + 5] = share / 5
    w = normalised_weights()
    P = np.zeros((D, 2, 101))
    m60 = float(pc.get("ins1b_age60plus_multiplier", 1.0))
    for di, k in enumerate(DISTRICT_CODES):
        dd = dens.copy()
        if k == "SOU-NYG":
            dd[60:] *= m60
        dd /= dd.sum()
        for si, share in enumerate((1 - pc["female_share"], pc["female_share"])):
            P[di, si] = w[k] * share * dd
    return P * _interp_anchor(pc["anchors"], int(pc["base_year"]))


def build_grid(cfg: dict) -> dict[int, np.ndarray]:
    """{year: [district, sex, age]} for 2000-2035."""
    pc = cfg["population"]
    base = int(pc["base_year"])
    grid = {base: base_2020(pc)}
    # ---- back to 2000: reverse survival, old ages keep their shape, totals rescaled to the anchors
    for y in range(base - 1, YEARS[0] - 1, -1):
        nxt = _migration(grid[y + 1], pc, -1.0)
        q = _q(y, pc)
        P = np.zeros_like(nxt)
        P[:, :, :100] = nxt[:, :, 1:] / (1 - q[:100])
        P[:, :, 100] = 0.0
        # 60+: reverse survival divides by small survival probabilities and the cohorts above the pyramid's top are
        # missing, so the old-age shape is carried back, scaled with the 45-59 group
        ratio = P[:, :, 45:60].sum(-1, keepdims=True) / np.maximum(nxt[:, :, 45:60].sum(-1, keepdims=True), 1e-9)
        P[:, :, 60:] = nxt[:, :, 60:] * ratio
        P *= _interp_anchor(pc["anchors"], y) / P.sum()
        grid[y] = P
    # ---- forward to 2035: cohort component
    cbr = {int(k): float(v) for k, v in pc["cbr_per_1000"].items()}
    ks = sorted(cbr)
    srb = float(pc["sex_ratio_at_birth"])
    for y in range(base + 1, YEARS[-1] + 1):
        prev = grid[y - 1]
        q = _q(y - 1, pc)
        P = np.zeros_like(prev)
        P[:, :, 1:] = prev[:, :, :100] * (1 - q[:100])
        P[:, :, 100] += prev[:, :, 100] * (1 - q[100])
        births = np.interp(y, ks, [cbr[k] for k in ks]) / 1000 * prev.sum()
        women = prev[:, 1, 15:50].sum(-1)
        b_d = births * women / women.sum()
        P[:, 0, 0] = b_d * srb / (1 + srb) * (1 - q[0] / 2)
        P[:, 1, 0] = b_d / (1 + srb) * (1 - q[0] / 2)
        grid[y] = _migration(P, pc, 1.0)
    return grid


def to_frame(grid: dict[int, np.ndarray], cfg: dict) -> pl.DataFrame:
    pc = cfg["population"]
    rows = {"year": [], "district_code": [], "sex": [], "age_band": [], "population": [], "kind": []}
    for y in sorted(grid):
        B = to_bands(grid[y])
        kind = "estimate" if y <= int(pc["estimate_until"]) else "projection"
        for di, k in enumerate(DISTRICT_CODES):
            for si, s in enumerate(SEXES):
                for b, band in enumerate(BANDS):
                    rows["year"].append(y)
                    rows["district_code"].append(k)
                    rows["sex"].append(s)
                    rows["age_band"].append(band)
                    rows["population"].append(int(round(B[di, si, b])))
                    rows["kind"].append(kind)
    return pl.DataFrame(rows, schema={"year": pl.Int16, "district_code": pl.String, "sex": pl.String,
                                      "age_band": pl.String, "population": pl.Int64, "kind": pl.String}).with_columns(
        pl.lit(f"NISR-style population estimates and projections {cfg['source_note']}").alias("source_note"))
