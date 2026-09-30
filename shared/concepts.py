"""Concept dictionary loader (SPEC §7)."""
from __future__ import annotations

from functools import lru_cache

import yaml

from .config import REF_DIR

GROUP_CLASS = {
    "questions": ("Question", None),
    "diagnoses": ("Diagnosis", "Coded"),
    "symptoms": ("Symptom", "N/A"),
    "vitals": ("Finding", "Numeric"),
    "labs": ("Test", None),
    "lifestyle": ("Misc", None),
    "oncology": ("Procedure", None),
    "drugs": ("Drug", "N/A"),
    "answers": ("Misc", "N/A"),
    "orders": ("Test", "N/A"),
}


@lru_cache(maxsize=1)
def concepts() -> dict[int, dict]:
    with open(REF_DIR / "concepts.yaml") as f:
        raw = yaml.safe_load(f)
    out: dict[int, dict] = {}
    for group, items in raw.items():
        cls, dt = GROUP_CLASS[group]
        for c in items:
            c = dict(c)
            c.setdefault("class", cls)
            c.setdefault("datatype", dt or "N/A")
            c["group"] = group
            out[int(c["id"])] = c
    return out


def name(cid: int) -> str:
    c = concepts().get(int(cid))
    return c["name"] if c else f"concept {cid}"


def group_range(cid: int) -> str:
    cid = int(cid)
    for lo, hi, g in [(1000, 1099, "question"), (2000, 2199, "diagnosis"), (2200, 2299, "symptom"),
                      (3000, 3049, "vital"), (3100, 3199, "lab"), (4000, 4099, "lifestyle"),
                      (5000, 5199, "oncology"), (6000, 6099, "drug"), (7000, 7299, "answer"),
                      (8000, 8099, "order")]:
        if lo <= cid <= hi:
            return g
    return "other"


# Named concept id constants used across the codebase
class C:
    DIAGNOSIS = 1000; DX_CERTAINTY = 1001; DX_ORDER = 1002; CHIEF_COMPLAINT = 1003
    SYMPTOM_WEEKS = 1004; NOTE = 1005; REFERRAL_REASON = 1006; VISIT_OUTCOME = 1007; CAUSE_OF_DEATH = 1008
    GC_CODES = (2000, 2001, 2002, 2003, 2004)
    SUSPECTED_GC = 2005
    GI_DX = tuple(range(2010, 2022))
    IDA = 2022; ANAEMIA = 2023; HELMINTH = 2024
    MALARIA = 2100; HIV = 2101; HTN = 2102; DM = 2103; TB = 2104; URTI = 2105; PNEUMONIA = 2106
    DIARRHOEA = 2107; UTI = 2108; PREG = 2109; ASTHMA = 2110; CKD = 2111; HF = 2112; INJURY = 2113
    MALNUT = 2114; HBV = 2115; OES_CA = 2118
    GI_SYMPTOMS = (2200, 2201, 2202, 2203, 2204, 2205, 2206, 2211, 2212, 2213)
    ALARM_SYMPTOMS = (2203, 2205, 2213)
    WEIGHT = 3000; HEIGHT = 3001; BMI = 3002; SBP = 3003; DBP = 3004; PULSE = 3005; TEMP = 3006; RR = 3007; MUAC = 3008
    HB = 3100; MCV = 3101; FERRITIN = 3102; WBC = 3103; PLT = 3104; ALT = 3105; AST = 3106; ALB = 3107
    CEA = 3108; CREAT = 3109; RBG = 3110; HBA1C = 3111; MAL_RDT = 3112; MAL_SMEAR = 3113; HIV_TEST = 3114
    CD4 = 3115; VL = 3116; HP_STOOL = 3120; HP_SERO = 3121; HP_UBT = 3122; FOB = 3123; STOOL_OP = 3124
    TOBACCO = 4000; CIGS = 4001; ALCOHOL = 4002; ALCOHOL_TYPE = 4003; FAMILY_HX = 4004; HIGH_SALT = 4005
    SMOKED_FOOD = 4006; FRUIT_VEG = 4007; FUEL = 4008; WATER = 4009; OCCUPATION = 4010; NSAID = 4011
    ENDO_SET = 5000; ENDO_INDICATION = 5001; ENDO_IMPRESSION = 5002; LESION_LOC = 5003; LESION_SIZE = 5004
    BIOPSY = 5005; RUT = 5006
    PATH_SET = 5020; HISTOLOGY = 5021; LAUREN = 5022; GRADE = 5023; HP_HISTO = 5024
    STAGE_SET = 5040; T_STAGE = 5041; N_STAGE = 5042; M_STAGE = 5043; STAGE_GROUP = 5044; ECOG = 5045
    TX_INTENT = 5060; GASTRECTOMY = 5061; CHEMO = 5062
    OMEPRAZOLE = 6000; AMOX = 6001; CLARI = 6002; METRO = 6003; BISMUTH = 6004; IRON = 6005; ANTACID = 6006
    ACT = 6007; ALBENDAZOLE = 6008; IBUPROFEN = 6009; PARACETAMOL = 6010; METFORMIN = 6011; AMLODIPINE = 6012
    ART = 6013; CAPECITABINE = 6014; OXALIPLATIN = 6015; MORPHINE = 6016
    YES = 7000; POS = 7001; NEG = 7002; INDET = 7003; NO = 7005; UNKNOWN = 7006
    PRESUMED = 7010; CONFIRMED = 7011; PRIMARY = 7012; SECONDARY = 7013
    OUT_HOME = 7020; OUT_REFERRED = 7021; OUT_ADMITTED = 7022; OUT_DIED = 7023
    NEVER = 7030; FORMER = 7031; CURRENT = 7032
    ORD_ENDOSCOPY = 8000; ORD_HP = 8001; ORD_FBC = 8002; ORD_REF_HOSP = 8003; ORD_ONCOLOGY = 8004
    ORD_US = 8005; ORD_CT = 8006


DRUG_ID = {6000 + i: i + 1 for i in range(17)}
