"""Shared latent model for the external sources: single-year population grid, risk-factor prevalences and the gastric
cancer onset hazard, written analytically from the same formulas the EMR generator samples per person.

- prevalences: generator/population.py (H. pylori +3 pp per 10 years of age in 2020, hotspot H. pylori/salt/smoked food,
  smoking by sex/age/rural, heavy alcohol, atrophy among H. pylori positives), with the lifestyle drift of
  config/external.yaml around 2020;
- hazard: generator/diseases/gastric_cancer.py (h0_per_100k anchors, relative risks, INS-1 district residual RR and
  spillover, INS-2 young-onset trend with its lag), as the expectation over the prevalences (risk factors independent,
  as the generator draws them).
"""
from __future__ import annotations

import json
from functools import lru_cache

import numpy as np

from shared.config import REF_DIR, load_yaml
from shared.geo import DISTRICT_CODES, DISTRICTS

from ..diseases.gastric_cancer import h0_per_100k

AGES = np.arange(101)                     # single years 0..100 (100 = open)
BANDS = [f"{5 * i:02d}-{5 * i + 4:02d}" for i in range(17)] + ["85+"]
BAND_OF_AGE = np.minimum(AGES // 5, 17)
SEXES = ["M", "F"]
D = len(DISTRICT_CODES)
PROV = np.array([DISTRICTS[k][0] for k in DISTRICT_CODES])


def ext_cfg() -> dict:
    return load_yaml("external.yaml")


@lru_cache(maxsize=1)
def district_flags(gen_cfg_key: str = "generator.yaml") -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """hot (INS-1 hotspot), near_hot (bordering districts, D-24), kigali masks over DISTRICT_CODES."""
    ins1 = load_yaml(gen_cfg_key)["insights"]["ins1"]
    hot_codes = set(ins1["districts"]) if ins1["enabled"] else set()
    near = set()
    if hot_codes and ins1.get("spillover_rr"):
        adj = json.load(open(REF_DIR / "district_adjacency.json"))["adjacency"]
        near = {n for k in hot_codes for n in adj[k]} - hot_codes
    hot = np.array([k in hot_codes for k in DISTRICT_CODES])
    near_hot = np.array([k in near for k in DISTRICT_CODES])
    kgl = PROV == "KGL"
    return hot, near_hot, kgl


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _expit(x):
    return 1 / (1 + np.exp(-x))


def drift(p: np.ndarray, key: str, year: float) -> np.ndarray:
    k = float(ext_cfg()["surveys"]["logit_drift_per_year"].get(key, 0.0))
    return _expit(_logit(p) + k * (year - 2020)) if k else p


def prevalences(year: float, gen: dict) -> dict[str, np.ndarray]:
    """Risk-factor prevalences [district, sex(M,F), age] at mid-`year` (age = age that year)."""
    hot, _, kgl = district_flags()
    ins1 = gen["insights"]["ins1"]
    a2020 = (AGES - (year - 2020))[None, None, :]              # birth cohort: a person's age in 2020
    hotd = hot[:, None, None]
    male = np.array([True, False])[None, :, None]
    rural = np.where(kgl, 1.0, 1.2)[:, None, None]
    agefac = np.where((a2020 >= 30) & (a2020 <= 60), 1.25, 0.7)
    adult2020 = a2020 >= 15
    hp_base = np.where(hotd, ins1["hp_prev"], 0.55)
    hp = np.clip(hp_base + 0.03 * (a2020 - 40) / 10, 0.15, 0.95) * np.ones((D, 2, 1))
    smk_cur = np.where(male, 0.18, 0.03) * rural * agefac * adult2020
    smk_for = np.where(male, 0.08, 0.01) * agefac * adult2020 * np.ones((D, 1, 1))
    smk_cur = drift(smk_cur, "smoking", year)
    heavy = drift(np.where(male, 0.15, 0.05) * np.ones((D, 1, 101)), "alcohol", year)
    alcohol_any = drift(np.where(male, 0.15 + 0.85 * 0.35, 0.05 + 0.95 * 0.18) * np.ones((D, 1, 101)), "alcohol", year)
    salt = drift(np.where(hotd, ins1["high_salt_prev"], 0.35) * np.ones((1, 2, 101)), "salt", year)
    smoked = drift(np.where(hotd, ins1["smoked_food_prev"], 0.25) * np.ones((1, 2, 101)), "smoked_food", year)
    # atrophy/IM among H. pylori positives older than 40 in 2020, onsets spread 2008-2026 (generator/population.py)
    at = np.where(a2020 > 40, 0.04 * np.clip((a2020 - 35) / 20, 0.5, 2.0), 0.0) * np.clip((year - 2008) / 18, 0, 1)
    adult = AGES[None, None, :] >= 15
    return {"hp_seroprev": hp, "smoking_current": smk_cur * adult, "smoking_former": smk_for * adult,
            "alcohol_heavy": heavy * adult, "alcohol_any": alcohol_any * adult, "high_salt": salt * np.ones((D, 2, 1)),
            "smoked_food": smoked * np.ones((D, 2, 1)), "atrophy_given_hp": at * np.ones((D, 2, 1))}


def onset_hazard(year: float, gen: dict, h_mult: float = 1.0) -> np.ndarray:
    """Expected gastric cancer onset hazard per person-year [district, sex, age] in calendar `year`."""
    gc, ins = gen["gastric_cancer"], gen["insights"]
    rr, ins2 = gc["rr"], ins["ins2"]
    hot, near_hot, _ = district_flags()
    pv = prevalences(year, gen)
    age = AGES[None, None, :].astype(float)
    young = age < ins2.get("age_lt", 50)
    male = np.array([True, False])[None, :, None]
    h = h0_per_100k(AGES.astype(float), gc["h0_anchor_per_100k"])[None, None, :] / 1e5
    rr_sex = np.where(male, np.where(young, gc.get("rr_male_young", 1.08), rr["male"]), 1.0)
    rr_hp = np.where(young, gc.get("rr_hp_young", 1.85), rr["hp"])
    p_hp = pv["hp_seroprev"]
    e_hp_at = 1 - p_hp + p_hp * rr_hp * (1 + pv["atrophy_given_hp"] * (rr["atrophy_im"] - 1))
    e_base = ((1 + pv["smoking_current"] * (rr["smoker_current"] - 1) + pv["smoking_former"] * (rr["smoker_former"] - 1))
              * (1 + pv["alcohol_heavy"] * (rr["alcohol_heavy"] - 1)) * (1 + pv["high_salt"] * (rr["high_salt"] - 1))
              * (1 + pv["smoked_food"] * (rr["smoked_food"] - 1)) * (1 + 0.03 * (rr["family_hx"] - 1)))
    dist_rr = np.ones(D)
    if ins["ins1"]["enabled"]:
        dist_rr = np.where(hot, ins["ins1"]["residual_rr"], np.where(near_hot, ins["ins1"].get("spillover_rr", 1.0), 1.0))
    trend = np.ones_like(age)
    if ins2["enabled"]:
        yeff = year + float(gc.get("trend_lag_years", 2.0))
        trend = np.where(young, ins2["annual_multiplier"] ** max(0.0, yeff - (ins2["start_year"] - 1)),
                         ins2["older_annual_multiplier"] ** (yeff - 2015))
    return h * rr_sex * e_hp_at * e_base * dist_rr[:, None, None] * trend * h_mult


def dx_rate(year: int, gen: dict, h_mult: float, lag: float, diag_fraction: float) -> np.ndarray:
    """Rate of diagnosed cases per person-year [district, sex, age] in `year`: onset hazard `lag` years earlier at
    `lag` years younger, times the diagnosed fraction (the generator calibration uses the same +2 y shift)."""
    h = onset_hazard(year - lag, gen, h_mult)
    k = int(round(lag))
    out = np.zeros_like(h)
    out[:, :, k:] = h[:, :, :101 - k]
    return out * diag_fraction


def who_weights() -> np.ndarray:
    from shared.geo import WHO_STD
    w = np.array(WHO_STD, float)
    return w / w.sum()


def asr(cases_band: np.ndarray, pop_band: np.ndarray) -> float:
    """Age-standardised rate per 100k (WHO world) from 18-band arrays."""
    r = np.divide(cases_band, pop_band, out=np.zeros_like(cases_band, dtype=float), where=pop_band > 0)
    return float((r * who_weights()).sum() * 1e5)


def to_bands(x: np.ndarray) -> np.ndarray:
    """Sum the last (age) axis into the 18 five-year bands."""
    out = np.zeros(x.shape[:-1] + (18,))
    for b in range(18):
        out[..., b] = x[..., BAND_OF_AGE == b].sum(-1)
    return out
