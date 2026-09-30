"""Rwanda geography reference (SPEC §5.2) — district_code is our own stable code."""
from __future__ import annotations

PROVINCES = {
    "KGL": "City of Kigali",
    "NOR": "Northern",
    "SOU": "Southern",
    "EAS": "Eastern",
    "WES": "Western",
}

# district_code: (province_code, name, pop_weight)
DISTRICTS: dict[str, tuple[str, str, float]] = {
    "KGL-GAS": ("KGL", "Gasabo", 0.067), "KGL-KIC": ("KGL", "Kicukiro", 0.037), "KGL-NYR": ("KGL", "Nyarugenge", 0.028),
    "NOR-BUR": ("NOR", "Burera", 0.030), "NOR-GAK": ("NOR", "Gakenke", 0.027), "NOR-GIC": ("NOR", "Gicumbi", 0.034),
    "NOR-MUS": ("NOR", "Musanze", 0.036), "NOR-RUL": ("NOR", "Rulindo", 0.027),
    "SOU-GIS": ("SOU", "Gisagara", 0.030), "SOU-HUY": ("SOU", "Huye", 0.029), "SOU-KAM": ("SOU", "Kamonyi", 0.034),
    "SOU-MUH": ("SOU", "Muhanga", 0.027), "SOU-NYM": ("SOU", "Nyamagabe", 0.028), "SOU-NYZ": ("SOU", "Nyanza", 0.028),
    "SOU-NYG": ("SOU", "Nyaruguru", 0.024), "SOU-RUH": ("SOU", "Ruhango", 0.027),
    "EAS-BUG": ("EAS", "Bugesera", 0.042), "EAS-GAT": ("EAS", "Gatsibo", 0.042), "EAS-KAY": ("EAS", "Kayonza", 0.035),
    "EAS-KIR": ("EAS", "Kirehe", 0.035), "EAS-NGO": ("EAS", "Ngoma", 0.030), "EAS-NYA": ("EAS", "Nyagatare", 0.049),
    "EAS-RWA": ("EAS", "Rwamagana", 0.036),
    "WES-KAR": ("WES", "Karongi", 0.028), "WES-NGR": ("WES", "Ngororero", 0.028), "WES-NYB": ("WES", "Nyabihu", 0.024),
    "WES-NYS": ("WES", "Nyamasheke", 0.033), "WES-RUB": ("WES", "Rubavu", 0.042), "WES-RUS": ("WES", "Rusizi", 0.037),
    "WES-RUT": ("WES", "Rutsiro", 0.028),
}

DISTRICT_CODES = list(DISTRICTS)
NAME_TO_CODE = {v[1].lower(): k for k, v in DISTRICTS.items()}


def province_of(district_code: str) -> str:
    return DISTRICTS[district_code][0]


def normalised_weights() -> dict[str, float]:
    s = sum(v[2] for v in DISTRICTS.values())
    return {k: v[2] / s for k, v in DISTRICTS.items()}


# WHO World Standard Population (2000-2025), 18 groups, per 100k (SPEC §12.2)
AGE_GROUPS = ["0-4", "5-9", "10-14", "15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49",
              "50-54", "55-59", "60-64", "65-69", "70-74", "75-79", "80-84", "85+"]
WHO_STD = [8860, 8690, 8600, 8470, 8220, 7930, 7610, 7150, 6590, 6040, 5370, 4550, 3720, 2960, 2210, 1520, 910, 635]


def age_group_of(age: int) -> str:
    i = min(int(age) // 5, 17)
    return AGE_GROUPS[max(i, 0)]


def age_group_index(age):
    import numpy as np
    return np.clip(np.asarray(age) // 5, 0, 17).astype(int)


# Rwanda-like age pyramid at 2020-07-01 (SPEC §8.3), 5y bins up to 80+
PYRAMID = [13.0, 12.0, 11.0, 10.0, 9.5, 8.5, 7.5, 6.5, 5.5, 4.5, 3.5, 2.8, 2.2, 1.5, 1.0, 0.6, 0.4]
