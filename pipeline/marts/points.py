"""mart_case_points / mart_cohort_points: privacy-preserving points jittered inside the patient's sector polygon
(SPEC §12.5, §18). No patient ids leave this module."""
from __future__ import annotations

import json
import secrets

import numpy as np
import polars as pl
from shapely.geometry import Point, shape
from shapely.prepared import prep

from shared.config import REF_DIR

from .common import to_table

_SECTORS = None


def _sectors():
    global _SECTORS
    if _SECTORS is None:
        raw = json.load(open(REF_DIR / "sectors.json"))
        _SECTORS = {}
        for s in raw:
            g = shape(s["geometry"])
            _SECTORS[(s["district_code"], s["sector"].lower())] = (g, prep(g), g.bounds)
    return _SECTORS


def _jitter(dc, sector, rng):
    s = _sectors().get((dc, (sector or "").lower()))
    if s is None:
        return None, None
    g, pg, (x0, y0, x1, y1) = s
    for _ in range(50):
        x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
        if pg.contains(Point(x, y)):
            return round(y, 4), round(x, 4)
    c = g.representative_point()
    return round(c.y, 4), round(c.x, 4)


def build_points(con, sim_time, log=print):
    rng = np.random.default_rng(secrets.randbits(32))  # fresh jitter each run: points are not re-identifiable over time
    cases = con.execute("""
        SELECT c.district_code, c.dx_date, year(c.dx_date) AS year, c.age_band, c.sex, c.stage_group, c.case_status,
               (SELECT arg_max(a.sector, a.start_date) FROM stg_address a WHERE a.person_id = c.patient_id
                 AND a.start_date <= c.dx_date + INTERVAL 1 DAY) AS sector
        FROM core_gc_case c""").fetchall()
    rows = []
    for dc, _, year, band, sex, stage, status, sector in cases:
        lat, lon = _jitter(dc, sector, rng)
        if lat is None:
            continue
        rows.append({"case_id": secrets.token_hex(6), "lat": lat, "lon": lon, "year": year, "age_band": band, "sex": sex,
                     "stage_group": stage, "case_status": status, "district_code": dc})
    to_table(con, "mart_case_points", pl.DataFrame(rows, infer_schema_length=None))
    try:
        has_risk = con.execute("SELECT count(*) FROM pt_risk").fetchone()[0] > 0
    except Exception:
        has_risk = False
    risk_join = "LEFT JOIN pt_risk r USING (patient_id)" if has_risk else ""
    risk_col = "coalesce(r.risk_band, 'UNSCORED')" if has_risk else "'UNSCORED'"
    coh = con.execute(f"""
        SELECT p.district_code, p.sector, year(g.entry_date) AS entry_year, {risk_col} AS risk_band
        FROM core_gi_cohort g JOIN core_dim_patient p USING (patient_id) {risk_join}
        USING SAMPLE 60000 ROWS""").fetchall()
    rows = []
    for dc, sector, ey, band in coh:
        lat, lon = _jitter(dc, sector, rng)
        if lat is not None:
            rows.append({"lat": lat, "lon": lon, "entry_year": ey, "risk_band": band, "district_code": dc})
    to_table(con, "mart_cohort_points", pl.DataFrame(rows, infer_schema_length=None))
