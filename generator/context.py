"""Per-run context shared by the life-simulation modules (facility lookups, tiers, constants)."""
from __future__ import annotations

from dataclasses import dataclass, field

from shared.geo import DISTRICT_CODES, DISTRICTS

from .dates import d

HIST_END = d("2026-06-30")
SIM_END = d("2027-12-31")
START = d("2015-01-01")
MIN_PER_DAY = 1440

TIER_HP_TEST = {"low": 0.05, "medium": 0.20, "high": 0.50}
TIER_PPI_ONLY = {"low": 0.70, "medium": 0.55, "high": 0.35}
TIER_ERADICATE = {"low": 0.60, "medium": 0.75, "high": 0.90}
TIER_REFER = {"low": 0.25, "medium": 0.45, "high": 0.70}
TIER_REC_SMOKING = {"low": 0.25, "medium": 0.35, "high": 0.50}
TIER_REC_FAMHX = {"low": 0.08, "medium": 0.15, "high": 0.25}
TIER_FBC = {"low": 0.18, "medium": 0.30, "high": 0.45}
MALARIA_PROV = {"EAS": 1.6, "SOU": 1.25, "WES": 0.8, "NOR": 0.5, "KGL": 0.35}


@dataclass
class Ctx:
    cfg: dict
    facs: list[dict]
    by_id: dict[int, dict] = field(default_factory=dict)
    dh_by_district: dict[str, list[int]] = field(default_factory=dict)
    hc_by_district: dict[str, list[int]] = field(default_factory=dict)
    prov_hosp: dict[str, int] = field(default_factory=dict)
    referral: list[int] = field(default_factory=list)
    go_live: dict[int, int] = field(default_factory=dict)

    def __post_init__(self):
        for f in self.facs:
            self.by_id[f["location_id"]] = f
            self.go_live[f["location_id"]] = f["go_live"]
            t = f["facility_type"]
            if t == "DISTRICT":
                self.dh_by_district.setdefault(f["district_code"], []).append(f["location_id"])
            elif t == "HEALTH_CENTRE":
                self.hc_by_district.setdefault(f["district_code"], []).append(f["location_id"])
            elif t == "PROVINCIAL":
                self.prov_hosp[f["province_code"]] = f["location_id"]
            elif t == "REFERRAL":
                self.referral.append(f["location_id"])
        self.referral_by_prov = {"KGL": self.referral[0], "SOU": self.referral[3], "NOR": self.referral[1],
                                 "EAS": self.referral[2], "WES": self.referral[0]}

    def tier(self, loc: int) -> str:
        return self.by_id[loc]["hp_testing_tier"]

    def district_code(self, idx: int) -> str:
        return DISTRICT_CODES[idx]

    def province(self, dcode: str) -> str:
        return DISTRICTS[dcode][0]

    def dh(self, dcode: str) -> int:
        return self.dh_by_district[dcode][0]

    def has_endoscopy(self, loc: int, day: int) -> bool:
        e = self.by_id[loc]["endoscopy_from"]
        return e is not None and e <= day

    def district_endoscopy(self, dcode: str, day: int) -> int | None:
        for loc in self.dh_by_district[dcode]:
            if self.has_endoscopy(loc, day):
                return loc
        prov = self.province(dcode)
        ph = self.prov_hosp.get(prov)
        if ph and self.by_id[ph]["district_code"] == dcode and self.has_endoscopy(ph, day):
            return ph
        for r in self.referral:
            if self.by_id[r]["district_code"] == dcode:
                return r
        return None

    def endoscopy_site(self, dcode: str, day: int) -> tuple[int, bool]:
        """Nearest endoscopy facility at a date and whether it is inside the patient's district."""
        loc = self.district_endoscopy(dcode, day)
        if loc:
            return loc, True
        prov = self.province(dcode)
        ph = self.prov_hosp.get(prov)
        if ph and self.has_endoscopy(ph, day):
            return ph, False
        return self.referral_by_prov[prov], False

    def oncology_site(self, dcode: str) -> int:
        prov = self.province(dcode)
        return self.referral_by_prov[prov]
