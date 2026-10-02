"""OpenMRS reference/dictionary tables built from concepts.yaml and the synthetic facilities (SPEC §6–§7)."""
from __future__ import annotations

import uuid

import polars as pl

from shared.concepts import concepts

from .dates import to_date

DATATYPE_ID = {"Numeric": 1, "Coded": 2, "Text": 3, "N/A": 4, "Datetime": 8}
DATATYPES = [(1, "Numeric", "NM"), (2, "Coded", "CWE"), (3, "Text", "ST"), (4, "N/A", "ZZ"), (6, "Date", "DT"), (8, "Datetime", "TS")]
CLASS_ID = {"Test": 1, "Procedure": 2, "Drug": 3, "Diagnosis": 4, "Finding": 5, "Question": 7, "ConvSet": 10, "Misc": 11, "Symptom": 12}
ENCOUNTER_TYPES = [(1, "ADULTINITIAL"), (2, "OPD_CONSULTATION"), (3, "ADULTRETURN"), (4, "LAB_RESULTS"), (5, "ENDOSCOPY"),
                   (6, "PATHOLOGY"), (7, "ONCOLOGY_INTAKE"), (8, "ADMISSION"), (9, "DISCHARGE"), (10, "PHARMACY_DISPENSE"),
                   (11, "ANC / MCH"), (12, "HIV_FOLLOWUP"), (13, "NCD_FOLLOWUP"), (14, "DEATH"),
                   (15, "CARE_COORDINATION"), (16, "PATIENT_REPORTED"), (17, "CHW_HOME_VISIT")]  # 15-17: v3 (D-45)
LOCALISED = {2100: [("rw", "Malariya"), ("fr", "Paludisme")], 2200: [("rw", "Kuribwa mu gifu"), ("fr", "Douleur épigastrique")],
             2014: [("fr", "Dyspepsie")], 2000: [("fr", "Cancer de l'estomac, sans précision")], 3100: [("fr", "Hémoglobine")],
             2205: [("rw", "Gutakaza ibiro")], 2203: [("fr", "Dysphagie")]}


def _u(ns: str, k) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"early-signals/{ns}/{k}"))


def build(facs: list[dict]) -> dict[str, pl.DataFrame]:
    cs = concepts()
    T: dict[str, list] = {k: [] for k in ("concept", "concept_name", "concept_numeric", "concept_answer",
                                          "concept_reference_term", "concept_reference_map")}
    term_id = 1
    for cid, c in sorted(cs.items()):
        dt = c.get("datatype") or "N/A"
        cls = c.get("class")
        T["concept"].append((cid, DATATYPE_ID.get(dt, 4), CLASS_ID.get(cls, 11), int(c.get("is_set", 0)), 0, _u("concept", cid)))
        T["concept_name"].append((cid, c["name"], "en", "FULLY_SPECIFIED", 1, _u("cname", cid)))
        for loc, nm in LOCALISED.get(cid, []):
            T["concept_name"].append((cid, nm, loc, "FULLY_SPECIFIED", 1, _u("cname", f"{cid}{loc}")))
        if dt == "Numeric":
            T["concept_numeric"].append((cid, None, None, c.get("hi_normal"), c.get("low_normal"), c.get("units")))
        for j, a in enumerate(c.get("answers", []) or []):
            T["concept_answer"].append((cid, a, float(j), _u("answer", f"{cid}-{a}")))
        if c.get("icd10"):
            T["concept_reference_term"].append((term_id, 1, c["icd10"], c["name"], _u("term", term_id)))
            T["concept_reference_map"].append((cid, term_id, "SAME-AS", _u("map", term_id)))
            term_id += 1
    frames = {
        "concept": pl.DataFrame(T["concept"], schema=["concept_id", "datatype_id", "class_id", "is_set", "retired", "uuid"], orient="row"),
        "concept_name": pl.DataFrame(T["concept_name"], schema=["concept_id", "name", "locale", "concept_name_type", "locale_preferred", "uuid"], orient="row"),
        "concept_numeric": pl.DataFrame(T["concept_numeric"], schema={"concept_id": pl.Int64, "hi_absolute": pl.Float64, "low_absolute": pl.Float64,
                                                                     "hi_normal": pl.Float64, "low_normal": pl.Float64, "units": pl.Utf8}, orient="row"),
        "concept_answer": pl.DataFrame(T["concept_answer"], schema=["concept_id", "answer_concept", "sort_weight", "uuid"], orient="row"),
        "concept_reference_term": pl.DataFrame(T["concept_reference_term"], schema=["concept_reference_term_id", "concept_source_id", "code", "name", "uuid"], orient="row"),
        "concept_reference_map": pl.DataFrame(T["concept_reference_map"], schema=["concept_id", "concept_reference_term_id", "map_type", "uuid"], orient="row"),
        "concept_datatype": pl.DataFrame([(i, n, h, _u("dt", i)) for i, n, h in DATATYPES], schema=["concept_datatype_id", "name", "hl7_abbreviation", "uuid"], orient="row"),
        "concept_class": pl.DataFrame([(i, n, _u("cls", i)) for n, i in CLASS_ID.items()], schema=["concept_class_id", "name", "uuid"], orient="row"),
        "concept_reference_source": pl.DataFrame([(1, "ICD-10-WHO", "I10", _u("src", 1)), (2, "LOINC", "LN", _u("src", 2)), (3, "SNOMED CT", "SCT", _u("src", 3))],
                                                 schema=["concept_source_id", "name", "hl7_code", "uuid"], orient="row"),
        "encounter_type": pl.DataFrame([(i, n, _u("et", i)) for i, n in ENCOUNTER_TYPES], schema=["encounter_type_id", "name", "uuid"], orient="row"),
        "visit_type": pl.DataFrame([(1, "Outpatient", _u("vt", 1)), (2, "Inpatient", _u("vt", 2)), (3, "Emergency", _u("vt", 3))], schema=["visit_type_id", "name", "uuid"], orient="row"),
        "order_type": pl.DataFrame([(1, "Drug Order", _u("ot", 1)), (2, "Test Order", _u("ot", 2)), (3, "Referral Order", _u("ot", 3))], schema=["order_type_id", "name", "uuid"], orient="row"),
        "program": pl.DataFrame([(1, 2101, "HIV Care", _u("pg", 1)), (2, 2102, "NCD (HTN/DM)", _u("pg", 2)), (3, 2000, "Oncology", _u("pg", 3)), (4, 2104, "TB", _u("pg", 4))],
                                schema=["program_id", "concept_id", "name", "uuid"], orient="row"),
        "person_attribute_type": pl.DataFrame([(1, "Telephone Number", "java.lang.String", _u("pat", 1)), (2, "Ubudehe Category", "java.lang.String", _u("pat", 2)),
                                               (3, "Health Insurance", "java.lang.String", _u("pat", 3))],
                                              schema=["person_attribute_type_id", "name", "format", "uuid"], orient="row"),
        "patient_identifier_type": pl.DataFrame([(1, "OpenMRS ID", _u("pit", 1)), (2, "Synthetic National ID", _u("pit", 2))],
                                                schema=["patient_identifier_type_id", "name", "uuid"], orient="row"),
        "drug": pl.DataFrame([(c["drug_id"], cid, c["name"], c.get("strength"), _u("drug", cid)) for cid, c in sorted(cs.items()) if c["group"] == "drugs"],
                             schema=["drug_id", "concept_id", "name", "strength", "uuid"], orient="row"),
        "location": pl.DataFrame([(f["location_id"], f["name"], f["facility_type"].replace("_", " ").title(), f["province"], f["district"], f["sector"],
                                   str(f["lat"]), str(f["lon"]), f["parent_location"], 0, _u("loc", f["location_id"])) for f in facs],
                                 schema={"location_id": pl.Int64, "name": pl.Utf8, "description": pl.Utf8, "state_province": pl.Utf8,
                                         "county_district": pl.Utf8, "address3": pl.Utf8, "latitude": pl.Utf8, "longitude": pl.Utf8,
                                         "parent_location": pl.Int64, "retired": pl.Int64, "uuid": pl.Utf8}, orient="row"),
        "location_ext": pl.DataFrame([(f["location_id"], f["facility_type"], f["district_code"],
                                       to_date(f["endoscopy_from"]).year if f["endoscopy_from"] else None, f["hp_testing_tier"]) for f in facs],
                                     schema={"location_id": pl.Int64, "facility_type": pl.Utf8, "district_code": pl.Utf8,
                                             "endoscopy_from_year": pl.Int64, "hp_testing_tier": pl.Utf8}, orient="row"),
    }
    return frames
