"""mart_cohort_funnel, mart_data_quality, mart_events, mart_kpis (SPEC §11.4)."""
from __future__ import annotations

import json
import json as _json

import polars as pl

from .common import sim_years, to_table


def build_cohort_funnel(con, sim_time, log=print):
    df = con.execute("""
        WITH g AS (SELECT c.patient_id, year(c.entry_date) AS year, p.province_code, c.entry_date FROM core_gi_cohort c
                   JOIN core_dim_patient p USING (patient_id)),
        hp AS (SELECT patient_id, min(datetime) AS t, max((value_coded = 7001)::INT) AS pos FROM core_fact_lab
               WHERE concept_id IN (3120, 3121, 3122, 5006, 5024) GROUP BY 1),
        er AS (SELECT DISTINCT patient_id FROM core_fact_drug WHERE course_type = 'HP_ERADICATION'),
        ref AS (SELECT DISTINCT patient_id FROM core_fact_order WHERE concept_id = 8000),
        sc AS (SELECT DISTINCT patient_id FROM core_fact_endoscopy),
        bx AS (SELECT DISTINCT patient_id FROM core_fact_endoscopy WHERE biopsy = 7000),
        dx AS (SELECT DISTINCT patient_id FROM core_gc_case)
        SELECT g.year, g.province_code, count(*) AS gi_flagged, count(hp.patient_id) AS hp_tested,
               count(*) FILTER (WHERE hp.pos = 1) AS hp_positive,
               count(*) FILTER (WHERE hp.pos = 1 AND er.patient_id IS NOT NULL) AS eradicated,
               count(ref.patient_id) AS referred, count(sc.patient_id) AS scoped, count(bx.patient_id) AS biopsied,
               count(dx.patient_id) AS diagnosed
        FROM g LEFT JOIN hp USING (patient_id) LEFT JOIN er USING (patient_id) LEFT JOIN ref USING (patient_id)
        LEFT JOIN sc USING (patient_id) LEFT JOIN bx USING (patient_id) LEFT JOIN dx USING (patient_id)
        GROUP BY ALL""").pl()
    stages = {"hp": ["gi_flagged", "hp_tested", "hp_positive", "eradicated"],
              "endoscopy": ["gi_flagged", "referred", "scoped", "biopsied", "diagnosed"]}
    rows = []
    variants = [("ALL", "ALL", df.select(pl.exclude("year", "province_code")).sum())]
    for (yr,), sub in df.group_by(["year"]):
        variants.append((str(yr), "ALL", sub.select(pl.exclude("year", "province_code")).sum()))
    for (pv,), sub in df.group_by(["province_code"]):
        variants.append(("ALL", pv, sub.select(pl.exclude("year", "province_code")).sum()))
    for yr, pv, s in variants:
        r = s.row(0, named=True)
        for path, st in stages.items():
            prev = None
            for k in st:
                rows.append({"pathway": path, "stage": k, "year": yr, "province": pv, "n": int(r[k]),
                             "pct_of_prev": None if prev is None else (100 * r[k] / prev if prev else 0.0)})
                prev = r[k]
    to_table(con, "mart_cohort_funnel", pl.DataFrame(rows, infer_schema_length=None))


def build_data_quality(con, sim_time, log=print):
    rows = []

    def add(metric, value, threshold=None, status="info", facility_id=None, district_code=None):
        rows.append({"metric": metric, "facility_id": facility_id, "district_code": district_code, "value": float(value),
                     "threshold": threshold, "status": status})

    q = lambda s: con.execute(s).fetchone()[0]  # noqa: E731
    add("duplicates_merged", q("SELECT count(*) FROM core_patient_link WHERE patient_id <> master_patient_id"))
    add("hb_unit_fixes", q("SELECT count(*) FROM stg_obs WHERE unit_fixed_flag"))
    add("amended_labs_resolved", q("SELECT count(*) FROM stg_obs WHERE amended_flag"))
    add("voided_obs_excluded", q("SELECT count(*) FROM raw_obs WHERE voided = 1"))
    add("encounters_dropped_future_dated", q("SELECT count(*) FROM stg_dq_dropped WHERE reason = 'FUTURE_DATED'"))
    add("encounters_dropped_before_birth", q("SELECT count(*) FROM stg_dq_dropped WHERE reason = 'BEFORE_BIRTH'"))
    add("birthdate_estimated_pct", q("SELECT 100.0 * avg(birthdate_estimated) FROM core_dim_patient"))
    # completeness among GI-cohort patients (per district and national)
    comp = con.execute("""
        SELECT p.district_code, count(*) AS n,
               100.0 * count(*) FILTER (WHERE l.tobacco IS NOT NULL) / count(*) AS smoking,
               100.0 * count(*) FILTER (WHERE l.family_hx IS NOT NULL) / count(*) AS family_hx,
               100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM core_fact_lab x WHERE x.patient_id = g.patient_id
                                                     AND x.concept_id IN (3120, 3121, 3122, 5006, 5024))) / count(*) AS hp_tested
        FROM core_gi_cohort g JOIN core_dim_patient p USING (patient_id) LEFT JOIN core_fact_lifestyle l USING (patient_id)
        GROUP BY ROLLUP (p.district_code)""").fetchall()
    for dc, n, sm, fh, hp in comp:
        for metric, v, thr in (("completeness_smoking_pct", sm, 50), ("completeness_family_hx_pct", fh, 50), ("hp_tested_pct", hp, 30)):
            add(metric, v, thr, "OK" if v >= thr else "LOW", district_code=dc or "RW")
    fac = con.execute("""SELECT location_id, 100.0 * count(*) FILTER (WHERE unit_fixed_flag) / count(*) FROM stg_obs
                         WHERE concept_id = 3100 GROUP BY 1 HAVING count(*) FILTER (WHERE unit_fixed_flag) > 0""").fetchall()
    for loc, v in fac:
        add("hb_gL_units_pct", v, 1.0, "WARN" if v > 1 else "OK", facility_id=loc)
    for r in con.execute("SELECT metric, value, threshold, status FROM dq_raw_results").fetchall():
        add("raw_" + r[0], r[1], r[2], r[3])
    to_table(con, "mart_data_quality", pl.DataFrame(rows, infer_schema_length=None))


def build_events(con, sim_time, log=print):
    df = con.execute("""
        SELECT CAST(e.event_date AS DATE) AS date, e.event_type, replace(e.description, ' (Synthetic)', '') AS label,
               l.district_code AS geo_code, l.province_code, e.location_id
        FROM core_facility_events e JOIN core_dim_location l USING (location_id)
        WHERE e.event_type = 'ENDOSCOPY_OPENED'
        UNION ALL
        SELECT min(CAST(e.event_date AS DATE)), 'EMR_GO_LIVE', 'EMR go-live: ' || d.name, l.district_code, l.province_code, NULL
        FROM core_facility_events e JOIN core_dim_location l USING (location_id) JOIN ref_district d ON d.district_code = l.district_code
        WHERE e.event_type = 'EMR_GO_LIVE' GROUP BY l.district_code, l.province_code, d.name
        ORDER BY 1""").pl()
    to_table(con, "mart_events", df)


def build_kpis(con, sim_time, log=print):
    y_cur, last_full, frac = sim_years(sim_time)
    rows = []
    for y in range(2016, y_cur + 1):
        r = con.execute("""SELECT cases, asr, asr_lci, asr_uci FROM mart_rates WHERE level = 'NATIONAL' AND period = ? AND sex = 'ALL'
                           AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE'""", [str(y)]).fetchone()
        prev = con.execute("""SELECT cases, asr FROM mart_rates WHERE level = 'NATIONAL' AND period = ? AND sex = 'ALL'
                              AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE'""", [str(y - 1)]).fetchone()
        c = con.execute(f"""SELECT 100.0 * count(*) FILTER (WHERE stage_group = 'IV') / nullif(count(*) FILTER (WHERE stage_group <> 'Unknown'), 0),
                                   median(diag_interval_days), avg((age_at_dx < 50)::INT)
                            FROM core_gc_case WHERE year(dx_date) = {y}""").fetchone()
        hp = con.execute(f"""
            WITH d AS (SELECT patient_id, min(dx_datetime) t FROM core_fact_diagnosis WHERE concept_id IN (2014, 2010)
                       AND year(dx_datetime) = {y} GROUP BY 1)
            SELECT avg((EXISTS (SELECT 1 FROM core_fact_lab l WHERE l.patient_id = d.patient_id AND l.concept_id IN (3120, 3121, 3122)
                        AND l.datetime BETWEEN d.t - INTERVAL 1 DAY AND d.t + INTERVAL 90 DAY))::INT) FROM d""").fetchone()[0]
        cases = r[0] if r else 0
        # the current (partial) year is reported year-to-date; its delta compares annualised counts
        ann = cases / frac if (y == y_cur and frac < 0.999) else cases
        rows.append({"year": y, "cases": cases, "cases_annualised": ann,
                     "cases_delta_pct": (100 * (ann - prev[0]) / prev[0]) if prev and prev[0] else None,
                     "national_asr": r[1] if r else None, "national_asr_lci": r[2] if r else None, "national_asr_uci": r[3] if r else None,
                     "asr_delta": (r[1] - prev[1]) if r and prev and r[1] is not None and prev[1] is not None else None,
                     "pct_stage_iv": c[0], "median_diag_interval_days": c[1], "young_onset_share": c[2],
                     "hp_testing_rate_dyspepsia": hp, "partial_year": y == y_cur and frac < 0.999})
    try:
        awaiting = con.execute("""SELECT count(*) FROM pt_risk WHERE risk_band = 'HIGH' AND NOT coalesce(scoped_since_flag, FALSE)""").fetchone()[0]
    except Exception:
        awaiting = None
    df = pl.DataFrame(rows, infer_schema_length=None).with_columns(pl.lit(awaiting).alias("high_risk_awaiting_endoscopy"))
    to_table(con, "mart_kpis", df)
