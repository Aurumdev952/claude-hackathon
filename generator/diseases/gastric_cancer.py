"""Gastric cancer natural history (SPEC §8.8) and planted-insight mechanisms INS-1/2/3/4/5/6.

Step 1 hazard (vectorised, per person-year) -> onset
Step 2 preclinical sojourn -> symptom start
Step 3 prodrome (visits ramp, Hb decline, weight loss, repeated PPI, late alarm features)
Step 4 diagnostic pathway (referral by facility tier, endoscopy access, INS-6 misattribution)
Step 5 stage at diagnosis from time since symptom start
Step 6 survival (Weibull by stage, treatment effect), death recording
"""
from __future__ import annotations

import math
import random

import numpy as np

from shared.concepts import C
from shared.geo import AGE_GROUPS, DISTRICT_CODES, WHO_STD

from ..context import MIN_PER_DAY, SIM_END, TIER_REFER, Ctx
from ..dates import d, year_start
from ..emit import ORDER_REFERRAL, Recorder
from ..patient import Patient
from .base import clinic_time, pick_facility, vitals
from .gi import fbc, hp_test, treat_dyspepsia, weighted

YEARS = list(range(2010, 2028))
STAGES = ["I", "II", "III", "IV"]
STAGE_CODE = {"I": 7190, "II": 7191, "III": 7192, "IV": 7193}
LOC_CODE = {"cardia": 7120, "body": 7121, "antrum": 7122, "diffuse": 7123}
LOC_DX = {"cardia": 2001, "body": 2002, "antrum": 2003, "diffuse": 2000}
LAUREN_CODE = {"intestinal": 7140, "diffuse": 7141, "mixed": 7142}
SURV_MEDIAN_M = {"I": 60, "II": 16, "III": 8, "IV": 4.0}   # D-06: tuned so 1-y survival hits §8.8/INS-4 targets
SURV_SHAPE = 1.5
# INS-4 facility practice: patients who first present at low-testing-tier facilities reach curative care less often
TIER_CURATIVE = {"low": 0.4, "medium": 0.8, "high": 0.9}
TIER_BSC_IV = {"low": 0.65, "medium": 0.4, "high": 0.25}
TIER_MULT = {"low": 0.45, "medium": 1.0, "high": 3.4}
# D-23: cancer work-up is referred less readily than the general dyspepsia rate (stage I-II 15-25%, interval 7-10 m,
# alarm features without endoscopy 55-65%), and least at low-testing-tier facilities (INS-4 stage IV 58-66% vs 34-42%)
CANCER_REFER_MULT = {"low": 1.0, "medium": 1.3, "high": 1.4}


# ----------------------------------------------------------------------------------- hazard
def h0_per_100k(age: np.ndarray, anchors: dict) -> np.ndarray:
    xs = np.array(sorted(anchors), dtype=float)
    ys = np.log(np.array([anchors[k] for k in sorted(anchors)], dtype=float))
    a = np.asarray(age, dtype=float)
    lo_slope = (ys[1] - ys[0]) / (xs[1] - xs[0])
    hi_slope = (ys[-1] - ys[-2]) / (xs[-1] - xs[-2]) * 0.6
    out = np.interp(a, xs, ys)
    out = np.where(a < xs[0], ys[0] + lo_slope * (a - xs[0]), out)
    out = np.where(a > xs[-1], ys[-1] + hi_slope * (a - xs[-1]), out)
    h = np.exp(out)
    return np.where(a < 18, 0.0, h)


def hazard_matrix(P: dict, idx: np.ndarray, cfg: dict, h_mult: float) -> tuple[np.ndarray, np.ndarray]:
    """Per-year onset hazard H[n, Y] for people idx, and their H. pylori RR (for eradication adjustment)."""
    gc = cfg["gastric_cancer"]
    rr = gc["rr"]
    ins = cfg["insights"]
    ins2 = ins["ins2"]
    lag = float(gc.get("trend_lag_years", 2.0))
    birth = P["birth"][idx].astype(float)
    male = P["sex"][idx] == 1
    hp = P["hp"][idx]
    base_rr = np.ones(len(idx))
    tob = P["tobacco"][idx]
    base_rr *= np.where(tob == C.CURRENT, rr["smoker_current"], np.where(tob == C.FORMER, rr["smoker_former"], 1.0))
    base_rr *= np.where(P["alcohol_heavy"][idx], rr["alcohol_heavy"], 1.0)
    base_rr *= np.where(P["salt"][idx], rr["high_salt"], 1.0)
    base_rr *= np.where(P["smoked"][idx], rr["smoked_food"], 1.0)
    base_rr *= np.where(P["family_hx"][idx], rr["family_hx"], 1.0)
    base_rr *= np.where(P["hiv"][idx], rr["hiv"], 1.0)
    if ins["ins1"]["enabled"]:
        dist_rr = np.where(P["hot"][idx], ins["ins1"]["residual_rr"],
                           np.where(P["near_hot"][idx], ins["ins1"].get("spillover_rr", 1.0), 1.0))
        # micro-cluster: SPEC RR 2.5 vs the district residual 1.4, i.e. x1.79 on top of the district (D-24)
        dist_rr = np.where(P["micro"][idx], dist_rr * ins["ins1"]["micro_cluster"]["rr"] / 1.4, dist_rr)
        base_rr *= dist_rr
    H = np.zeros((len(idx), len(YEARS)))
    rrhp_young = gc.get("rr_hp_young", 1.85)
    rrsex_young = gc.get("rr_male_young", 1.08)
    rrhp_all = np.zeros((len(idx), len(YEARS)))
    for j, y in enumerate(YEARS):
        mid = year_start(y) + 182
        age = (mid - birth) / 365.25
        young = age < ins2.get("age_lt", 50)
        h = h0_per_100k(age, gc["h0_anchor_per_100k"]) / 1e5
        rr_sex = np.where(male, np.where(young, rrsex_young, rr["male"]), 1.0)
        rr_hp = np.where(hp, np.where(young, rrhp_young, rr["hp"]), 1.0)
        rr_at = np.where(P["atrophy_day"][idx] <= mid, rr["atrophy_im"], 1.0)
        trend = np.ones(len(idx))
        if ins2["enabled"]:
            yeff = y + lag
            k_young = max(0.0, yeff - (ins2["start_year"] - 1))
            trend = np.where(young, ins2["annual_multiplier"] ** k_young, ins2["older_annual_multiplier"] ** (yeff - 2015))
        H[:, j] = h * rr_sex * rr_hp * rr_at * trend * base_rr * h_mult
        rrhp_all[:, j] = rr_hp
    return H, rrhp_all


def calibrate_h_mult(P: dict, cfg: dict) -> float:
    """Scale baseline hazard so the expected onset ASR (world std) matches the configured 2024 target."""
    cal = cfg["gastric_cancer"].get("calibration", {})
    target = float(cal.get("target_asr_2024", cfg["gastric_cancer"]["targets"]["national_asr_2024"]))
    diag_fraction = float(cal.get("diag_fraction", 0.85))
    ref_year = int(cal.get("onset_reference_year", 2022))
    j = YEARS.index(ref_year)
    mid = year_start(ref_year) + 182
    alive = (P["birth"] <= mid) & (P["death"] > mid)
    idx = np.where(alive)[0]
    H, _ = hazard_matrix(P, idx, cfg, 1.0)
    age = (mid - P["birth"][idx]) / 365.25 + 2  # diagnosed ~2 years later, at an older age
    gi = np.clip(age // 5, 0, 17).astype(int)
    w = np.array(WHO_STD, float) / sum(WHO_STD)
    asr = 0.0
    for g in range(18):
        m = gi == g
        if m.sum() > 0:
            asr += w[g] * H[m, j].mean()
    asr *= 1e5
    return float(target / diag_fraction / asr) if asr > 0 else 1.0


def sample_onset(H_row: np.ndarray, rnd: random.Random, erad_day: int | None = None, rrhp_row=None,
                 floor: float = 1.6) -> int | None:
    target = -math.log(max(rnd.random(), 1e-300))
    cum = 0.0
    for j, y in enumerate(YEARS):
        h = float(H_row[j])
        if erad_day is not None and rrhp_row is not None and rrhp_row[j] > 1.0:
            ys = (year_start(y) + 182 - erad_day) / 365.25
            if ys > 0:
                rr0 = float(rrhp_row[j])
                rr_new = floor + (rr0 - floor) * max(0.0, 1 - ys / 5) if rr0 > floor else rr0
                h *= rr_new / rr0
        if cum + h >= target:
            frac = (target - cum) / h if h > 0 else 0.5
            return year_start(y) + int(frac * 365)
        cum += h
    return None


# ----------------------------------------------------------------------------------- trajectory
class CaseState:
    __slots__ = ("onset", "symptom_start", "young", "lauren", "location", "durs", "clinical_only", "ramp", "ppi_repeat",
                 "alarm_late", "dx_day", "status", "stage", "t", "n", "m", "first_gi_loc", "first_gi_day", "n_visits",
                 "misattrib", "death_ca", "treatment", "undiagnosed", "dx_loc", "dx_code", "hb_drop", "wt_loss",
                 "referrals", "refused", "district_dx", "first_rec_gi_day", "route", "first_mis_day", "mis_prone")

    def stage_at(self, day: int) -> str:
        m = (day - self.symptom_start) / 30.44
        c = 0.0
        for s, dur in zip(STAGES[:3], self.durs):
            c += dur
            if m < c:
                return s
        return "IV"

    def stage_start(self, stage: str) -> int:
        k = STAGES.index(stage)
        return self.symptom_start + int(sum(self.durs[:k]) * 30.44)


def _tnm(stage: str, rnd: random.Random) -> tuple[int, int, int]:
    if stage == "I":
        return rnd.choice([7160, 7160, 7161]), 7170, 7180
    if stage == "II":
        return rnd.choice([7161, 7162, 7162]), rnd.choice([7170, 7171]), 7180
    if stage == "III":
        return rnd.choice([7162, 7163, 7163]), rnd.choice([7171, 7172, 7173]), 7180
    return rnd.choice([7162, 7163, 7164]), rnd.choice([7171, 7172, 7173]), 7181


def simulate_cancer(p: Patient, ctx: Ctx, rec: Recorder, onset: int, rnd: random.Random) -> dict:
    cfg = ctx.cfg
    gc = cfg["gastric_cancer"]
    ins = cfg["insights"]
    cs = CaseState()
    cs.onset = onset
    cs.young = p.age(onset) < 50
    cs.lauren = weighted(rnd, [("diffuse", 0.55), ("intestinal", 0.38), ("mixed", 0.07)] if cs.young else
                         [("diffuse", 0.22), ("intestinal", 0.71), ("mixed", 0.07)])
    loc_w = [("cardia", 0.20 * (1.5 if p.tobacco == C.CURRENT else 1.0)), ("body", 0.33), ("antrum", 0.40), ("diffuse", 0.07)]
    if cs.lauren == "diffuse":
        loc_w[3] = ("diffuse", 0.30)
    cs.location = weighted(rnd, loc_w)
    speed = 0.72 if (cs.young or cs.lauren == "diffuse") else 1.0
    sojourn_m = rnd.gammavariate(2.0, gc["sojourn_mean_months"] / 2.0) * (0.8 if cs.young else 1.0)
    cs.symptom_start = onset + int(sojourn_m * 30.44)
    sm = gc.get("stage_months", [5, 5, 6])
    cs.durs = [rnd.gammavariate(2.0, m / 2.0) * speed for m in sm]
    cs.clinical_only = rnd.random() < gc["pct_clinical_only"]
    cs.ramp = rnd.random() < 0.70
    cs.ppi_repeat = rnd.random() < 0.40
    cs.alarm_late = rnd.random() < 0.55
    cs.hb_drop = rnd.random() < 0.75
    cs.wt_loss = rnd.random() < 0.45
    cs.mis_prone = rnd.random() < ins["ins6"]["misattribution_prob"]
    cs.dx_day = None
    cs.status = "UNDIAGNOSED"
    cs.stage = None
    cs.first_gi_loc = None
    cs.first_gi_day = None
    cs.first_rec_gi_day = None
    cs.n_visits = 0
    cs.misattrib = 0
    cs.referrals = 0
    cs.refused = 0
    cs.death_ca = None
    cs.treatment = None
    cs.dx_loc = None
    cs.dx_code = None
    cs.district_dx = None
    cs.route = None
    cs.first_mis_day = None
    p.cancer = cs

    iv_start = cs.stage_start("IV")
    untreated_death = iv_start + int(rnd.expovariate(1 / gc.get("untreated_iv_survival_months", 5.0)) * 30.44)
    horizon = min(p.death, untreated_death, SIM_END)
    if cs.hb_drop:  # occult blood loss starts before symptoms (D-06)
        p.hb_decline = (cs.symptom_start - int(rnd.uniform(3, 9) * 30.44), rnd.uniform(0.18, 0.38))
    if cs.wt_loss:
        p.wt_loss = (max(cs.symptom_start, cs.stage_start("III") - 60), rnd.uniform(0.5, 1.5))

    ins5 = ins["ins5"]
    ins6 = ins["ins6"]
    suppress_until = -1
    anchor = 1.0
    hp_done = False
    day = cs.symptom_start + int(rnd.expovariate(1 / 1.5) * 30.44)
    while day < horizon and cs.n_visits < 150:
        stage = cs.stage_at(day)
        cs.n_visits += 1
        dcode = p.district_at(day)
        loc = pick_facility(p, ctx, day, rnd, p_dh=min(0.7, 0.25 + 0.08 * cs.refused + (0.2 if stage == "IV" else 0)))
        tier = ctx.tier(loc)
        if cs.first_gi_loc is None:
            cs.first_gi_loc, cs.first_gi_day = loc, day
        t = clinic_time(day, rnd)
        enc = rec.encounter(t, "OPD" if cs.n_visits == 1 else "RETURN", loc)
        if enc is not None and cs.first_rec_gi_day is None:
            cs.first_rec_gi_day = day
        age = p.age(day)
        alarm_on = cs.alarm_late and STAGES.index(stage) >= 2
        lost = p.weight(cs.symptom_start) - p.weight(day)
        alarms = []
        if alarm_on:
            if cs.location == "cardia" and rnd.random() < 0.7 or rnd.random() < 0.2:
                alarms.append(2203)
            if rnd.random() < 0.3:
                alarms.append(2213)
            if rnd.random() < 0.18:
                alarms.append(2017 if rnd.random() < 0.5 else 2018)
        if stage == "IV" and rnd.random() < 0.6:
            alarms.append(rnd.choice([2205, 2213, 2202, 2203]) if cs.location != "cardia" else 2203)
        if lost > 3 and rnd.random() < 0.6:
            alarms.append(2205)
        alarms = list(dict.fromkeys(alarms))
        main = weighted(rnd, [(2200, 0.5), (2201, 0.15), (2202, 0.12), (2204, 0.1), (2206, 0.08), (2212, 0.05)])
        hb_now = p.hb(day)
        tachy = 14 if hb_now < 9 else 0
        if enc is not None:
            rec.complaint(enc, t, loc, main, weeks=max(1, int((day - cs.symptom_start) / 7)))
            for a in alarms:
                if a < 2200:
                    rec.dx(enc, t + 5, loc, a, confirmed=False, primary=False)
                else:
                    rec.complaint(enc, t + 2, loc, a)
            if hb_now < 10.5 and rnd.random() < 0.5:
                rec.complaint(enc, t + 3, loc, 2207)
            vitals(p, rec, enc, t, loc, rnd, pulse_add=tachy, full=rnd.random() < 0.5)
        fbc_boost = 2.2 if (alarms or hb_now < 10.5) else 1.5
        if ins6["enabled"] and p.province_at(day) in ins6["provinces"]:
            fbc_boost *= 1.25  # malaria-endemic areas check Hb a little more often (and then misread it)
        hb_meas = fbc(p, ctx, rec, enc, t, loc, rnd, boost=fbc_boost)
        hp_res = None if hp_done else hp_test(p, ctx, rec, enc, t, loc, rnd)
        hp_done = hp_done or hp_res is not None
        anaemic_seen = hb_meas is not None and p.anaemic(hb_meas)
        if enc is not None:
            rec.dx(enc, t + 60, loc, weighted(rnd, [(2014, 0.5), (2010, 0.4), (2012, 0.1)]), confirmed=False)
            if anaemic_seen:
                rec.dx(enc, t + 61, loc, 2022 if rnd.random() < 0.4 else 2023, confirmed=False, primary=False)
        misattributed = False
        # INS-6: anaemia (measured, or visible pallor treated presumptively) attributed to malaria / worms
        pallor = p.anaemic(hb_now) and rnd.random() < 0.8
        hb_drop_seen = hb_meas is not None and (anaemic_seen or hb_meas < p.hb_base - 1.0)
        # decided once per case (D-28): re-rolling at every visit let the anaemic patients who escaped it be exactly the
        # fast-referred ones (survivor selection), which hid the delay at the median
        if (ins6["enabled"] and (hb_drop_seen or pallor) and p.province_at(day) in ins6["provinces"]
                and cs.mis_prone and cs.misattrib == 0):
            misattributed = True
            cs.misattrib += 1
            if cs.first_mis_day is None:
                cs.first_mis_day = day
            sd = ins6.get("suppress_days", [210, 330])
            suppress_until = day + rnd.randint(int(sd[0]), int(sd[1]))
            anchor = float(ins6.get("anchor_after", 0.25))  # clinician now attributes symptoms to malaria/worms: refers later
            if rnd.random() < 0.65:
                if rnd.random() < 0.5:
                    rec.coded(enc, t + 70, loc, C.MAL_RDT, C.POS if rnd.random() < 0.3 else C.NEG)
                rec.dx(enc, t + 80, loc, C.MALARIA, confirmed=False, primary=False)
                rec.drug(enc, t + 85, C.ACT, 3, freq="BD")
            else:
                rec.dx(enc, t + 80, loc, C.HELMINTH, confirmed=False, primary=False)
                rec.drug(enc, t + 85, C.ALBENDAZOLE, 1)
            rec.drug(enc, t + 86, C.IRON, 30, freq="BD")
        if not misattributed:
            treat_dyspepsia(p, ctx, rec, enc, t, loc, rnd, hp_res, ppi_bias=0.3 if cs.ppi_repeat else -0.25)
        # ---- referral decision
        if day < suppress_until or misattributed:
            p_ref = 0.0
        elif alarms and age >= 45:
            p_ref = TIER_REFER[tier] * 0.7 * (0.3 + 0.7 * anchor)
        elif alarms:
            p_ref = TIER_REFER[tier] * 0.45 * (0.3 + 0.7 * anchor)
        elif anaemic_seen and age >= 40:
            p_ref = TIER_REFER[tier] * 0.35
        elif age >= 55:  # new-onset dyspepsia at >= 55 -> endoscopy (guideline), tier-dependent uptake
            p_ref = min(0.45, TIER_REFER[tier] * 0.3 + 0.01 * cs.n_visits) * anchor
        else:
            p_ref = min(0.45, (0.052 + 0.018 * cs.n_visits) * TIER_MULT[tier]) * anchor
            if ctx.district_endoscopy(dcode, day):
                p_ref = min(0.6, p_ref * 1.5)  # on-site endoscopy lowers the bar for referring dyspepsia early (INS-5)
        p_ref *= CANCER_REFER_MULT[tier]
        if stage == "IV" and day >= suppress_until:  # a malaria/worm label also masks late disease for a while (INS-6)
            p_ref = min(0.95, p_ref + 0.15)
        if ctx.district_endoscopy(dcode, day):
            p_ref = min(0.95, p_ref * 1.25)
        # advanced disease seen at a hospital is worked up there (endoscopy if on site, else clinical diagnosis)
        if (stage == "IV" and day - iv_start > 30 and day >= suppress_until and ctx.by_id[loc]["facility_type"] != "HEALTH_CENTRE"
                and rnd.random() < 0.35 * (0.3 + 0.7 * anchor)):
            cs.route = "hospital_iv"
            _hospital_workup(p, ctx, rec, cs, day, rnd, alarms, anaemic_seen)
            break
        if rnd.random() < p_ref:
            cs.referrals += 1
            cs.route = "alarm_referral" if alarms else ("anaemia_referral" if anaemic_seen else "dyspepsia_referral")
            if enc is not None:
                rec.order(enc, t + 150, C.ORD_ENDOSCOPY, urgency="STAT" if alarms else "ROUTINE")
                rec.obs(enc, t + 151, loc, C.REFERRAL_REASON, text="Persistent dyspepsia" if not alarms else "Alarm features - rule out malignancy")
                if not ctx.district_endoscopy(dcode, day):
                    rec.order(enc, t + 152, C.ORD_REF_HOSP, ORDER_REFERRAL)
            if cs.clinical_only:
                if _clinical_diagnosis(p, ctx, rec, cs, day + rnd.randint(7, 30), rnd):
                    break
            else:
                site, in_district = ctx.endoscopy_site(dcode, day)
                if in_district:
                    p_done, delay = 0.93, rnd.randint(14, 42)
                elif ins5["enabled"] and dcode == ins5["district"]:
                    p_done, delay = ins5.get("pre_access_referral_completion", 0.2), rnd.randint(35, 112)
                else:
                    p_done, delay = 0.72, rnd.randint(28, 98)
                endo_day = day + delay
                if rnd.random() < p_done and endo_day < horizon:
                    site, _ = ctx.endoscopy_site(dcode, endo_day)
                    _diagnose(p, ctx, rec, cs, endo_day, site, alarms, anaemic_seen, rnd)
                    break
                cs.refused += 1
        # ---- next visit
        tau = (day - cs.symptom_start) / 30.44
        lam = (0.30 + 0.52 * min(1.0, tau / 9)) if cs.ramp else 0.30
        if stage == "IV":
            lam *= 1.5
        day += max(7, int(rnd.expovariate(lam) * 30.44))

    term_p = gc.get("terminal_admission_prob", 0.75)
    if ins5["enabled"] and p.district_at(untreated_death) == ins5["district"] and not ctx.district_endoscopy(ins5["district"], untreated_death):
        term_p = ins5.get("pre_access_terminal_dx", term_p)  # INS-5: no local endoscopy -> many die undiagnosed
    if cs.dx_day is None and untreated_death < min(p.death, SIM_END) and rnd.random() < term_p:
        # terminal admission: most patients are finally worked up in hospital in their last weeks
        tday = max(cs.symptom_start + 7, untreated_death - rnd.randint(10, 50))
        cs.route = "terminal"
        _hospital_workup(p, ctx, rec, cs, tday, rnd, [2205], True)
        if cs.dx_day is not None:
            p.death = min(p.death, untreated_death + rnd.randint(0, 20))
            cs.death_ca = min(cs.death_ca or 10**7, p.death)
            p.died_of = cs.dx_code if cs.dx_code != C.OES_CA else 2000
    if cs.dx_day is None:
        # never diagnosed: dies with symptoms (untreated) or censored at horizon
        if untreated_death < min(p.death, SIM_END):
            p.death = untreated_death
            p.died_of = 2016 if rnd.random() < 0.4 else None  # GI haemorrhage or unknown cause
        cs.status = "UNDIAGNOSED"
    return _latent_record(p, cs)


def _hospital_workup(p: Patient, ctx: Ctx, rec: Recorder, cs: CaseState, day: int, rnd: random.Random, alarms, anaemic):
    dcode = p.district_at(day)
    site = ctx.district_endoscopy(dcode, day)
    ins5 = ctx.cfg["insights"]["ins5"]
    if ins5["enabled"] and dcode == ins5["district"] and not site and rnd.random() > ins5.get("pre_access_workup_dx", 1.0):
        return  # INS-5: work-up inconclusive without endoscopy access
    if site and rnd.random() < 0.8 and not cs.clinical_only:
        _diagnose(p, ctx, rec, cs, day + rnd.randint(2, 10), site, alarms, anaemic, rnd)
    elif not site and rnd.random() < 0.7 and not cs.clinical_only:
        far, _ = ctx.endoscopy_site(dcode, day)
        _diagnose(p, ctx, rec, cs, day + rnd.randint(7, 21), far, alarms, anaemic, rnd)
    else:
        _clinical_diagnosis(p, ctx, rec, cs, day, rnd)


def _clinical_diagnosis(p: Patient, ctx: Ctx, rec: Recorder, cs: CaseState, day: int, rnd: random.Random) -> bool:
    dcode = p.district_at(day)
    loc = ctx.dh(dcode) if rnd.random() < 0.7 else ctx.prov_hosp.get(p.province_at(day), ctx.dh(dcode))
    t = clinic_time(day, rnd)
    enc = rec.encounter(t, "OPD", loc)
    rec.order(enc, t, C.ORD_US)
    rec.dx(enc, t + 60, loc, C.SUSPECTED_GC, confirmed=False)
    rec.dx(enc, t + 61, loc, 2000, confirmed=False)
    cs.dx_day, cs.dx_loc, cs.dx_code = day, loc, 2000
    cs.status = "PROBABLE"
    cs.stage = cs.stage_at(day)
    cs.district_dx = dcode
    _survival(p, ctx, rec, cs, rnd, curative_possible=False)
    return True


def _diagnose(p, ctx, rec, cs: CaseState, endo_day: int, site: int, alarms, anaemic, rnd):
    stage = cs.stage_at(endo_day)
    T, N, M = _tnm(stage, rnd)
    t = clinic_time(endo_day, rnd)
    enc = rec.encounter(t, "ENDOSCOPY", site)
    g = rec.obs(enc, t, site, C.ENDO_SET)
    indication = 7102 if any(a in (2017, 2018) for a in alarms) else (7101 if alarms else (7103 if anaemic else 7100))
    rec.coded(enc, t, site, C.ENDO_INDICATION, indication, group=g)
    rec.coded(enc, t, site, C.ENDO_IMPRESSION, 7112 if (stage == "I" and rnd.random() < 0.3) else 7113, group=g)
    rec.coded(enc, t, site, C.LESION_LOC, LOC_CODE[cs.location], group=g)
    size = {7160: (8, 20), 7161: (18, 35), 7162: (30, 55), 7163: (45, 80), 7164: (60, 95)}[T]
    rec.obs(enc, t, site, C.LESION_SIZE, num=float(rnd.randint(*size)), group=g)
    biopsy = rnd.random() < 0.97
    rec.coded(enc, t, site, C.BIOPSY, C.YES if biopsy else C.NO, group=g)
    infected = p.hp and (p.hp_erad_day is None or endo_day < p.hp_erad_day)
    rec.coded(enc, t, site, C.RUT, C.POS if infected and rnd.random() < 0.85 else C.NEG, group=g)
    rec.dx(enc, t + 30, site, C.SUSPECTED_GC, confirmed=False)
    cs.district_dx = p.district_at(endo_day)
    code = LOC_DX[cs.location] if rnd.random() < 0.8 else 2000
    miscoded = rnd.random() < ctx.cfg["quality_noise"]["c16_miscode"]
    if not biopsy:
        cs.dx_day, cs.dx_loc, cs.dx_code, cs.status, cs.stage = endo_day, site, 2000, "PROBABLE", stage
        rec.dx(enc, t + 31, site, 2000)
        _oncology(p, ctx, rec, cs, endo_day + rnd.randint(7, 25), T, N, M, rnd)
        return
    path_day = endo_day + rnd.randint(7, 28)
    pt = clinic_time(path_day, rnd)
    penc = rec.encounter(pt, "PATHOLOGY", site)
    pg = rec.obs(penc, pt, site, C.PATH_SET)
    rec.coded(penc, pt, site, C.HISTOLOGY, 7130, group=pg)
    rec.coded(penc, pt, site, C.LAUREN, LAUREN_CODE[cs.lauren], group=pg)
    grade = 7152 if cs.lauren == "diffuse" else weighted(rnd, [(7150, 0.25), (7151, 0.45), (7152, 0.30)])
    rec.coded(penc, pt, site, C.GRADE, grade, group=pg)
    rec.coded(penc, pt, site, C.HP_HISTO, C.POS if infected else C.NEG, group=pg)
    stage = cs.stage_at(path_day)
    cs.dx_day, cs.dx_loc, cs.stage, cs.status = path_day, site, stage, "CONFIRMED"
    cs.dx_code = C.OES_CA if miscoded else code
    rec.dx(penc, pt + 20, site, cs.dx_code)
    rec.order(penc, pt + 30, C.ORD_ONCOLOGY, ORDER_REFERRAL)
    _oncology(p, ctx, rec, cs, path_day + rnd.randint(7, 30), T, N, M, rnd)


def _oncology(p, ctx, rec, cs: CaseState, day: int, T, N, M, rnd):
    loc = ctx.oncology_site(p.district_at(day))
    t = clinic_time(day, rnd)
    enc = rec.encounter(t, "ONCOLOGY", loc)
    rec.program(3, t, loc)
    rec.order(enc, t, C.ORD_CT)
    stage = cs.stage
    cea = rnd.lognormvariate(math.log(3 if stage in ("I", "II") else 12), 0.7)
    rec.num(enc, t + 60, loc, C.CEA, cea)
    g = rec.obs(enc, t, loc, C.STAGE_SET)
    rec.coded(enc, t, loc, C.T_STAGE, T, group=g)
    rec.coded(enc, t, loc, C.N_STAGE, N, group=g)
    rec.coded(enc, t, loc, C.M_STAGE, M, group=g)
    rec.coded(enc, t, loc, C.STAGE_GROUP, STAGE_CODE[stage] if rnd.random() > 0.04 else 7194, group=g)
    ecog = {"I": 0, "II": 1, "III": 1, "IV": 2}[stage] + (1 if rnd.random() < 0.3 else 0)
    rec.num(enc, t, loc, C.ECOG, float(min(ecog, 4)), 0)
    rec.dx(enc, t + 10, loc, cs.dx_code)
    vitals(p, rec, enc, t, loc, rnd, full=True)
    _survival(p, ctx, rec, cs, rnd, curative_possible=True, enc=enc, t=t, loc=loc)


def _survival(p, ctx, rec, cs: CaseState, rnd, curative_possible: bool, enc=None, t=None, loc=None):
    stage = cs.stage
    tier = ctx.tier(cs.first_gi_loc) if cs.first_gi_loc else "medium"
    p_cur = {"I": 0.85, "II": 0.70, "III": 0.45, "IV": 0.03}[stage] * TIER_CURATIVE[tier] if curative_possible else 0.0
    if rnd.random() < p_cur:
        intent, hr = 7200, 0.6
    elif stage == "IV" and rnd.random() < TIER_BSC_IV[tier]:
        intent, hr = 7202, 1.4
    else:
        intent, hr = 7201, 1.0
    cs.treatment = {7200: "curative", 7201: "palliative", 7202: "bsc"}[intent]
    if enc is not None:
        rec.coded(enc, t + 5, loc, C.TX_INTENT, intent)
        if intent == 7200:
            rec.coded(enc, t + 6, loc, C.GASTRECTOMY, C.YES if rnd.random() < 0.75 else C.NO)
            rec.coded(enc, t + 7, loc, C.CHEMO, 7210 if rnd.random() < 0.7 else 7211)
            rec.drug(enc, t + 8, C.CAPECITABINE, 14, freq="BD")
            rec.drug(enc, t + 9, C.OXALIPLATIN, 1)
        elif intent == 7201:
            rec.coded(enc, t + 7, loc, C.CHEMO, 7211 if rnd.random() < 0.6 else 7213)
            rec.drug(enc, t + 8, C.CAPECITABINE, 14, freq="BD")
            rec.drug(enc, t + 9, C.MORPHINE, 30, freq="QID")
        else:
            rec.drug(enc, t + 9, C.MORPHINE, 30, freq="QID")
    k = SURV_SHAPE
    lam = SURV_MEDIAN_M[stage] / (math.log(2) ** (1 / k))
    months = lam * ((-math.log(max(rnd.random(), 1e-12)) / hr) ** (1 / k))
    death_ca = cs.dx_day + int(months * 30.44)
    cs.death_ca = death_ca
    if death_ca < p.death:
        p.death = death_ca
        p.died_of = cs.dx_code if cs.dx_code != C.OES_CA else 2000
    # follow-up visits until death or loss to follow-up
    lost_at = cs.dx_day + int(rnd.expovariate(1 / 500)) if rnd.random() < 0.25 else 10**7
    fday = cs.dx_day + rnd.randint(30, 60)
    site = ctx.oncology_site(p.district_at(cs.dx_day))
    while fday < min(p.death, lost_at, SIM_END):
        ft = clinic_time(fday, rnd)
        fe = rec.encounter(ft, "RETURN", site)
        vitals(p, rec, fe, ft, site, rnd, full=True)
        if rnd.random() < 0.6:
            rec.num(fe, ft + 60, site, C.HB, p.hb(fday) - rnd.uniform(0, 1.5))
        if rnd.random() < 0.3:
            rec.dx(fe, ft + 10, site, cs.dx_code)
        fday += rnd.randint(30, 95)
    if p.death > lost_at:
        p.death_recorded = True  # lost to follow-up: death (if any) never reaches the EMR


def _latent_record(p: Patient, cs: CaseState) -> dict:
    return {
        "person_id": p.pid, "onset_day": cs.onset, "symptom_start_day": cs.symptom_start, "dx_day": cs.dx_day,
        "status": cs.status, "stage": cs.stage, "stage_if_dx_now": None, "lauren": cs.lauren, "location": cs.location,
        "young_at_onset": cs.young, "male": p.male, "hp": p.hp, "hp_eradicated_day": p.hp_erad_day,
        "district_code": p.district, "district_dx": cs.district_dx, "province": p.province,
        "first_gi_loc": cs.first_gi_loc, "first_gi_day": cs.first_gi_day, "first_rec_gi_day": cs.first_rec_gi_day,
        "n_symptomatic_visits": cs.n_visits, "misattributions": cs.misattrib, "referrals": cs.referrals,
        "refused": cs.refused, "death_day": p.death if p.death < 10**6 else None, "death_ca_day": cs.death_ca,
        "treatment": cs.treatment, "clinical_only": cs.clinical_only, "birth_day": p.birth, "dx_code": cs.dx_code,
        "route": cs.route if cs.dx_day is not None else None, "first_mis_day": cs.first_mis_day, "hb_drop": cs.hb_drop, "wt_loss": cs.wt_loss, "alarm_late": cs.alarm_late, "emr_start": p.emr_start,
    }
