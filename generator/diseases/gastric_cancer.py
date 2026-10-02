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
SURV_MEDIAN_M = {"I": 60, "II": 22, "III": 12, "IV": 6.0}   # D-06/D-34: true 1-y survival ~30% (§8.8), INS-4 tier gap
SURV_SHAPE = 1.5
# INS-4 facility practice: patients who first present at low-testing-tier facilities reach curative care less often
TIER_CURATIVE = {"low": 0.3, "medium": 0.8, "high": 0.9}
TIER_BSC_IV = {"low": 0.75, "medium": 0.4, "high": 0.25}
# D-31: facility practice also shows in follow-up care (symptom control, nutrition, timely re-admission)
TIER_HR = {"low": 1.45, "medium": 1.0, "high": 1.0}
TIER_MULT = {"low": 0.45, "medium": 1.0, "high": 3.4}
# D-23: cancer work-up is referred less readily than the general dyspepsia rate (stage I-II 15-25%, interval 7-10 m,
# alarm features without endoscopy 55-65%), and least at low-testing-tier facilities (INS-4 stage IV 58-66% vs 34-42%)
CANCER_REFER_MULT = {"low": 1.15, "medium": 1.5, "high": 1.4}
# v3 survivorship (D-46): recurrence within 3 years after curative treatment (stage II-III 25-40%)
RECUR_3Y = {"I": 0.10, "II": 0.30, "III": 0.40, "IV": 0.50}
TOTAL_GASTRECTOMY_LOC = {"cardia", "body", "diffuse"}   # antrum -> distal (subtotal) gastrectomy


P_CURATIVE = {"I": 0.85, "II": 0.70, "III": 0.45, "IV": 0.03}


def p_curative(stage: str, tier: str) -> float:
    """Probability of curative-intent treatment at diagnosis (INS-4: lower where the first GI visit was low tier)."""
    return P_CURATIVE[stage] * TIER_CURATIVE[tier]


def case_seed(cfg: dict, pid: int) -> int:
    """Per-case seed for survivorship draws (stored in the latent record so a case can be re-simulated)."""
    return (int(cfg.get("seed", 42)) * 1_000_003 + int(pid)) * 31 + 7


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
                 "referrals", "refused", "district_dx", "first_rec_gi_day", "route", "first_mis_day", "mis_prone",
                 "seed", "sojourn_m", "bg_death", "surv")

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
    cs.sojourn_m = sojourn_m
    cs.seed = case_seed(ctx.cfg, p.pid)  # survivorship draws use their own stream: the case's rnd stream is unchanged
    cs.bg_death = p.death
    cs.surv = None
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
                and cs.mis_prone and day >= suppress_until):   # prone patients are relabelled each time anaemia is seen again
            misattributed = True
            cs.misattrib += 1
            if cs.first_mis_day is None:
                cs.first_mis_day = day
            if not anaemic_seen:  # pallor seen clinically: the anaemia is recorded, then blamed on malaria/worms
                rec.dx(enc, t + 75, loc, 2023, confirmed=False, primary=False)
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
            p_ref = TIER_REFER[tier] * 0.55 * (0.3 + 0.7 * anchor)
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
    p_cur = p_curative(stage, tier) if curative_possible else 0.0
    if rnd.random() < p_cur:
        intent, hr = 7200, 0.6
    elif stage == "IV" and rnd.random() < TIER_BSC_IV[tier]:
        intent, hr = 7202, 1.4
    else:
        intent, hr = 7201, 1.0
    cs.treatment = {7200: "curative", 7201: "palliative", 7202: "bsc"}[intent]
    gastrectomy, regimen = None, None
    if enc is not None:
        rec.coded(enc, t + 5, loc, C.TX_INTENT, intent)
        if intent == 7200:
            gastrectomy = rnd.random() < 0.75
            rec.coded(enc, t + 6, loc, C.GASTRECTOMY, C.YES if gastrectomy else C.NO)
            regimen = 7210 if rnd.random() < 0.7 else 7211
            rec.coded(enc, t + 7, loc, C.CHEMO, regimen)
            rec.drug(enc, t + 8, C.CAPECITABINE, 14, freq="BD")
            rec.drug(enc, t + 9, C.OXALIPLATIN, 1)
        elif intent == 7201:
            regimen = 7211 if rnd.random() < 0.6 else 7213
            rec.coded(enc, t + 7, loc, C.CHEMO, regimen)
            rec.drug(enc, t + 8, C.CAPECITABINE, 14, freq="BD")
            rec.drug(enc, t + 9, C.MORPHINE, 30, freq="QID")
        else:
            rec.drug(enc, t + 9, C.MORPHINE, 30, freq="QID")
    hr *= TIER_HR[tier]
    k = SURV_SHAPE
    lam = SURV_MEDIAN_M[stage] / (math.log(2) ** (1 / k))
    months = lam * ((-math.log(max(rnd.random(), 1e-12)) / hr) ** (1 / k))
    death_ca = cs.dx_day + int(months * 30.44)
    # v3 survivorship plan (own random stream, so the rows above and every later rnd draw are unchanged)
    srnd = random.Random(cs.seed if cs.seed is not None else case_seed(ctx.cfg, p.pid))
    sv = _survivorship_plan(p, ctx, cs, srnd, intent, gastrectomy, regimen, tier, death_ca,
                            onc_day=(t // MIN_PER_DAY) if t is not None else cs.dx_day)
    cs.surv = sv
    death_ca = sv["death_ca"]
    cs.death_ca = death_ca
    if death_ca < p.death:
        p.death = death_ca
        p.died_of = cs.dx_code if cs.dx_code != C.OES_CA else 2000
    # follow-up visits until death or loss to follow-up
    lost_at = cs.dx_day + int(rnd.expovariate(1 / 500)) if rnd.random() < 0.25 else 10**7
    sv["lost_at"] = lost_at if lost_at < 10**7 else None
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
        _survivorship_visit(p, rec, cs, sv, srnd, fe, ft, fday, site)
        fday += rnd.randint(30, 95)
    if enc is not None:
        _treatment_events(p, ctx, rec, cs, sv, srnd, site, min(p.death, lost_at, SIM_END))
    if p.death > lost_at:
        p.death_recorded = True  # lost to follow-up: death (if any) never reaches the EMR
    else:
        # D-34: patients still in oncology follow-up are traced, so their deaths reach the EMR far more often than the
        # general 80% (otherwise survival from the EMR is biased upward by deaths missing right after the last visit)
        p.death_traced = True


# ----------------------------------------------------------------------------------- survivorship (v3, D-46)
def _survivorship_plan(p, ctx, cs: CaseState, srnd: random.Random, intent: int, gastrectomy, regimen, tier: str,
                       death_ca: int, onc_day: int) -> dict:
    """Treatment timeline (surgery, chemo cycles), recurrence and nutrition state for one case. Recurrence after
    curative treatment: when the cancer death falls within 3 years it is preceded by the recurrence that causes it;
    otherwise a recurrence (6-36 months) brings the death forward (median 10 months after recurrence)."""
    stage, dx = cs.stage, cs.dx_day
    sv = {"intent": intent, "gastrectomy": gastrectomy, "gastrectomy_type": None, "surgery_day": None,
          "regimen": regimen, "cycles": [], "chemo_planned": 0, "chemo_done": 0, "recurrence_day": None,
          "recurrence_type": None, "recurrence_recorded": False, "death_ca": death_ca, "tier": tier,
          "b12": None, "b12_day": None, "b12_next": None, "b12_inj": False, "ct_next": None, "endo_next": None,
          "onc_day": onc_day}
    if gastrectomy:
        sv["gastrectomy_type"] = "total" if cs.location in TOTAL_GASTRECTOMY_LOC else "subtotal"
    # chemo schedule (planned cycle days) and surgery day
    pre = 0
    if intent == 7200 and regimen == 7210:      # FLOT: 4 pre-operative + 4 post-operative cycles, every 2 weeks
        pre, n_cyc, gap = 4, 8, 14
    elif intent == 7200:                         # CAPOX adjuvant: 8 cycles every 3 weeks after surgery
        n_cyc, gap = 8, 21
    elif intent == 7201 and regimen == 7211:     # palliative CAPOX: up to 6 cycles
        n_cyc, gap = 6, 21
    else:
        n_cyc, gap = 0, 21
    first = onc_day + srnd.randint(10, 21)
    if gastrectomy:
        sv["surgery_day"] = (first + pre * gap + srnd.randint(21, 35)) if pre else onc_day + srnd.randint(21, 42)
    days = []
    for i in range(n_cyc):
        if i < pre or not gastrectomy:
            d = first + i * gap
        else:
            d = sv["surgery_day"] + srnd.randint(35, 49) + (i - pre) * gap
        days.append(d + srnd.randint(-2, 3))
    sv["cycles"] = days
    sv["chemo_planned"] = n_cyc
    # recurrence
    if intent == 7200 and srnd.random() < RECUR_3Y[stage]:
        if death_ca - dx < 3 * 365:
            r = max(dx + 120, death_ca - int(srnd.gammavariate(2.0, 3.5) * 30.44))
            sv["recurrence_day"] = r if r < death_ca - 14 else None
        else:
            r = dx + int(srnd.uniform(6, 36) * 30.44)
            post = 10 / (math.log(2) ** (1 / 1.2)) * (-math.log(max(srnd.random(), 1e-12))) ** (1 / 1.2)
            sv["recurrence_day"] = r
            sv["death_ca"] = min(death_ca, r + int(post * 30.44) + 14)
        if sv["recurrence_day"] is not None:
            sv["recurrence_type"] = C.DISTANT_RECURRENCE if srnd.random() < 0.7 else C.LOCAL_RECURRENCE
    # treatment start: tumour bleeding and weight loss stop (curative / palliative chemo)
    tx_start = sv["surgery_day"] or (days[0] if days else None)
    if intent in (7200, 7201) and tx_start is not None:
        p.hb_stop = tx_start if p.hb_stop is None else p.hb_stop
        p.wt_stop = tx_start if intent == 7200 else None
    if gastrectomy:
        w = p.weight(sv["surgery_day"])
        p.wt_post = (sv["surgery_day"], w * srnd.uniform(0.07, 0.15), srnd.uniform(0.2, 0.5))
        # B12 stores deplete over 1-3 years after total gastrectomy (slower after distal gastrectomy)
        sv["b12"] = srnd.lognormvariate(math.log(430), 0.25)
        sv["b12_day"] = sv["surgery_day"]
        sv["b12_k"] = srnd.uniform(0.035, 0.06) if sv["gastrectomy_type"] == "total" else srnd.uniform(0.008, 0.02)
        sv["b12_next"] = sv["surgery_day"] + srnd.randint(90, 180)
        p_proph = {"low": 0.15, "medium": 0.35, "high": 0.55}[tier] if sv["gastrectomy_type"] == "total" else 0.05
        sv["b12_inj"] = srnd.random() < p_proph
    if intent == 7200 and stage in ("II", "III"):
        sv["ct_next"] = dx + srnd.randint(150, 200)
    if gastrectomy and sv["gastrectomy_type"] == "subtotal":
        sv["endo_next"] = sv["surgery_day"] + srnd.randint(330, 400)
    return sv


def _b12_at(sv: dict, day: int) -> float:
    m = max(0.0, (day - sv["b12_day"]) / 30.44)
    return sv["b12"] * math.exp(-sv["b12_k"] * m)


def _survivorship_visit(p, rec, cs: CaseState, sv: dict, srnd: random.Random, fe, ft: int, fday: int, site: int):
    """Oncology RETURN visit: ECOG, weight-related labs, B12 (+ injections), vitamin D/calcium, recurrence,
    surveillance imaging. Uses only `srnd`."""
    if fe is None:
        return
    stage = cs.stage
    recurred = sv["recurrence_day"] is not None and fday >= sv["recurrence_day"]
    to_death = p.death - fday
    ecog = {"I": 0, "II": 1, "III": 1, "IV": 2}[stage]
    if sv["intent"] == 7200 and fday - cs.dx_day > 180 and not recurred:
        ecog = max(0, ecog - 1)
    ecog += (1 if recurred else 0) + (1 if to_death < 120 else 0) + (1 if to_death < 45 else 0)
    if srnd.random() < 0.2:
        ecog += srnd.choice([-1, 1])
    rec.num(fe, ft + 5, site, C.ECOG, float(min(4, max(0, ecog))), 0)
    if srnd.random() < 0.35:
        ms = (fday - (sv["surgery_day"] or cs.dx_day)) / 30.44
        alb = 4.0 - (0.6 * math.exp(-max(ms, 0) / 3) if sv["surgery_day"] and ms >= 0 else 0.2) \
            - (0.5 if recurred else 0) - (0.4 if to_death < 120 else 0) + srnd.gauss(0, 0.25)
        rec.num(fe, ft + 70, site, C.ALB, min(5.2, max(1.8, alb)))
    if sv["gastrectomy"] and fday >= sv["surgery_day"]:
        if sv["b12_next"] is not None and fday >= sv["b12_next"]:
            b12 = _b12_at(sv, fday) * srnd.uniform(0.9, 1.1)
            o = rec.order(fe, ft + 15, C.ORD_B12)
            rec.obs(fe, ft + 80, site, C.B12, num=round(b12, 0), order=o)
            sv["b12_next"] = fday + srnd.randint(90, 180)
            if b12 < 250 and not sv["b12_inj"] and srnd.random() < 0.75:
                sv["b12_inj"] = True
        if sv["b12_inj"] and srnd.random() < 0.85:   # cyanocobalamin 1 mg IM at the visit (some visits missed)
            rec.drug(fe, ft + 20, C.CYANOCOBALAMIN, 1, qty=1.0)
            sv["b12"] = min(950.0, _b12_at(sv, fday) + srnd.uniform(200, 320))
            sv["b12_day"] = fday
            sv["b12_k"] = max(sv["b12_k"], 0.03)
        if srnd.random() < 0.12:
            vitd = min(60.0, max(5.0, srnd.gauss(19 if sv["gastrectomy_type"] == "total" else 23, 6)))
            rec.num(fe, ft + 85, site, C.VIT_D, vitd)
            rec.num(fe, ft + 85, site, C.CALCIUM, srnd.gauss(8.9 if vitd >= 20 else 8.5, 0.45))
            if vitd < 20 and srnd.random() < 0.5:
                rec.drug(fe, ft + 21, C.CALCIUM_VITD, 90)
    if recurred and not sv["recurrence_recorded"] and fday >= sv["recurrence_day"] + srnd.randint(0, 45):
        rec.coded(fe, ft + 30, site, C.RECURRENCE, sv["recurrence_type"])
        rec.dx(fe, ft + 31, site, cs.dx_code)
        sv["recurrence_recorded"] = True
    if sv["ct_next"] is not None and fday >= sv["ct_next"] and fday - cs.dx_day < 3 * 365 + 60:
        o = rec.order(fe, ft + 12, C.ORD_CT)
        found = recurred and srnd.random() < 0.85
        res = C.SUSPICIOUS if (found or (not recurred and srnd.random() < 0.05)) else C.NED
        rec.obs(fe, ft + 90, site, C.SURV_IMAGING, coded=res, order=o)
        if res == C.NED:
            rec.coded(fe, ft + 91, site, C.RECURRENCE, C.NO_RECURRENCE)
        if found and not sv["recurrence_recorded"]:
            rec.coded(fe, ft + 91, site, C.RECURRENCE, sv["recurrence_type"])
            sv["recurrence_recorded"] = True
        sv["ct_next"] = fday + (srnd.randint(150, 210) if fday - cs.dx_day < 2 * 365 else srnd.randint(330, 400))


def _treatment_events(p, ctx, rec, cs: CaseState, sv: dict, srnd: random.Random, site: int, horizon: int):
    """Surgery admission (post-op complication) and chemotherapy cycle visits (obs 5063 = cycle number, some missed)."""
    sd = sv["surgery_day"]
    if sd is not None and sd < horizon:
        t = clinic_time(sd, srnd)
        adm = rec.encounter(t, "ADMISSION", site, vtype=2)
        comp = srnd.random() < (0.18 + (0.07 if sv["tier"] == "low" else 0.0))
        rec.coded(adm, t + 600, site, C.POSTOP_COMPLICATION, C.YES if comp else C.NO)
        los = srnd.randint(7, 14) + (srnd.randint(5, 12) if comp else 0)
        if sd + los < horizon:
            dt_ = clinic_time(sd + los, srnd)
            de = rec.encounter(dt_, "DISCHARGE", site)
            vitals(p, rec, de, dt_, site, srnd, full=True)
    p_miss = 0.10 + (0.06 if sv["tier"] == "low" else 0.0)
    for k, day in enumerate(sv["cycles"], start=1):
        if day >= horizon or (sv["recurrence_day"] is not None and day >= sv["recurrence_day"]):
            break
        if srnd.random() < p_miss:
            continue
        t = clinic_time(day, srnd)
        e = rec.encounter(t, "RETURN", site)
        if e is None:
            continue
        rec.num(e, t + 30, site, C.CHEMO_CYCLE, float(k), 0)
        rec.coded(e, t + 31, site, C.CHEMO, sv["regimen"])
        rec.drug(e, t + 40, C.OXALIPLATIN, 1)
        if sv["regimen"] == 7211:
            rec.drug(e, t + 41, C.CAPECITABINE, 14, freq="BD")
        vitals(p, rec, e, t, site, srnd, full=False)
        sv["chemo_done"] += 1


def _latent_record(p: Patient, cs: CaseState) -> dict:
    sv = cs.surv or {}
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
        # v3: enough to re-simulate the case from a later intervention (generator/intervention.py)
        "case_seed": cs.seed, "sojourn_months": cs.sojourn_m, "stage_months": list(cs.durs),
        "bg_death_day": cs.bg_death if cs.bg_death is not None and cs.bg_death < 10**6 else None,
        "hb_decline_start": p.hb_decline[0] if p.hb_decline else None,
        "hb_decline_rate": p.hb_decline[1] if p.hb_decline else None,
        "wt_loss_start": p.wt_loss[0] if p.wt_loss else None, "wt_loss_rate": p.wt_loss[1] if p.wt_loss else None,
        "intent": sv.get("intent"), "gastrectomy": sv.get("gastrectomy"), "gastrectomy_type": sv.get("gastrectomy_type"),
        "surgery_day": sv.get("surgery_day"), "regimen": sv.get("regimen"), "chemo_planned": sv.get("chemo_planned"),
        "chemo_done": sv.get("chemo_done"), "recurrence_day": sv.get("recurrence_day"),
        "recurrence_type": sv.get("recurrence_type"), "lost_to_fu_day": sv.get("lost_at"),
    }
