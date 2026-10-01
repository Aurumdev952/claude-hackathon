"""Denominators (person-years) and data/ground_truth.json from the latent layer (SPEC §8.3, §9.10)."""
from __future__ import annotations

import datetime as dt
import json

import numpy as np
import polars as pl

from shared.geo import AGE_GROUPS, DISTRICT_CODES

from .dates import year_start

YEARS = list(range(2015, 2028))


def denominators(P: dict, death: np.ndarray, end_day: int) -> pl.DataFrame:
    n_d = len(DISTRICT_CODES)
    acc = np.zeros((n_d, 2, 18, len(YEARS)))
    birth, emr, move = P["birth"], P["emr_start"], P["move_day"]
    d1, d2, sex = P["district_idx"].astype(int), P["district2_idx"].astype(int), P["sex"].astype(int)
    c0 = np.maximum(birth, emr)
    c1 = np.minimum(death, end_day)
    for j, y in enumerate(YEARS):
        ys, ye = year_start(y), year_start(y + 1)
        age = (ys + 182 - birth) / 365.25
        ag = np.clip(age // 5, 0, 17).astype(int)
        ok = age >= 0
        a_lo, a_hi = np.maximum(c0, ys), np.minimum(np.minimum(c1, move), ye)
        expo_a = np.clip(a_hi - a_lo, 0, None) / 365.25
        b_lo, b_hi = np.maximum(np.maximum(c0, move), ys), np.minimum(c1, ye)
        expo_b = np.clip(b_hi - b_lo, 0, None) / 365.25
        m = ok & (expo_a > 0)
        np.add.at(acc, (d1[m], sex[m], ag[m], j), expo_a[m])
        m = ok & (expo_b > 0)
        np.add.at(acc, (d2[m], sex[m], ag[m], j), expo_b[m])
    rows = []
    for di, dc in enumerate(DISTRICT_CODES):
        for s in (0, 1):
            for g in range(18):
                for j, y in enumerate(YEARS):
                    rows.append((dc, "M" if s else "F", AGE_GROUPS[g], y, float(acc[di, s, g, j])))
    return pl.DataFrame(rows, schema=["district_code", "sex", "age_group", "year", "population"], orient="row")


def write_ground_truth(path, cfg: dict, seed: int, counts: dict, cases: pl.DataFrame, micro_sector: str):
    ins = cfg["insights"]
    gt = {
        "generator_version": "1.1.0",
        "seed": seed,
        "scale": cfg["scale"],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "counts": counts,
        "insights": {
            "INS-1": {"hotspot_districts": ins["ins1"]["districts"],
                      "micro_cluster_sector": {"district": ins["ins1"]["micro_cluster"]["district"], "sector": micro_sector},
                      "expected_asr_ratio": [2.3, 3.0]},
            "INS-1b": {"decoy_district": ins["ins1b"]["district"], "asr_ratio_to_national": [0.85, 1.15]},
            "INS-2": {"joinpoint_year_range": [2018, 2020], "apc_post_range": [5.0, 11.0], "age_band": "<50"},
            "INS-3": {"pct_ge3_gi_visits_range": [60, 70], "median_diag_interval_months_range": [7, 10]},
            "INS-4": {"stage4_low_tier_range": [58, 66], "stage4_high_tier_range": [34, 42], "eradication_hr_range": [0.45, 0.70]},
            "INS-5": {"district": ins["ins5"]["district"], "event": "endoscopy_opened", "date": str(ins["ins5"]["endoscopy_from"]),
                      "dx_increase_pct_range": [60, 100]},
            "INS-6": {"provinces": ins["ins6"]["provinces"], "extra_delay_months_range": [3, 5]},
            "INS-7": {"crude_count_ratio_2019_2015_range": [4, 6]},
            "INS-8": {"factor": "HIV", "true_effect": 1.0},
        },
        "latent_case_list_path": "data/bulk/latent/gastric_cases.parquet",
    }
    json.dump(gt, open(path, "w"), indent=2)
    return gt
