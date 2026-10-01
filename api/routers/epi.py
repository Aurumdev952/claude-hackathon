"""Ministry (aggregate) endpoints - SPEC §14.2. Patient-identifying fields never leave these routes."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query

from ..deps import SERVE, APIError, Role, envelope, ministry, parse_json, role

router = APIRouter()
SEX = ("ALL", "M", "F")
BANDS = ("ALL", "<50", "50-64", "65+")
CASE_DEFS = ("CONFIRMED", "CONFIRMED_PROBABLE")
LEVELS = ("NATIONAL", "PROVINCE", "DISTRICT")


def _check(value, allowed, name):
    if value not in allowed:
        raise APIError(400, "INVALID_FILTER", f"{name} must be one of {list(allowed)}", {name: value})
    return value


def m(r: Role = Depends(role)) -> Role:
    return ministry(r)


@router.get("/kpis")
def kpis(year: int | None = None, r: Role = Depends(m)):
    rows = SERVE.cached(("kpis",), lambda: SERVE.rows("SELECT * FROM mart_kpis ORDER BY year"))
    if not rows:
        raise APIError(404, "NO_DATA", "No KPIs published")
    y = year or rows[-1]["year"]
    row = next((x for x in rows if x["year"] == y), None)
    if row is None:
        raise APIError(400, "INVALID_FILTER", f"No KPIs for year {y}", {"year": y})
    spark = {k: [{"year": x["year"], "value": x[k]} for x in rows]
             for k in ("cases_annualised", "national_asr", "pct_stage_iv", "median_diag_interval_days", "hp_testing_rate_dyspepsia",
                       "young_onset_share")}
    data = {**row, "national_asr_ci": [row["national_asr_lci"], row["national_asr_uci"]], "sparklines": spark,
            "years": [x["year"] for x in rows]}
    return envelope(data)


@router.get("/rates")
def rates(level: str = "NATIONAL", geo_code: str | None = None, sex: str = "ALL", age_band: str = "ALL",
          case_def: str = "CONFIRMED_PROBABLE", period_type: str = "YEAR", year_from: int | None = None, year_to: int | None = None,
          r: Role = Depends(m)):
    _check(level, LEVELS, "level"), _check(sex, SEX, "sex"), _check(age_band, BANDS, "age_band"), _check(case_def, CASE_DEFS, "case_def")
    q = """SELECT level, geo_code, period, period_type, sex, age_band, case_def, cases, population, crude_rate, asr, asr_lci, asr_uci,
                  suppressed, coverage_flag, partial_year FROM mart_rates
           WHERE level = ? AND sex = ? AND age_band = ? AND case_def = ? AND period_type = ?"""
    p = [level, sex, age_band, case_def, period_type]
    if geo_code:
        q += " AND geo_code = ?"
        p.append(geo_code)
    rows = SERVE.rows(q + " ORDER BY geo_code, period", p)
    if period_type == "YEAR":
        rows = [x for x in rows if (year_from is None or int(x["period"]) >= year_from) and (year_to is None or int(x["period"]) <= year_to)]
    return envelope([_suppress(x) for x in rows])


def _suppress(x: dict) -> dict:
    """Small cells (< 5 cases) are suppressed for the ministry role (SPEC §18)."""
    if x.get("suppressed"):
        return {**x, "cases": None, "cases_label": "<5"}
    return x


@router.get("/rates/map")
def rates_map(level: str = "DISTRICT", period: str | None = None, period_type: str = "POOLED3", metric: str = "asr",
              sex: str = "ALL", age_band: str = "ALL", case_def: str = "CONFIRMED_PROBABLE", r: Role = Depends(m)):
    _check(level, ("PROVINCE", "DISTRICT"), "level")
    _check(metric, ("asr", "crude_rate", "sir", "lisa_quadrant", "hp_test_rate", "pct_stage4", "cases"), "metric")
    if period is None:
        periods = SERVE.rows("SELECT DISTINCT period FROM mart_rates WHERE period_type = ? ORDER BY period", [period_type])
        if not periods:
            raise APIError(400, "INVALID_FILTER", "Unknown period_type", {"period_type": period_type})
        period = max((p["period"] for p in periods), key=lambda s: s.split("-")[-1]) if period_type != "YEAR" else periods[-1]["period"]
    rows = SERVE.rows(f"""
        SELECT r.geo_code, coalesce(d.name, p.name) AS name, r.cases, r.population, r.crude_rate, r.asr, r.asr_lci, r.asr_uci,
               r.suppressed, r.coverage_flag
        FROM mart_rates r LEFT JOIN ref_district d ON d.district_code = r.geo_code
        LEFT JOIN (SELECT DISTINCT province_code, province AS name FROM ref_district) p ON p.province_code = r.geo_code
        WHERE r.level = ? AND r.period = ? AND r.sex = ? AND r.age_band = ? AND r.case_def = ?""",
                      [level, period, sex, age_band, case_def])
    if level == "DISTRICT":
        sp = {x["district_code"]: x for x in SERVE.rows("SELECT * FROM mart_spatial")}
        fq = {x["district_code"]: x for x in SERVE.rows("""
            SELECT district_code, 100.0 * sum(n_hp_tested) / nullif(sum(n_dyspepsia), 0) AS hp_test_rate FROM mart_facility_quality GROUP BY 1""")}
        st = {x["geo_code"]: x for x in SERVE.rows("""
            SELECT geo_code, sum(n) FILTER (WHERE stage_group = 'IV') * 100.0 / nullif(sum(n) FILTER (WHERE stage_group <> 'Unknown'), 0) AS pct_stage4
            FROM mart_stage_mix WHERE level = 'DISTRICT' AND year = 'ALL' AND facility_tier = 'ALL' GROUP BY 1""")}
        for x in rows:
            s = sp.get(x["geo_code"], {})
            x.update({"lisa_quadrant": s.get("lisa_quadrant"), "sir": s.get("sir"), "gi_star_z": s.get("gi_star_z"),
                      "eb_smoothed_rate": s.get("eb_smoothed_rate"), "hp_test_rate": fq.get(x["geo_code"], {}).get("hp_test_rate"),
                      "pct_stage4": st.get(x["geo_code"], {}).get("pct_stage4")})
    rows = [_suppress(x) for x in rows]
    vals = sorted(x[metric] for x in rows if isinstance(x.get(metric), (int, float)))
    for i, x in enumerate(sorted(rows, key=lambda z: -(z.get(metric) or -1) if isinstance(z.get(metric), (int, float)) else 1)):
        x["rank"] = i + 1
    nat = SERVE.one("""SELECT asr, crude_rate FROM mart_rates WHERE level = 'NATIONAL' AND period = ? AND sex = ? AND age_band = ?
                       AND case_def = ?""", [period, sex, age_band, case_def]) or {}
    unit = {"asr": "per 100,000", "crude_rate": "per 100,000", "sir": "ratio", "hp_test_rate": "%", "pct_stage4": "%",
            "cases": "cases", "lisa_quadrant": "category"}[metric]
    return envelope(rows, legend={"metric": metric, "unit": unit, "min": vals[0] if vals else None, "max": vals[-1] if vals else None,
                                  "national": nat.get(metric if metric in ("asr", "crude_rate") else "asr"), "period": period})


@router.get("/trends/joinpoint")
def joinpoint(series_id: str = "NATIONAL|ALL|ALL|CONFIRMED_PROBABLE", r: Role = Depends(m)):
    rows = SERVE.rows("SELECT * FROM mart_joinpoint WHERE series_id = ? ORDER BY segment_no", [series_id])
    if not rows:
        raise APIError(404, "UNKNOWN_SERIES", f"No joinpoint series {series_id}",
                       {"available": [x["series_id"] for x in SERVE.rows("SELECT DISTINCT series_id FROM mart_joinpoint ORDER BY 1")]})
    f = rows[0]
    segs = [{k: x[k] for k in ("segment_no", "start_year", "end_year", "apc", "apc_lci", "apc_uci", "significant")} for x in rows
            if x["segment_no"]]
    return envelope({"series_id": series_id, "observed": parse_json(f["observed_json"]), "fitted": parse_json(f["fitted_json"]),
                     "segments": segs, "aapc_last10": {"value": f["aapc_last10"], "lci": f["aapc_lci"], "uci": f["aapc_uci"]},
                     "n_joinpoints": f["n_joinpoints"], "events": parse_json(f["events_json"])})


@router.get("/trends/series")
def series(r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT DISTINCT series_id, level, geo_code, sex, age_band, case_def FROM mart_joinpoint ORDER BY 1"))


@router.get("/trends/surface")
def surface(case_def: str = "CONFIRMED_PROBABLE", r: Role = Depends(m)):
    """Rate landscape for the Three.js surface: year x age group -> age-specific rate per 100k (national)."""
    rows = SERVE.rows("SELECT * FROM mart_rate_surface WHERE case_def = ? ORDER BY year, age_index", [case_def]) \
        if SERVE.has_table("mart_rate_surface") else []
    return envelope(rows)


@router.get("/spatial")
def spatial(r: Role = Depends(m)):
    rows = SERVE.rows("SELECT * FROM mart_spatial ORDER BY district_code")
    g = next((x for x in rows if x["district_code"] == "RW"), {})
    return envelope({"districts": [x for x in rows if x["district_code"] != "RW"],
                     "global": {"morans_i": g.get("global_morans_i"), "p": g.get("global_p"), "period": g.get("period")}})


@router.get("/points/cases")
def points_cases(year_from: int | None = None, year_to: int | None = None, r: Role = Depends(m)):
    q, p = "SELECT lat, lon, year, age_band, sex, stage_group FROM mart_case_points WHERE 1=1", []
    if year_from:
        q += " AND year >= ?"
        p.append(year_from)
    if year_to:
        q += " AND year <= ?"
        p.append(year_to)
    return envelope(SERVE.rows(q, p))


@router.get("/points/cohort")
def points_cohort(r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT lat, lon, entry_year, risk_band FROM mart_cohort_points"))


@router.get("/characteristics")
def characteristics(r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT * FROM mart_characteristics ORDER BY variable, \"group\", level"))


@router.get("/stage-mix")
def stage_mix(level: str = "NATIONAL", geo_code: str = "RW", by: str = "year", r: Role = Depends(m)):
    if by == "tier":
        rows = SERVE.rows("""SELECT facility_tier, stage_group, n, pct, pct_known FROM mart_stage_mix WHERE level = ? AND geo_code = ?
                             AND year = 'ALL' AND facility_tier <> 'ALL' ORDER BY 1, 2""", [level, geo_code])
        test = SERVE.one("SELECT * FROM mart_stage_tier_test") if SERVE.has_table("mart_stage_tier_test") else None
        return envelope(rows, chi_square=test)
    return envelope(SERVE.rows("""SELECT year, stage_group, n, pct, pct_known FROM mart_stage_mix WHERE level = ? AND geo_code = ?
                                  AND facility_tier = 'ALL' AND year <> 'ALL' ORDER BY 1, 2""", [level, geo_code]))


@router.get("/warning-signs/curves")
def warning_curves(r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT * FROM mart_prediag_signals ORDER BY metric, \"group\", month_before"))


@router.get("/warning-signs/or")
def warning_or(r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT * FROM mart_signal_or"), summary=SERVE.rows("SELECT * FROM mart_warning_summary"))


@router.get("/diag-interval")
def diag_interval(group_var: str | None = None, r: Role = Depends(m)):
    q, p = "SELECT * FROM mart_diag_interval", []
    if group_var:
        q += " WHERE group_var = ?"
        p.append(group_var)
    return envelope(SERVE.rows(q + " ORDER BY group_var, \"group\"", p))


@router.get("/facilities/quality")
def facility_quality(r: Role = Depends(m)):
    return envelope(SERVE.rows("""SELECT location_id, name, district_code, province_code, facility_type, tier, derived_tier, lat, lon,
                                         n_dyspepsia, n_hp_tested, hp_test_rate, funnel_lower95, funnel_upper95, funnel_lower998,
                                         funnel_upper998, outlier_flag, target_rate, n_cases, pct_stage4, median_diag_interval
                                  FROM mart_facility_quality ORDER BY n_dyspepsia DESC"""))


@router.get("/survival/km")
def survival_km(group_var: str = "stage", r: Role = Depends(m)):
    rows = SERVE.rows("SELECT * FROM mart_survival_km WHERE group_var = ? ORDER BY group_value, t_days", [group_var])
    if not rows:
        raise APIError(400, "INVALID_FILTER", "Unknown group_var",
                       {"available": [x["group_var"] for x in SERVE.rows("SELECT DISTINCT group_var FROM mart_survival_km")]})
    return envelope(rows)


@router.get("/survival/summary")
def survival_summary(group_var: str | None = None, r: Role = Depends(m)):
    q, p = "SELECT * FROM mart_survival_summary", []
    if group_var:
        q += " WHERE group_var = ?"
        p.append(group_var)
    return envelope(SERVE.rows(q, p))


@router.get("/survival/cox")
def survival_cox(r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT * FROM mart_cox ORDER BY model_id, term"))


@router.get("/cohort/funnel")
def cohort_funnel(year: str = "ALL", province: str = "ALL", r: Role = Depends(m)):
    return envelope(SERVE.rows("SELECT * FROM mart_cohort_funnel WHERE year = ? AND province = ? ORDER BY pathway",
                               [year, province]))


@router.get("/warning-signs/journey")
def journey(r: Role = Depends(m)):
    """Anonymous sample of ~200 cases' events by month before diagnosis (journey helix, SPEC §16.3 V4)."""
    rows = SERVE.rows("SELECT case_index, month_before, kind, is_abnormal, stage_group FROM mart_journey_events") \
        if SERVE.has_table("mart_journey_events") else []
    return envelope(rows)
