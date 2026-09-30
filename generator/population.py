"""Vectorised population + latent risk factors (SPEC §8.3–§8.4)."""
from __future__ import annotations

import json

import numpy as np

from shared.config import REF_DIR
from shared.geo import DISTRICT_CODES, DISTRICTS, PYRAMID, normalised_weights

from .dates import d

SIM_END = d("2027-12-31")  # we pre-simulate beyond history_end; simulator replays the future (docs/decisions.md D-07)
REF_2020 = d("2020-07-01")
START = d("2015-01-01")


def _pyramid(older_mult: float = 1.0) -> np.ndarray:
    p = np.array(PYRAMID, dtype=float)
    p[12:] *= older_mult  # 60+
    return p / p.sum()


def build_population(cfg: dict, facs: list[dict], seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    scale = float(cfg["scale"])
    n0 = int(round(cfg["population"]["n_patients_base"] * scale / 1.187))
    ins = cfg["insights"]

    # --- district & age ------------------------------------------------------------------
    w = normalised_weights()
    dist_idx = rng.choice(len(DISTRICT_CODES), size=n0, p=[w[k] for k in DISTRICT_CODES])
    age2020 = np.empty(n0)
    decoy = DISTRICT_CODES.index(ins["ins1b"]["district"]) if ins["ins1b"]["enabled"] else -1
    for di in (True, False):
        m = (dist_idx == decoy) if di else (dist_idx != decoy)
        pyr = _pyramid(ins["ins1b"]["age60plus_multiplier"] if di else 1.0)
        bins = rng.choice(len(pyr), size=m.sum(), p=pyr)
        width = np.where(bins == 16, 15, 5)
        age2020[m] = bins * 5 + rng.random(m.sum()) * width
    # births after 2020-07 (continuing the 0-4 inflow)
    n_birth = int(n0 * 0.187)
    b_dist = rng.choice(len(DISTRICT_CODES), size=n_birth, p=[w[k] for k in DISTRICT_CODES])
    b_age = -rng.random(n_birth) * (SIM_END - REF_2020) / 365.25
    dist_idx = np.concatenate([dist_idx, b_dist])
    age2020 = np.concatenate([age2020, b_age])
    n = len(dist_idx)
    birth = (REF_2020 - age2020 * 365.25).astype(np.int64)
    sex = (rng.random(n) >= cfg["population"]["female_share"]).astype(np.int8)  # 1 = male

    # --- sector, home facility, coordinates ---------------------------------------------
    sectors = json.load(open(REF_DIR / "sectors.json"))
    sec_by_d = {k: [i for i, s in enumerate(sectors) if s["district_code"] == k] for k in DISTRICT_CODES}
    sector_idx = np.empty(n, dtype=np.int32)
    for di, k in enumerate(DISTRICT_CODES):
        m = np.where(dist_idx == di)[0]
        ids = sec_by_d[k]
        area = np.array([sectors[i]["area"] for i in ids]) ** 0.5
        sector_idx[m] = rng.choice(ids, size=len(m), p=area / area.sum())
    hcs = [f for f in facs if f["facility_type"] == "HEALTH_CENTRE"]
    hc_by_sector: dict[str, list[dict]] = {}
    hc_by_d: dict[str, list[dict]] = {}
    for f in hcs:
        hc_by_sector.setdefault((f["district_code"], f["sector"]), []).append(f)
        hc_by_d.setdefault(f["district_code"], []).append(f)
    home = np.empty(n, dtype=np.int32)
    for si in np.unique(sector_idx):
        m = np.where(sector_idx == si)[0]
        s = sectors[si]
        local = hc_by_sector.get((s["district_code"], s["sector"]))
        pool = local if local and rng.random() < 0.9 else hc_by_d[s["district_code"]]
        cw = np.array([f["catchment_weight"] for f in pool])
        home[m] = rng.choice([f["location_id"] for f in pool], size=len(m), p=cw / cw.sum())
    # coordinate = sector centroid + jitter (addresses are approximate by construction)
    cen = np.array([s["centroid"] for s in sectors])
    lon = cen[sector_idx, 0] + rng.normal(0, 0.012, n)
    lat = cen[sector_idx, 1] + rng.normal(0, 0.012, n)

    # micro-cluster sector (INS-1): pick one NOR-MUS sector deterministically
    mc = ins["ins1"]["micro_cluster"]
    mus_secs = sec_by_d[mc["district"]]
    micro_sector = mus_secs[int(np.random.default_rng(seed + 7).integers(len(mus_secs)))] if mc.get("sector", "auto") == "auto" \
        else next(i for i in mus_secs if sectors[i]["sector"] == mc["sector"])

    # --- deaths (Gompertz-like background) -----------------------------------------------
    death = np.full(n, 10**7, dtype=np.int64)
    for y in range(2015, 2028):
        ys = d(f"{y}-01-01")
        age = (ys + 182 - birth) / 365.25
        alive = (death > ys) & (birth <= ys + 365)
        h = 0.0006 + 0.00005 * np.exp(0.085 * np.clip(age, 0, 110)) + np.where(age < 5, 0.006, 0)
        die = alive & (rng.random(n) < 1 - np.exp(-h))
        death[die] = np.maximum(birth[die], ys) + rng.integers(0, 365, die.sum())

    # --- latent risk factors ---------------------------------------------------------------
    hot = np.isin(dist_idx, [DISTRICT_CODES.index(k) for k in ins["ins1"]["districts"]]) if ins["ins1"]["enabled"] else np.zeros(n, bool)
    kgl = np.array([DISTRICTS[DISTRICT_CODES[i]][0] == "KGL" for i in range(len(DISTRICT_CODES))])[dist_idx]
    water = rng.choice([7060, 7061, 7062], size=n, p=[0.35, 0.45, 0.20])
    water[kgl] = rng.choice([7060, 7061, 7062], size=kgl.sum(), p=[0.75, 0.2, 0.05])
    hp_base = np.where(hot, ins["ins1"]["hp_prev"], 0.55)
    hp_p = np.clip((hp_base + 0.03 * (age2020 - 40) / 10) * np.where(water == 7062, 1.2, 1.0) / 1.02, 0.15, 0.95)
    hp = rng.random(n) < hp_p
    male = sex == 1
    agefac = np.where((age2020 >= 30) & (age2020 <= 60), 1.25, 0.7)
    rural = np.where(kgl, 1.0, 1.2)
    u = rng.random(n)
    p_cur = np.where(male, 0.18, 0.03) * rural * agefac
    p_for = np.where(male, 0.08, 0.01) * agefac
    tobacco = np.where(u < p_cur, 7032, np.where(u < p_cur + p_for, 7031, 7030))
    tobacco[age2020 < 15] = 7030
    alcohol_heavy = rng.random(n) < np.where(male, 0.15, 0.05)
    u = rng.random(n)
    alcohol = np.where(alcohol_heavy | (u < np.where(male, 0.35, 0.18)), 7032, np.where(u < np.where(male, 0.45, 0.24), 7031, 7030))
    salt = rng.random(n) < np.where(hot, ins["ins1"]["high_salt_prev"], 0.35)
    smoked = rng.random(n) < np.where(hot, ins["ins1"]["smoked_food_prev"], 0.25)
    household = (dist_idx.astype(np.int64) * 10**7 + rng.integers(0, max(1, n // 30 // 4), n))
    hh_ids, inv = np.unique(household, return_inverse=True)
    fam = (rng.random(len(hh_ids)) < 0.03)[inv]
    nsaid = rng.random(n) < 0.08
    atrophy_day = np.full(n, 10**7, dtype=np.int64)
    at_m = hp & (age2020 > 40) & (rng.random(n) < 0.04 * np.clip((age2020 - 35) / 20, 0.5, 2.0))
    atrophy_day[at_m] = d("2008-01-01") + rng.integers(0, d("2026-01-01") - d("2008-01-01"), at_m.sum())
    adult_2020 = age2020 >= 15
    hiv = adult_2020 & (age2020 < 70) & (rng.random(n) < 0.03)
    hiv_dx = np.full(n, 10**7, dtype=np.int64)
    hiv_dx[hiv] = d("2008-01-01") + rng.integers(0, d("2026-06-01") - d("2008-01-01"), hiv.sum())
    htn = (age2020 > 35) & (rng.random(n) < 0.15 * np.clip((age2020 - 25) / 25, 0.4, 1.8))
    htn_dx = np.full(n, 10**7, dtype=np.int64)
    htn_dx[htn] = np.maximum(birth[htn] + 35 * 365, d("2012-01-01")) + rng.integers(0, 365 * 8, htn.sum())
    dm = (age2020 > 35) & (rng.random(n) < 0.03 * np.clip((age2020 - 25) / 25, 0.4, 1.8))
    dm_dx = np.full(n, 10**7, dtype=np.int64)
    dm_dx[dm] = np.maximum(birth[dm] + 35 * 365, d("2012-01-01")) + rng.integers(0, 365 * 8, dm.sum())
    fuel = rng.choice([7050, 7051, 7052], size=n, p=[0.6, 0.3, 0.1])
    fuel[kgl] = rng.choice([7050, 7051, 7052], size=kgl.sum(), p=[0.1, 0.6, 0.3])
    occupation = rng.choice([7070, 7071, 7072, 7073, 7074], size=n, p=[0.62, 0.12, 0.1, 0.08, 0.08])
    occupation[kgl] = rng.choice([7070, 7071, 7072, 7073, 7074], size=kgl.sum(), p=[0.15, 0.3, 0.3, 0.15, 0.1])
    fruit_veg = np.clip(np.round(rng.normal(np.where(hot, 2.5, 3.5), 1.5, n)), 0, 7)
    hb_base = np.where(male, rng.normal(14.6, 1.1, n), rng.normal(13.1, 1.0, n))
    height = np.where(male, rng.normal(168, 7, n), rng.normal(157, 6, n))
    bmi = np.clip(rng.normal(np.where(kgl, 23.8, 21.8), 3.0, n), 15.5, 40)

    # --- migration (4% of adults move district once) --------------------------------------
    move_day = np.full(n, 10**7, dtype=np.int64)
    mv = adult_2020 & (rng.random(n) < cfg["population"]["migration_rate_adults"])
    move_day[mv] = d("2015-06-01") + rng.integers(0, d("2026-06-01") - d("2015-06-01"), mv.sum())
    dist2 = dist_idx.copy()
    dist2[mv] = rng.choice(len(DISTRICT_CODES), size=mv.sum(), p=[w[k] for k in DISTRICT_CODES])
    sector2 = sector_idx.copy()
    home2 = home.copy()
    for i in np.where(mv)[0]:
        k = DISTRICT_CODES[dist2[i]]
        sector2[i] = rng.choice(sec_by_d[k])
        pool = hc_by_d[k]
        home2[i] = pool[int(rng.integers(len(pool)))]["location_id"]

    go_live = {f["location_id"]: f["go_live"] for f in facs}
    emr_start = np.array([go_live[h] for h in home], dtype=np.int64)

    return {
        "person_id": np.arange(1, n + 1, dtype=np.int64), "sex": sex, "birth": birth, "death": death,
        "district_idx": dist_idx.astype(np.int16), "sector_idx": sector_idx, "home": home, "lat": lat, "lon": lon,
        "emr_start": emr_start, "hp": hp, "tobacco": tobacco.astype(np.int16), "alcohol": alcohol.astype(np.int16),
        "alcohol_heavy": alcohol_heavy, "salt": salt, "smoked": smoked, "family_hx": fam, "nsaid": nsaid,
        "atrophy_day": atrophy_day, "hiv": hiv, "hiv_dx": hiv_dx, "htn": htn, "htn_dx": htn_dx, "dm": dm, "dm_dx": dm_dx,
        "water": water.astype(np.int16), "fuel": fuel.astype(np.int16), "occupation": occupation.astype(np.int16),
        "fruit_veg": fruit_veg, "hb_base": hb_base, "height": height, "bmi": bmi, "hot": hot,
        "micro": sector_idx == micro_sector, "move_day": move_day, "district2_idx": dist2.astype(np.int16),
        "sector2_idx": sector2, "home2": home2, "household": inv.astype(np.int64),
        "_micro_sector_name": np.array([sectors[micro_sector]["sector"]]),
    }
