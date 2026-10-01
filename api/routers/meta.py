"""Health, status, filters, geography, events, data quality (SPEC §14.2, any role)."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends

from shared.config import ROOT, SIM_STATE_DIR

from ..deps import SERVE, APIError, Role, envelope, role

router = APIRouter()
GEO_DIR = ROOT / "frontend" / "public" / "geo"


@router.get("/health")
def health():
    return {"status": "ok" if SERVE.ready else "starting", "active": (SERVE.current or {}).get("active"), "meta": SERVE.meta()}


@router.get("/status")
def status(r: Role = Depends(role)):
    run = SERVE.one("SELECT run_id, started_at, finished_at, status, sim_time, steps, row_deltas FROM pipeline_run_log "
                    "ORDER BY run_id DESC LIMIT 1") if SERVE.ready else None
    tick = None
    try:
        tick = json.load(open(SIM_STATE_DIR / "last_tick.json"))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    dq = SERVE.rows("SELECT metric, value, threshold, level, status FROM dq_mart_results") if SERVE.ready else []
    control = {}
    try:
        control = json.load(open(SIM_STATE_DIR / "control.json"))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return envelope({"pipeline": run, "simulator": tick, "control": control, "dq": dq})


@router.get("/meta/filters")
def filters(r: Role = Depends(role)):
    def build():
        years = [int(x["period"]) for x in SERVE.rows("SELECT DISTINCT period FROM mart_rates WHERE period_type = 'YEAR' ORDER BY 1")]
        pooled = [x["period"] for x in SERVE.rows("SELECT DISTINCT period FROM mart_rates WHERE period_type <> 'YEAR' ORDER BY 1")]
        districts = SERVE.rows("SELECT district_code, name, province_code, province FROM ref_district ORDER BY province_code, name")
        facilities = SERVE.rows("""SELECT location_id, name, facility_type, district_code, hp_testing_tier FROM core_dim_location
                                   ORDER BY facility_type, name""")
        return {"years": years, "pooled_periods": pooled, "districts": districts, "facilities": facilities,
                "sex": ["ALL", "M", "F"], "age_band": ["ALL", "<50", "50-64", "65+"], "case_def": ["CONFIRMED_PROBABLE", "CONFIRMED"],
                "level": ["NATIONAL", "PROVINCE", "DISTRICT"]}
    return envelope(SERVE.cached(("filters",), build))


@router.get("/geo/provinces")
def geo_provinces():
    return json.load(open(GEO_DIR / "provinces.geojson"))


@router.get("/geo/districts")
def geo_districts():
    return json.load(open(GEO_DIR / "districts.geojson"))


@router.get("/events")
def events(r: Role = Depends(role)):
    return envelope(SERVE.rows("SELECT * FROM mart_events ORDER BY date"))


@router.get("/data-quality")
def data_quality(r: Role = Depends(role)):
    rows = SERVE.rows("SELECT * FROM mart_data_quality")
    if r.role == "doctor":
        rows = [x for x in rows if x["facility_id"] in (None, r.facility_id)]
    return envelope(rows)


@router.get("/facilities/alert-summary")
def facility_alert_summary():
    """Aggregate open-alert counts per facility (no patient data) - helps a doctor pick their facility in the demo.
    No role dependency: the doctor calls it before choosing a facility, so it has no X-Facility-Id yet."""
    if not SERVE.has_table("pt_alerts"):
        return envelope([])
    return envelope(SERVE.rows("""
        SELECT f.facility_id AS location_id, l.name, l.facility_type, l.district_code,
               count(DISTINCT a.alert_id) FILTER (WHERE a.severity = 'HIGH') AS high_alerts, count(DISTINCT a.alert_id) AS alerts,
               count(DISTINCT f.patient_id) AS cohort_patients
        FROM pt_patient_facility f JOIN core_dim_location l ON l.location_id = f.facility_id
        LEFT JOIN pt_alerts a ON a.patient_id = f.patient_id
        GROUP BY ALL ORDER BY high_alerts DESC, alerts DESC"""))
