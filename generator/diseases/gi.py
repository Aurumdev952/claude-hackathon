"""GI module (SPEC §8.6): dyspepsia, gastritis, PUD, GERD, H. pylori testing/eradication, benign endoscopy.

Clinician behaviour depends on the facility's H. pylori testing tier (INS-4) and calendar year.
Shared clinical actions (HP testing, PPI/eradication, FBC, endoscopy) are reused by the cancer prodrome.
"""
from __future__ import annotations

import random

from shared.concepts import C

from ..context import (MIN_PER_DAY, TIER_ERADICATE, TIER_FBC, TIER_HP_TEST, TIER_PPI_ONLY, TIER_REFER, Ctx)
from ..dates import year_of
from ..emit import ORDER_REFERRAL, Recorder
from ..patient import Patient
from .base import clinic_time, pick_facility, record_lifestyle, vitals

GI_COMPLAINTS = [(2200, 0.42), (2211, 0.18), (2212, 0.10), (2202, 0.12), (2201, 0.18)]


def weighted(rnd: random.Random, items):
    tot = sum(w for _, w in items)
    u = rnd.random() * tot
    for k, w in items:
        u -= w
        if u <= 0:
            return k
    return items[-1][0]


def year_factor(day: int) -> float:
    """Testing practice improves slowly over time."""
    return 0.75 + 0.05 * (year_of(day) - 2015)


def hp_test(p: Patient, ctx: Ctx, rec: Recorder, enc, t: int, loc: int, rnd: random.Random, boost: float = 1.0) -> int | None:
    """Maybe order + record an H. pylori test. Returns result concept (POS/NEG) if recorded."""
    if enc is None:
        return None
    day = t // MIN_PER_DAY
    prob = min(0.95, TIER_HP_TEST[ctx.tier(loc)] * year_factor(day) * boost)
    if rnd.random() >= prob:
        return None
    infected = p.hp and (p.hp_erad_day is None or day < p.hp_erad_day)
    o = rec.order(enc, t, C.ORD_HP)
    concept = C.HP_STOOL if rnd.random() < 0.7 else C.HP_SERO
    if concept == C.HP_SERO:  # serology stays positive after eradication
        infected = p.hp
    pos = (rnd.random() < 0.92) if infected else (rnd.random() < 0.05)
    res = C.POS if pos else C.NEG
    if concept == C.HP_STOOL and rnd.random() < 0.02:
        res = C.INDET
    rec.obs(enc, t + 120, loc, concept, coded=res, order=o)
    return res


def treat_dyspepsia(p: Patient, ctx: Ctx, rec: Recorder, enc, t: int, loc: int, rnd: random.Random, hp_res, ppi_bias: float = 0.0):
    """PPI / antacid / eradication prescribing per tier."""
    if enc is None:
        return
    tier = ctx.tier(loc)
    day = t // MIN_PER_DAY
    if hp_res == C.POS:
        rec.dx(enc, t + 130, loc, 2019)
        if rnd.random() < TIER_ERADICATE[tier]:
            rec.drug(enc, t + 140, C.OMEPRAZOLE, 14, freq="BD")
            rec.drug(enc, t + 141, C.AMOX, 14, freq="BD")
            rec.drug(enc, t + 142, C.CLARI if rnd.random() < 0.7 else C.METRO, 14, freq="BD")
            if rnd.random() < 0.15:
                rec.drug(enc, t + 143, C.BISMUTH, 14, freq="QID")
            if p.hp and (p.hp_erad_day is None) and rnd.random() < 0.85:
                p.hp_erad_day = day + 14
            return
    if rnd.random() < min(0.95, TIER_PPI_ONLY[tier] + ppi_bias):
        rec.drug(enc, t + 140, C.OMEPRAZOLE, rnd.choice([14, 28, 28, 30]))
    elif rnd.random() < 0.6:
        rec.drug(enc, t + 140, C.ANTACID, 14, freq="TDS")


def fbc(p: Patient, ctx: Ctx, rec: Recorder, enc, t: int, loc: int, rnd: random.Random, boost: float = 1.0):
    if enc is None or rnd.random() >= min(0.95, TIER_FBC[ctx.tier(loc)] * boost):
        return None
    day = t // MIN_PER_DAY
    o = rec.order(enc, t, C.ORD_FBC)
    hb = p.hb(day) + rnd.gauss(0, 0.35)
    rec.obs(enc, t + 100, loc, C.HB, num=round(hb, 1), order=o)
    if rnd.random() < 0.6:
        rec.obs(enc, t + 100, loc, C.MCV, num=round(rnd.gauss(88 if not p.anaemic(hb) else 76, 5)), order=o)
        rec.obs(enc, t + 100, loc, C.WBC, num=round(rnd.gauss(6.5, 1.5), 1), order=o)
        rec.obs(enc, t + 100, loc, C.PLT, num=round(rnd.gauss(270, 60)), order=o)
    return hb


def benign_endoscopy(p: Patient, ctx: Ctx, rec: Recorder, day: int, indication: int, rnd: random.Random, pud: bool):
    dcode = p.district_at(day)
    site, _ = ctx.endoscopy_site(dcode, day)
    t = clinic_time(day, rnd)
    enc = rec.encounter(t, "ENDOSCOPY", site)
    if enc is None:
        return
    g = rec.obs(enc, t, site, C.ENDO_SET)
    rec.coded(enc, t, site, C.ENDO_INDICATION, indication, group=g)
    atrophy = p.atrophy_day <= day
    if pud:
        imp = 7112
    elif atrophy:
        imp = 7114
    else:
        imp = 7111 if rnd.random() < 0.6 else 7110
    rec.coded(enc, t, site, C.ENDO_IMPRESSION, imp, group=g)
    infected = p.hp and (p.hp_erad_day is None or day < p.hp_erad_day)
    rec.coded(enc, t, site, C.RUT, C.POS if (infected and rnd.random() < 0.9) else C.NEG, group=g)
    biopsy = rnd.random() < (0.8 if atrophy else 0.35)
    rec.coded(enc, t, site, C.BIOPSY, C.YES if biopsy else C.NO, group=g)
    if pud:
        rec.dx(enc, t + 30, site, 2012 if rnd.random() < 0.5 else 2013)
    if biopsy:
        pt = t + rnd.randint(7, 28) * MIN_PER_DAY
        penc = rec.encounter(pt, "PATHOLOGY", site)
        pg = rec.obs(penc, pt, site, C.PATH_SET)
        hist = 7132 if atrophy and rnd.random() < 0.7 else (7136 if pud else 7131)
        rec.coded(penc, pt, site, C.HISTOLOGY, hist, group=pg)
        rec.coded(penc, pt, site, C.HP_HISTO, C.POS if infected else C.NEG, group=pg)
        if hist == 7132:
            rec.dx(penc, pt + 10, site, 2020)
        elif atrophy:
            rec.dx(penc, pt + 10, site, 2011)


def gi_episode_rate(p: Patient, cfg: dict) -> float:
    base = float(cfg["gi"].get("recorded_episode_rate", 0.011))
    rr = (1.6 if p.hp else 1.0) * (1.8 if p.nsaid else 1.0) * (1.3 if p.atrophy_day < 10**6 else 1.0)
    return base * rr / 1.45


def simulate_gi(p: Patient, ctx: Ctx, rec: Recorder, w0: int, w1: int, rnd: random.Random):
    """Benign GI episodes for adults (≥ 18)."""
    start = max(w0, p.birth + int(18 * 365.25))
    if start >= w1:
        return
    rate = gi_episode_rate(p, ctx.cfg)
    day = start
    while True:
        day += int(rnd.expovariate(rate) * 365.25)
        if day >= w1:
            break
        _episode(p, ctx, rec, day, w1, rnd)
        day += 60


def _episode(p: Patient, ctx: Ctx, rec: Recorder, day0: int, w1: int, rnd: random.Random):
    n_vis = weighted(rnd, [(1, 0.55), (2, 0.30), (3, 0.15)])
    infected = p.hp and (p.hp_erad_day is None or day0 < p.hp_erad_day)
    pud = rnd.random() < (0.16 if infected else 0.06) * (1.8 if p.nsaid else 1.0)
    dx = weighted(rnd, [(2014, 0.42), (2010, 0.30 * (1.4 if infected else 1.0)), (2015, 0.14)])
    bleed = pud and rnd.random() < 0.05
    complaint = 2211 if dx == 2015 else weighted(rnd, GI_COMPLAINTS)
    hp_res = None
    day = day0
    for k in range(n_vis):
        if day >= w1:
            break
        loc = pick_facility(p, ctx, day, rnd, p_dh=0.28 + 0.2 * k)
        t = clinic_time(day, rnd)
        enc = rec.encounter(t, "OPD" if k == 0 else "RETURN", loc)
        if enc is not None:
            rec.complaint(enc, t, loc, complaint, weeks=rnd.randint(1, 8))
            if bleed and k == n_vis - 1:
                rec.complaint(enc, t, loc, 2202)
            vitals(p, rec, enc, t, loc, rnd, pulse_add=15 if bleed else 0)
            record_lifestyle(p, rec, ctx, enc, t, loc, rnd, boost=0.6)
            if hp_res is None:
                hp_res = hp_test(p, ctx, rec, enc, t, loc, rnd)
            fbc(p, ctx, rec, enc, t, loc, rnd, boost=0.5 if not bleed else 2.0)
            d_code = 2012 if (pud and k > 0 and rnd.random() < 0.5) else dx
            rec.dx(enc, t + 60, loc, d_code, confirmed=False)
            if bleed and k == n_vis - 1:
                rec.dx(enc, t + 61, loc, 2016)
                rec.dx(enc, t + 62, loc, 2017 if rnd.random() < 0.5 else 2018, primary=False)
            treat_dyspepsia(p, ctx, rec, enc, t, loc, rnd, hp_res)
            age = p.age(day)
            alarm = bleed or (k == 2)
            if age >= 45 and alarm and rnd.random() < TIER_REFER[ctx.tier(loc)]:
                rec.order(enc, t + 150, C.ORD_ENDOSCOPY, urgency="STAT" if bleed else "ROUTINE")
                rec.order(enc, t + 151, C.ORD_REF_HOSP, ORDER_REFERRAL)
                benign_endoscopy(p, ctx, rec, day + rnd.randint(10, 60), 7102 if bleed else 7101, rnd, pud)
            elif age >= 40 and rnd.random() < 0.02:
                rec.order(enc, t + 150, C.ORD_ENDOSCOPY)
                benign_endoscopy(p, ctx, rec, day + rnd.randint(20, 90), 7100, rnd, pud)
        day += rnd.randint(14, 60)
