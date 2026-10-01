"""Background disease modules (SPEC §8.5): acute OPD visits, chronic follow-up, ANC, other cancers, deaths.

These give the EMR realistic volume and confounders; they do not affect gastric cancer risk (HIV = negative control).
"""
from __future__ import annotations

import math
import random

from shared.concepts import C

from ..context import MALARIA_PROV, MIN_PER_DAY, Ctx
from ..dates import month_of
from ..emit import ORDER_REFERRAL, VISIT_TYPE_IPD, Recorder
from ..patient import Patient
from .base import adult_initial, clinic_time, pick_facility, vitals

# acute reasons: (key, weight_child, weight_adult)
REASONS = [
    ("urti", 0.30, 0.22), ("malaria", 0.0, 0.0), ("diarrhoea", 0.18, 0.07), ("helminth", 0.08, 0.035),
    ("pneumonia", 0.06, 0.03), ("injury", 0.05, 0.08), ("uti", 0.01, 0.08), ("headache", 0.01, 0.07),
    ("abdo_pain", 0.02, 0.03), ("fatigue", 0.0, 0.03), ("asthma", 0.01, 0.015), ("fever_other", 0.08, 0.05),
    ("malnutrition", 0.02, 0.0), ("general", 0.10, 0.12),
]


def visit_rate(age: float) -> float:
    # Tuned to SPEC §6.5 volumes (~6 visits per patient over the window); see docs/decisions.md D-05
    if age < 5:
        return 1.35
    if age < 15:
        return 0.5
    if age < 60:
        return 0.55
    return 1.0


def _malaria_weight(p: Patient, day: int) -> float:
    m = month_of(day)
    season = 1.7 if m in (3, 4, 5, 10, 11, 12) else 0.65
    return 0.16 * MALARIA_PROV[p.province_at(day)] * season


def acute_visit(p: Patient, ctx: Ctx, rec: Recorder, day: int, rnd: random.Random):
    loc = pick_facility(p, ctx, day, rnd)
    t = clinic_time(day, rnd)
    visit = rec.visit(t, loc)
    if visit is None:
        return
    age = p.age(day)
    if age >= 15:
        adult_initial(p, rec, ctx, t, loc, visit, rnd)
    enc = rec.encounter(t, "OPD", loc, visit_id=visit)
    child = age < 15
    weights = [(k, (wc if child else wa)) for k, wc, wa in REASONS]
    weights[1] = ("malaria", _malaria_weight(p, day) * (1.3 if child else 1.0))
    tot = sum(w for _, w in weights)
    u = rnd.random() * tot
    for reason, w in weights:
        u -= w
        if u <= 0:
            break
    temp = None
    pulse_add = 0.0
    if reason in ("malaria", "fever_other", "pneumonia"):
        temp = rnd.gauss(38.6, 0.5)
        pulse_add = 12
    vitals(p, rec, enc, t, loc, rnd, temp=temp, pulse_add=pulse_add)
    if reason == "urti":
        rec.complaint(enc, t, loc, 2209, weeks=1)
        rec.dx(enc, t, loc, C.URTI, confirmed=False)
        rec.drug(enc, t, C.PARACETAMOL, 3, freq="TDS")
    elif reason == "malaria":
        rec.complaint(enc, t, loc, 2208, weeks=0)
        if rnd.random() < 0.85:
            rec.coded(enc, t + 20, loc, C.MAL_RDT, C.POS if rnd.random() < 0.95 else C.NEG)
            rec.dx(enc, t + 25, loc, C.MALARIA, confirmed=True)
        else:
            rec.dx(enc, t + 25, loc, C.MALARIA, confirmed=False)
        rec.drug(enc, t + 30, C.ACT, 3, freq="BD")
        rec.drug(enc, t + 30, C.PARACETAMOL, 3, freq="TDS")
    elif reason == "fever_other":
        rec.complaint(enc, t, loc, 2208, weeks=0)
        if rnd.random() < 0.7:
            rec.coded(enc, t + 20, loc, C.MAL_RDT, C.NEG)
        rec.drug(enc, t + 30, C.PARACETAMOL, 3, freq="TDS")
    elif reason == "diarrhoea":
        rec.dx(enc, t, loc, C.DIARRHOEA, confirmed=False)
    elif reason == "helminth":
        if rnd.random() < 0.3:
            rec.coded(enc, t + 30, loc, C.STOOL_OP, C.POS)
        rec.dx(enc, t + 35, loc, C.HELMINTH, confirmed=False)
        rec.drug(enc, t + 40, C.ALBENDAZOLE, 1)
    elif reason == "pneumonia":
        rec.complaint(enc, t, loc, 2209, weeks=1)
        rec.dx(enc, t, loc, C.PNEUMONIA, confirmed=False)
        rec.drug(enc, t, C.AMOX, 5, freq="TDS")
    elif reason == "injury":
        rec.dx(enc, t, loc, C.INJURY)
        rec.drug(enc, t, C.IBUPROFEN, 5, freq="TDS")
    elif reason == "uti":
        rec.dx(enc, t, loc, C.UTI, confirmed=False)
        rec.drug(enc, t, C.AMOX, 5, freq="TDS")
    elif reason == "headache":
        rec.complaint(enc, t, loc, 2210)
        rec.drug(enc, t, C.PARACETAMOL, 3, freq="TDS")
    elif reason == "abdo_pain":
        rec.complaint(enc, t, loc, 2201, weeks=rnd.randint(0, 2))
        rec.drug(enc, t, C.PARACETAMOL, 3, freq="TDS")
    elif reason == "fatigue":
        rec.complaint(enc, t, loc, 2207, weeks=rnd.randint(1, 6))
        if rnd.random() < 0.35:
            o = rec.order(enc, t, C.ORD_FBC)
            rec.obs(enc, t + 90, loc, C.HB, num=round(p.hb(day) + rnd.gauss(0, 0.5), 1), order=o)
    elif reason == "asthma":
        rec.dx(enc, t, loc, C.ASTHMA)
    elif reason == "malnutrition":
        rec.dx(enc, t, loc, C.MALNUT)
    rec.coded(enc, t + 45, loc, C.VISIT_OUTCOME, C.OUT_HOME)


def chronic_ncd(p: Patient, ctx: Ctx, rec: Recorder, w0: int, w1: int, rnd: random.Random):
    starts = [x for x in ((p.htn_dx if p.htn else None), (p.dm_dx if p.dm else None)) if x is not None and x < w1]
    if not starts:
        return
    day = max(min(starts), w0)
    first = True
    while day < w1:
        loc = p.home_at(day) if rnd.random() < 0.7 else ctx.dh(p.district_at(day))
        t = clinic_time(day, rnd)
        enc = rec.encounter(t, "NCD", loc)
        if enc is not None:
            if first:
                rec.program(2, t, loc)
            htn_now = p.htn and p.htn_dx <= day
            dm_now = p.dm and p.dm_dx <= day
            vitals(p, rec, enc, t, loc, rnd, bp=True, sbp_add=28 if htn_now else 0)
            if htn_now:
                if first or rnd.random() < 0.3:
                    rec.dx(enc, t, loc, C.HTN)
                rec.drug(enc, t, C.AMLODIPINE, 60)
            if dm_now:
                rec.num(enc, t + 20, loc, C.RBG, rnd.gauss(185, 40), 0)
                if first or rnd.random() < 0.35:
                    rec.num(enc, t + 25, loc, C.HBA1C, rnd.gauss(8.1, 1.1))
                if first or rnd.random() < 0.3:
                    rec.dx(enc, t, loc, C.DM)
                rec.drug(enc, t, C.METFORMIN, 60, freq="BD")
            first = False
        day += int(rnd.uniform(45, 120))


def hiv_care(p: Patient, ctx: Ctx, rec: Recorder, w0: int, w1: int, rnd: random.Random):
    if not p.hiv or p.hiv_dx >= w1:
        return
    day = max(p.hiv_dx, w0)
    first = p.hiv_dx >= w0
    last_cd4 = -10**6
    k = 0
    while day < w1:
        loc = p.home_at(day)
        t = clinic_time(day, rnd)
        enc = rec.encounter(t, "HIV", loc)
        if enc is not None:
            if first:
                rec.coded(enc, t, loc, C.HIV_TEST, C.POS)
                rec.dx(enc, t + 10, loc, C.HIV)
                rec.program(1, t, loc)
                first = False
            vitals(p, rec, enc, t, loc, rnd)
            if day - last_cd4 > 330:
                rec.num(enc, t + 30, loc, C.CD4, max(20, rnd.gauss(520 + 25 * k, 180)), 0)
                if k > 1:
                    rec.num(enc, t + 30, loc, C.VL, max(0, rnd.lognormvariate(3.0, 2.2)) if rnd.random() < 0.25 else 0, 0)
                last_cd4 = day
            rec.drug(enc, t, C.ART, 90)
        k += 1
        day += int(rnd.uniform(85, 130))


def anc(p: Patient, ctx: Ctx, rec: Recorder, w0: int, w1: int, rnd: random.Random):
    if p.male:
        return
    y0 = max(w0, p.birth + int(15 * 365.25))
    y1 = min(w1, p.birth + int(45 * 365.25))
    day = y0
    while day < y1:
        if rnd.random() < 0.12:
            start = day + rnd.randint(0, 300)
            for j, wk in enumerate((12, 20, 28, 36)):
                vd = start + wk * 7
                if vd >= w1:
                    break
                loc = p.home_at(vd)
                t = clinic_time(vd, rnd)
                enc = rec.encounter(t, "ANC", loc)
                if enc is None:
                    continue
                vitals(p, rec, enc, t, loc, rnd, bp=True)
                if j == 0:
                    rec.dx(enc, t, loc, C.PREG)
                    rec.num(enc, t + 40, loc, C.HB, p.hb(vd) - 0.6 + rnd.gauss(0, 0.6))
            day = start + 365 + 180
        else:
            day += 365


def misc_chronic(p: Patient, ctx: Ctx, rec: Recorder, w0: int, w1: int, rnd: random.Random):
    """Occasional CKD / HF / HBV / TB / IDA diagnoses and other cancers."""
    yrs = (w1 - w0) / 365.25
    if yrs <= 0:
        return
    age_mid = p.age((w0 + w1) // 2)
    events = []
    if age_mid > 50 and rnd.random() < 0.003 * yrs:
        events.append("ckd")
    if age_mid > 55 and rnd.random() < 0.002 * yrs:
        events.append("hf")
    if age_mid > 18 and rnd.random() < 0.0025 * yrs:
        events.append("hbv")
    if age_mid > 15 and rnd.random() < 0.0006 * yrs:
        events.append("tb")
    if not p.male and 40 <= age_mid <= 56 and rnd.random() < 0.004 * yrs:
        events.append("ida")
    # other cancers (per 100k per year, adults > 35)
    if age_mid > 35:
        rates = {C.OES_CA: 5, 2119: 8, 2120: 6}
        if p.male:
            rates[2121] = 22
        else:
            rates[2116] = 26
            rates[2117] = 30
        for code, r in rates.items():
            if rnd.random() < r / 1e5 * yrs * (1 + max(0, age_mid - 50) / 20):
                events.append(code)
    for ev in events:
        day = rnd.randint(w0, max(w0, w1 - 1))
        loc = pick_facility(p, ctx, day, rnd, p_dh=0.4)
        t = clinic_time(day, rnd)
        if isinstance(ev, int):
            loc = ctx.oncology_site(p.district_at(day))
            enc = rec.encounter(t, "ONCOLOGY", loc)
            rec.dx(enc, t, loc, ev)
            rec.program(3, t, loc)
            if rnd.random() < 0.55:
                dd = day + int(rnd.expovariate(1 / 420))
                if dd < p.death:
                    p.death = dd
                    p.died_of = ev
            continue
        enc = rec.encounter(t, "OPD", loc)
        vitals(p, rec, enc, t, loc, rnd)
        if ev == "ckd":
            rec.num(enc, t + 60, loc, C.CREAT, rnd.gauss(2.6, 0.6), 2)
            rec.dx(enc, t + 70, loc, C.CKD)
        elif ev == "hf":
            rec.dx(enc, t, loc, C.HF)
        elif ev == "hbv":
            rec.num(enc, t + 60, loc, C.ALT, rnd.gauss(70, 20), 0)
            rec.dx(enc, t + 70, loc, C.HBV)
        elif ev == "tb":
            rec.complaint(enc, t, loc, 2209, weeks=rnd.randint(3, 8))
            rec.dx(enc, t, loc, C.TB)
            rec.order(enc, t, C.ORD_REF_HOSP, ORDER_REFERRAL)
        elif ev == "ida":
            rec.complaint(enc, t, loc, 2207, weeks=rnd.randint(2, 10))
            o = rec.order(enc, t, C.ORD_FBC)
            hb = p.hb(day) - rnd.uniform(2.0, 3.5)
            rec.obs(enc, t + 90, loc, C.HB, num=round(hb, 1), order=o)
            rec.num(enc, t + 90, loc, C.MCV, rnd.gauss(71, 4), 0)
            rec.dx(enc, t + 100, loc, C.IDA)
            rec.drug(enc, t + 100, C.IRON, 60, freq="BD")


CAUSES = [C.PNEUMONIA, C.HF, C.MALARIA, C.INJURY, C.TB, C.CKD, C.DIARRHOEA, C.MALNUT]


def record_death(p: Patient, ctx: Ctx, rec: Recorder, rnd: random.Random, cause: int | None = None, p_record: float = 0.8):
    if p.death >= 10**6 or p.death_recorded or rnd.random() > p_record:
        return
    loc = ctx.dh(p.district_at(p.death)) if rnd.random() < 0.5 else p.home_at(p.death)
    t = p.death * MIN_PER_DAY + rnd.randint(0, 1439)
    enc = rec.encounter(t, "DEATH", loc, vtype=VISIT_TYPE_IPD)
    if enc is None:
        return
    if cause is None:
        cause = p.died_of if p.died_of else rnd.choice(CAUSES)
    rec.coded(enc, t, loc, C.CAUSE_OF_DEATH, cause)
    rec.coded(enc, t, loc, C.VISIT_OUTCOME, C.OUT_DIED)
    p.death_recorded = True
    p.death_enc = True


def simulate_background(p: Patient, ctx: Ctx, rec: Recorder, w0: int, w1: int, rnd: random.Random):
    """Acute visits (Poisson by age, per calendar year) + chronic programmes.

    misc_chronic runs first because another cancer can bring the death date forward."""
    misc_chronic(p, ctx, rec, w0, w1, rnd)
    w1 = min(w1, p.death)
    day = w0
    while day < w1:
        seg_end = min(w1, day + 365)
        rate = visit_rate(p.age(day))
        n = _poisson(rate * (seg_end - day) / 365.25, rnd)
        for _ in range(n):
            acute_visit(p, ctx, rec, rnd.randint(day, seg_end - 1), rnd)
        day = seg_end
    chronic_ncd(p, ctx, rec, w0, w1, rnd)
    hiv_care(p, ctx, rec, w0, w1, rnd)
    anc(p, ctx, rec, w0, w1, rnd)


def _poisson(lam: float, rnd: random.Random) -> int:
    if lam <= 0:
        return 0
    if lam > 30:
        return max(0, int(round(rnd.gauss(lam, math.sqrt(lam)))))
    L = math.exp(-lam)
    k, prod = 0, rnd.random()
    while prod > L:
        k += 1
        prod *= rnd.random()
    return k
