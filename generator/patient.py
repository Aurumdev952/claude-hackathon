"""Lightweight per-patient view over the vectorised population arrays."""
from __future__ import annotations

import math

from shared.geo import DISTRICT_CODES, DISTRICTS


class Patient:
    __slots__ = ("i", "pid", "male", "birth", "death", "district", "province", "sector_idx", "home", "home2",
                 "move_day", "district2", "emr_start", "hp", "tobacco", "alcohol", "alcohol_heavy", "salt", "smoked",
                 "family_hx", "nsaid", "atrophy_day", "hiv", "hiv_dx", "htn", "htn_dx", "dm", "dm_dx", "water", "fuel",
                 "occupation", "fruit_veg", "hb_base", "height", "bmi", "hot", "micro", "hp_erad_day", "initial_done",
                 "hb_decline", "wt_loss", "cancer", "died_of", "death_recorded", "lifestyle_recorded", "death_enc", "death_traced",
                 "hb_stop", "wt_stop", "wt_post")

    def __init__(self, P: dict, i: int):
        self.i = i
        self.pid = int(P["person_id"][i])
        self.male = bool(P["sex"][i] == 1)
        self.birth = int(P["birth"][i])
        self.death = int(P["death"][i])
        self.district = DISTRICT_CODES[int(P["district_idx"][i])]
        self.province = DISTRICTS[self.district][0]
        self.sector_idx = int(P["sector_idx"][i])
        self.home = int(P["home"][i])
        self.home2 = int(P["home2"][i])
        self.move_day = int(P["move_day"][i])
        self.district2 = DISTRICT_CODES[int(P["district2_idx"][i])]
        self.emr_start = int(P["emr_start"][i])
        for k in ("hp", "alcohol_heavy", "salt", "smoked", "family_hx", "nsaid", "hiv", "htn", "dm", "hot", "micro"):
            setattr(self, k, bool(P[k][i]))
        for k in ("tobacco", "alcohol", "atrophy_day", "hiv_dx", "htn_dx", "dm_dx", "water", "fuel", "occupation"):
            setattr(self, k, int(P[k][i]))
        self.fruit_veg = float(P["fruit_veg"][i])
        self.hb_base = float(P["hb_base"][i])
        self.height = float(P["height"][i])
        self.bmi = float(P["bmi"][i])
        self.hp_erad_day = None
        self.initial_done = False
        self.hb_decline = None   # (start_day, g/dL per month)
        self.wt_loss = None      # (start_day, kg per month)
        self.cancer = None
        self.died_of = None
        self.death_recorded = False
        self.lifestyle_recorded = {}
        self.death_enc = False
        self.death_traced = False
        self.hb_stop = None      # treatment start: tumour bleeding stops, Hb recovers (survivorship, v3)
        self.wt_stop = None      # treatment start: tumour weight loss stops
        self.wt_post = None      # (surgery_day, drop_kg, regain_fraction) after gastrectomy

    # -- time-varying attributes --------------------------------------------------------
    def age(self, day: int) -> float:
        return (day - self.birth) / 365.25

    def home_at(self, day: int) -> int:
        return self.home2 if day >= self.move_day else self.home

    def district_at(self, day: int) -> str:
        return self.district2 if day >= self.move_day else self.district

    def province_at(self, day: int) -> str:
        return DISTRICTS[self.district_at(day)][0]

    def hb(self, day: int) -> float:
        age = self.age(day)
        base = self.hb_base if age >= 15 else 11.2 + 0.12 * max(age, 0)
        if self.hb_decline and day > self.hb_decline[0]:
            end = day if self.hb_stop is None else min(day, max(self.hb_stop, self.hb_decline[0]))
            deficit = self.hb_decline[1] * (end - self.hb_decline[0]) / 30.44
            base -= deficit
            if self.hb_stop is not None and day > self.hb_stop:  # after treatment: recovers 0.3 g/dL a month, to 80%
                base += min(0.8 * deficit, 0.3 * (day - self.hb_stop) / 30.44)
        return max(base, 4.5)

    def weight(self, day: int) -> float:
        age = self.age(day)
        if age < 18:
            w = 3.3 + 2.4 * min(age, 2) * 3 if age < 2 else 12 + (age - 2) * (3.1 if self.male else 2.9)
            w = min(w, self.bmi * (self.height / 100) ** 2)
        else:
            w = self.bmi * (self.height / 100) ** 2
        if self.wt_loss and day > self.wt_loss[0]:
            end = day if self.wt_stop is None else min(day, max(self.wt_stop, self.wt_loss[0]))
            w -= self.wt_loss[1] * (end - self.wt_loss[0]) / 30.44
        if self.wt_post and day > self.wt_post[0]:  # post-gastrectomy: loss over 6 months, partial regain over 12
            m = (day - self.wt_post[0]) / 30.44
            w -= self.wt_post[1] * min(1.0, m / 6) * (1 - self.wt_post[2] * min(1.0, max(0.0, m - 6) / 12))
        return max(w, 3.0)

    def height_at(self, day: int) -> float:
        age = self.age(day)
        if age >= 18:
            return self.height
        return 50 + (self.height - 50) * math.sqrt(max(age, 0) / 18)

    def anaemic(self, hb: float) -> bool:
        return hb < (13.0 if self.male else 12.0)
