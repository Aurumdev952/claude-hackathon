"""Synthetic facilities (SPEC §5.4). Real facility names are never used."""
from __future__ import annotations

import json
import random

from shapely.geometry import Point, shape

from shared.config import REF_DIR
from shared.geo import DISTRICTS, PROVINCES, normalised_weights

from .dates import d

PROVINCIAL_SITES = {"NOR": "NOR-MUS", "SOU": "SOU-MUH", "EAS": "EAS-RWA", "WES": "WES-KAR"}
REFERRAL_SITES = [("KGL-NYR", "A"), ("KGL-GAS", "B"), ("KGL-KIC", "C"), ("SOU-HUY", "D")]
EXTRA_DH = ["KGL-GAS", "EAS-NYA"]  # large districts get a second district hospital


def _sectors_by_district():
    sectors = json.load(open(REF_DIR / "sectors.json"))
    out: dict[str, list[dict]] = {}
    for s in sectors:
        out.setdefault(s["district_code"], []).append(s)
    return out


def _point_in(geom, rnd: random.Random):
    g = shape(geom)
    minx, miny, maxx, maxy = g.bounds
    for _ in range(200):
        p = Point(rnd.uniform(minx, maxx), rnd.uniform(miny, maxy))
        if g.contains(p):
            return p.x, p.y
    c = g.representative_point()
    return c.x, c.y


def build_facilities(cfg: dict, seed: int) -> list[dict]:
    rnd = random.Random(seed + 101)
    secs = _sectors_by_district()
    weights = normalised_weights()
    fcfg = cfg["facilities"]
    ins5 = cfg["insights"]["ins5"]
    n_hc = int(fcfg.get("n_health_centres", 200))

    # district rollout dates (INS-7): Kigali first, the rest spread to mid-2019
    # ~20% of the population is covered through 2015 (Kigali + 3 pilot districts), the rest roll out to mid-2019,
    # so crude counts rise ~4-6x by 2019 from coverage alone (INS-7)
    order = sorted(DISTRICTS, key=lambda k: (0 if k.startswith("KGL") else 1, rnd.random()))
    lo, hi = d("2015-01-01"), d("2019-06-30")
    n_pilot = 8   # D-25: 6 pilots made 2015 coverage so thin that 2019/2015 counts rose 7.6x (INS-7: 4-6x)
    rollout = {}
    for i, k in enumerate(order):
        if i < n_pilot:
            rollout[k] = lo + rnd.randint(0, 45)
        else:
            frac = (i - n_pilot) / (len(order) - n_pilot - 1)
            rollout[k] = int(lo + 300 + (hi - lo - 300) * frac + rnd.uniform(-30, 30))
        rollout[k] = max(lo, min(hi, rollout[k]))

    facs: list[dict] = []

    def add(loc_id, name, ftype, dcode, sector=None, endo_from=None, go_live=None, tier=None, prefix=None):
        prov = DISTRICTS[dcode][0]
        sec = sector or rnd.choice(secs[dcode])
        lon, lat = _point_in(sec["geometry"], rnd)
        facs.append({
            "location_id": loc_id, "name": name, "facility_type": ftype, "district_code": dcode,
            "province_code": prov, "province": PROVINCES[prov], "district": DISTRICTS[dcode][1],
            "sector": sec["sector"], "lat": round(lat, 5), "lon": round(lon, 5),
            "endoscopy_from": endo_from, "go_live": go_live, "hp_testing_tier": tier,
            "prefix": prefix or DISTRICTS[dcode][1][:3].upper(), "catchment_weight": 1.0,
            "parent_location": None,
        })

    for i, (dcode, letter) in enumerate(REFERRAL_SITES):
        add(1001 + i, f"Referral Hospital {letter} (Synthetic)", "REFERRAL", dcode,
            endo_from=d("2010-01-01"), go_live=d("2015-01-01") + rnd.randint(0, 60), tier="high", prefix=f"RH{letter}")
    for i, (prov, dcode) in enumerate(PROVINCIAL_SITES.items()):
        add(1101 + i, f"Provincial Hospital {PROVINCES[prov]} (Synthetic)", "PROVINCIAL", dcode,
            endo_from=d(f"{rnd.choice([2015, 2016, 2017, 2018])}-{rnd.randint(1, 12):02d}-01"),
            go_live=max(d("2015-01-01"), rollout[dcode] - rnd.randint(30, 200)), prefix=f"PH{prov[0]}")
    dh_id = 1201
    dh_districts = list(DISTRICTS) + EXTRA_DH
    for n, dcode in enumerate(dh_districts):
        second = n >= len(DISTRICTS)
        name = f"{DISTRICTS[dcode][1]} {'North ' if second else ''}District Hospital (Synthetic)"
        endo = None
        if dcode == ins5["district"]:
            endo = d(str(ins5["endoscopy_from"])) if ins5.get("enabled", True) else None
        elif rnd.random() < 0.33 and dcode not in PROVINCIAL_SITES.values():
            endo = d(f"{rnd.randint(2016, 2024)}-{rnd.randint(1, 12):02d}-01")
        add(dh_id, name, "DISTRICT", dcode, endo_from=endo, go_live=rollout[dcode] + rnd.randint(-20, 40))
        dh_id += 1

    # health centres, allocated by population weight, one per sector at most first
    alloc = {k: max(3, round(weights[k] * n_hc)) for k in DISTRICTS}
    hc_id = 2001
    for dcode in DISTRICTS:
        pool = list(secs[dcode])
        rnd.shuffle(pool)
        for j in range(alloc[dcode]):
            sec = pool[j % len(pool)]
            suffix = "" if j < len(pool) else " II"
            add(hc_id, f"{sec['sector']}{suffix} Health Centre (Synthetic)", "HEALTH_CENTRE", dcode, sector=sec,
                go_live=rollout[dcode] + rnd.randint(0, 60))
            facs[-1]["catchment_weight"] = round(rnd.uniform(0.6, 1.6), 3)
            hc_id += 1

    # HP testing tiers (INS-4): 45/35/20, correlated with (not identical to) province; >=1 high & low per province
    shares = fcfg["hp_testing_tier_shares"]
    prov_bias = {"KGL": 0.12, "NOR": 0.0, "WES": -0.03, "SOU": -0.04, "EAS": -0.05}
    for f in facs:
        if f["hp_testing_tier"]:
            continue
        u = rnd.random() - prov_bias[f["province_code"]]
        f["hp_testing_tier"] = "low" if u < shares["low"] else ("medium" if u < shares["low"] + shares["medium"] else "high")
    for prov in PROVINCES:
        pf = [f for f in facs if f["province_code"] == prov and f["facility_type"] != "REFERRAL"]
        for tier in ("high", "low"):
            if not any(f["hp_testing_tier"] == tier for f in pf):
                rnd.choice(pf)["hp_testing_tier"] = tier

    # parent locations: HCs -> their district hospital
    dh_by_district = {}
    for f in facs:
        if f["facility_type"] == "DISTRICT":
            dh_by_district.setdefault(f["district_code"], f["location_id"])
    for f in facs:
        if f["facility_type"] == "HEALTH_CENTRE":
            f["parent_location"] = dh_by_district[f["district_code"]]
    # Hb g/L unit noise at 5 facilities (SPEC §8.9)
    noisy = rnd.sample([f for f in facs if f["facility_type"] in ("DISTRICT", "HEALTH_CENTRE")],
                       cfg["quality_noise"]["hb_gL_units"]["n_facilities"])
    for f in facs:
        f["hb_gL"] = f in noisy
    return facs


def facility_events(facs: list[dict]) -> list[dict]:
    ev = []
    for f in facs:
        ev.append({"location_id": f["location_id"], "event_date": f["go_live"], "event_type": "EMR_GO_LIVE",
                   "description": f"EMR go-live: {f['name']}"})
        if f["endoscopy_from"] and f["endoscopy_from"] > d("2015-01-01"):
            ev.append({"location_id": f["location_id"], "event_date": f["endoscopy_from"], "event_type": "ENDOSCOPY_OPENED",
                       "description": f"Endoscopy opened: {f['name']}"})
    return ev
