"""Shared clinical emitters: vitals, adult intake, time helpers."""
from __future__ import annotations

import random

from shared.concepts import C

from ..context import MIN_PER_DAY, TIER_REC_FAMHX, TIER_REC_SMOKING, Ctx
from ..emit import Recorder
from ..patient import Patient


def clinic_time(day: int, rnd: random.Random) -> int:
    """Epoch minutes during clinic hours (07:30–17:00)."""
    return day * MIN_PER_DAY + 450 + int(rnd.random() * 570)


def vitals(p: Patient, rec: Recorder, enc, t: int, loc: int, rnd: random.Random, *, pulse_add: float = 0.0,
           temp: float | None = None, bp: bool | None = None, full: bool = False, sbp_add: float = 0.0):
    if enc is None:
        return
    day = t // MIN_PER_DAY
    age = p.age(day)
    if full or rnd.random() < 0.85:
        w = p.weight(day) + rnd.gauss(0, 0.35)
        rec.num(enc, t, loc, C.WEIGHT, w)
        if full or rnd.random() < 0.18:
            h = p.height_at(day) + rnd.gauss(0, 0.8)
            rec.num(enc, t, loc, C.HEIGHT, h, 0)
            if age >= 18:
                rec.num(enc, t, loc, C.BMI, w / (h / 100) ** 2)
    if temp is not None or rnd.random() < 0.9:
        rec.num(enc, t, loc, C.TEMP, temp if temp is not None else rnd.gauss(36.7, 0.3))
    if full or rnd.random() < 0.65:
        base = 76 + 3.5 * max(0.0, 12 - age)
        rec.num(enc, t, loc, C.PULSE, rnd.gauss(base, 8) + pulse_add, 0)
    if age >= 15 and (bp if bp is not None else (full or rnd.random() < 0.55)):
        sbp = rnd.gauss(118 + 0.45 * max(age - 30, 0), 11) + sbp_add
        rec.num(enc, t, loc, C.SBP, sbp, 0)
        rec.num(enc, t, loc, C.DBP, sbp * 0.63 + rnd.gauss(0, 5), 0)
    if full or rnd.random() < 0.3:
        rr = rnd.gauss(30 if age < 5 else (22 if age < 12 else 16), 2)
        rec.num(enc, t, loc, C.RR, rr, 0)
    if age < 5 and rnd.random() < 0.25:
        rec.num(enc, t, loc, C.MUAC, rnd.gauss(14.5, 0.9))


def record_lifestyle(p: Patient, rec: Recorder, ctx: Ctx, enc, t: int, loc: int, rnd: random.Random, boost: float = 1.0):
    """Lifestyle / history obs. Recording probability depends on facility tier (SPEC §8.6)."""
    if enc is None:
        return
    tier = ctx.tier(loc)
    if rnd.random() < TIER_REC_SMOKING[tier] * boost and "tobacco" not in p.lifestyle_recorded:
        rec.coded(enc, t, loc, C.TOBACCO, p.tobacco)
        p.lifestyle_recorded["tobacco"] = t
        if p.tobacco == C.CURRENT:
            rec.num(enc, t, loc, C.CIGS, max(1, round(rnd.gauss(8, 4))), 0)
    if rnd.random() < 0.30 * boost and "alcohol" not in p.lifestyle_recorded:
        rec.coded(enc, t, loc, C.ALCOHOL, p.alcohol)
        p.lifestyle_recorded["alcohol"] = t
        if p.alcohol == C.CURRENT:
            rec.coded(enc, t, loc, C.ALCOHOL_TYPE, rnd.choice([7040, 7040, 7041, 7042, 7043]))
    if rnd.random() < TIER_REC_FAMHX[tier] * boost and "family_hx" not in p.lifestyle_recorded:
        ans = C.YES if p.family_hx else (C.NO if rnd.random() < 0.8 else C.UNKNOWN)
        rec.coded(enc, t, loc, C.FAMILY_HX, ans)
        p.lifestyle_recorded["family_hx"] = t
    if rnd.random() < 0.12 * boost and "salt" not in p.lifestyle_recorded:
        rec.coded(enc, t, loc, C.HIGH_SALT, C.YES if p.salt else C.NO)
        p.lifestyle_recorded["salt"] = t
    if rnd.random() < 0.10 * boost and "smoked" not in p.lifestyle_recorded:
        rec.coded(enc, t, loc, C.SMOKED_FOOD, C.YES if p.smoked else C.NO)
        p.lifestyle_recorded["smoked"] = t
    if rnd.random() < 0.10 * boost:
        rec.num(enc, t, loc, C.FRUIT_VEG, p.fruit_veg, 0)
    if rnd.random() < 0.20 * boost:
        rec.coded(enc, t, loc, C.FUEL, p.fuel)
    if rnd.random() < 0.25 * boost:
        rec.coded(enc, t, loc, C.WATER, p.water)
    if rnd.random() < 0.40 * boost:
        rec.coded(enc, t, loc, C.OCCUPATION, p.occupation)
    if rnd.random() < 0.10 * boost and "nsaid" not in p.lifestyle_recorded:
        rec.coded(enc, t, loc, C.NSAID, C.YES if p.nsaid else C.NO)
        p.lifestyle_recorded["nsaid"] = t


def adult_initial(p: Patient, rec: Recorder, ctx: Ctx, t: int, loc: int, visit, rnd: random.Random):
    if p.initial_done or visit is None:
        return
    enc = rec.encounter(t - 5, "ADULTINITIAL", loc, visit_id=visit)
    if enc is None:
        return
    p.initial_done = True
    record_lifestyle(p, rec, ctx, enc, t - 5, loc, rnd)


def pick_facility(p: Patient, ctx: Ctx, day: int, rnd: random.Random, p_dh: float = 0.15) -> int:
    u = rnd.random()
    dcode = p.district_at(day)
    if u < p_dh:
        return rnd.choice(ctx.dh_by_district[dcode])
    if u < p_dh + 0.04:
        return rnd.choice(ctx.hc_by_district[dcode])
    return p.home_at(day)
