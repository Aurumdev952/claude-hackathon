"""Landmark features (SPEC §13.4) with leakage exclusions (SPEC §13.3).

Every source row is restricted to datetime <= L. Excluded entirely: endoscopy / pathology / oncology encounters
(types 5, 6, 7) and everything recorded in them, orders 8000/8004/8006, CEA (3108), RUT/histology HP (5006/5024),
diagnoses 2000-2005, chemo/morphine, and any core_gc_case field.
"""
from __future__ import annotations

import pandas as pd

EXCLUDED_ENC_TYPES = (5, 6, 7)
EXCLUDED_ORDERS = (8000, 8004, 8006)
EXCLUDED_LABS = (3108, 5006, 5024)
EXCLUDED_DX = tuple(range(2000, 2006))
EXCLUDED_DRUGS = (6014, 6015, 6016)

NUMERIC = ["age", "sex_male", "district_asr_prior", "home_endoscopy_access", "n_visits_12m", "n_visits_24m",
           "n_gi_visits_6m", "n_gi_visits_12m", "n_gi_visits_24m", "gi_visit_accel", "days_since_last_gi_visit",
           "sx_epigastric", "sx_vomiting", "sx_dysphagia", "sx_weight_loss", "sx_early_satiety", "sx_anorexia", "sx_mass",
           "sx_gi_bleed", "n_alarm_features_12m", "hb_last", "hb_min_12m", "hb_slope_12m", "n_hb_12m", "hb_drop_12m",
           "anaemia_flag", "mcv_last", "ferritin_last", "albumin_last", "platelets_last", "weight_change_pct_6m",
           "weight_change_pct_12m", "bmi_last", "n_ppi_courses_12m", "n_antacid_rx_12m", "iron_rx_12m", "nsaid_regular",
           "ppi_courses_without_resolution", "hp_tested_ever", "hp_positive_ever", "hp_pos_untreated", "hp_eradicated",
           "years_since_hp_pos", "hiv", "diabetes", "hypertension", "ckd", "malaria_dx_12m_while_anaemic",
           "helminth_dx_12m_while_anaemic", "days_in_cohort"]
CATEGORICAL = {"province_code": ["KGL", "NOR", "SOU", "EAS", "WES"], "home_facility_tier": ["low", "medium", "high", "unknown"],
               "tobacco": ["never", "former", "current", "unknown"], "alcohol": ["never", "former", "current", "unknown"],
               "family_hx": ["yes", "no", "unknown"], "high_salt": ["yes", "no", "unknown"], "smoked_food": ["yes", "no", "unknown"],
               "cohort_entry_reason": ["GI_DX", "GI_SYMPTOMS_2X", "HP_TEST", "ENDOSCOPY", "IDA_40PLUS", "GC_DX"]}


def prepare_sources(con):
    """Cohort-restricted, leakage-filtered fact tables (built once per training/scoring run).

    A fact is available from the later of its own time and its encounter's time: a few encounters carry a header date
    years after their observations (planted data-entry noise), and such an encounter is not in the record before its
    header date. Without this a landmark between the two dates would see the encounter early (caught by
    tests/ml/test_leakage.py::test_features_ignore_data_after_landmark)."""
    ex_enc = ",".join(map(str, EXCLUDED_ENC_TYPES))
    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE ml_ok_enc AS
    SELECT e.encounter_id, e.patient_id, e.encounter_datetime AS t, e.encounter_type, e.location_id
    FROM core_fact_encounter e SEMI JOIN core_gi_cohort g USING (patient_id) WHERE e.encounter_type NOT IN ({ex_enc});
    CREATE OR REPLACE TEMP TABLE ml_gi AS SELECT g.* REPLACE (greatest(g.datetime, e.t) AS datetime) FROM core_gi_encounter g JOIN ml_ok_enc e USING (encounter_id);
    CREATE OR REPLACE TEMP TABLE ml_sym AS SELECT s.* REPLACE (greatest(s.datetime, e.t) AS datetime) FROM core_fact_symptom s JOIN ml_ok_enc e USING (encounter_id);
    CREATE OR REPLACE TEMP TABLE ml_dx AS SELECT d.* REPLACE (greatest(d.dx_datetime, e.t) AS dx_datetime) FROM core_fact_diagnosis d JOIN ml_ok_enc e USING (encounter_id)
        WHERE d.concept_id NOT IN ({",".join(map(str, EXCLUDED_DX))});
    CREATE OR REPLACE TEMP TABLE ml_lab AS SELECT l.* REPLACE (greatest(l.datetime, e.t) AS datetime) FROM core_fact_lab l JOIN ml_ok_enc e USING (encounter_id)
        WHERE l.concept_id NOT IN ({",".join(map(str, EXCLUDED_LABS))});
    CREATE OR REPLACE TEMP TABLE ml_vit AS SELECT v.* REPLACE (greatest(v.datetime, e.t) AS datetime) FROM core_fact_vital v JOIN ml_ok_enc e USING (encounter_id);
    CREATE OR REPLACE TEMP TABLE ml_drug AS SELECT d.* REPLACE (greatest(d.datetime, e.t) AS datetime) FROM core_fact_drug d JOIN ml_ok_enc e USING (encounter_id)
        WHERE d.drug_concept_id NOT IN ({",".join(map(str, EXCLUDED_DRUGS))});
    CREATE OR REPLACE TEMP TABLE ml_life AS SELECT o.person_id AS patient_id, o.concept_id, o.value_coded, greatest(o.obs_datetime, e.t) AS t
        FROM stg_obs o JOIN ml_ok_enc e USING (encounter_id) WHERE o.concept_id IN (4000, 4002, 4004, 4005, 4006, 4011);
    """)


FEATURE_SQL = """
CREATE OR REPLACE TABLE {out} AS
WITH lm AS (SELECT patient_id, CAST(L AS DATE) AS L FROM {lm}),
base AS (
  SELECT lm.patient_id, lm.L, date_diff('day', p.birthdate, lm.L) / 365.25 AS age, (p.sex = 'M')::INT AS sex_male,
         p.home_facility_id, g.entry_reason AS cohort_entry_reason, date_diff('day', g.entry_date, lm.L) AS days_in_cohort,
         (SELECT arg_max(a.district_code, a.start_date) FROM stg_address a WHERE a.person_id = lm.patient_id AND a.start_date <= lm.L) AS district_code
  FROM lm JOIN core_dim_patient p USING (patient_id) JOIN core_gi_cohort g USING (patient_id)),
geo AS (
  SELECT b.patient_id, b.L, d.province_code, coalesce(fq.derived_tier, loc.hp_testing_tier, 'unknown') AS home_facility_tier,
         coalesce(ap.asr, (SELECT avg(asr) FROM ml_district_prior)) AS district_asr_prior,
         (EXISTS (SELECT 1 FROM core_dim_location x WHERE x.district_code = b.district_code AND x.endoscopy_from_date <= b.L
                  AND x.facility_type IN ('DISTRICT', 'PROVINCIAL', 'REFERRAL')))::INT AS home_endoscopy_access
  FROM base b LEFT JOIN ref_district d ON d.district_code = b.district_code
  LEFT JOIN core_dim_location loc ON loc.location_id = b.home_facility_id
  LEFT JOIN ml_facility_tier fq ON fq.location_id = b.home_facility_id
  LEFT JOIN ml_district_prior ap ON ap.district_code = b.district_code),
vis AS (
  SELECT lm.patient_id, lm.L,
         count(*) FILTER (WHERE e.t > lm.L - INTERVAL 365 DAY) AS n_visits_12m, count(*) AS n_visits_24m
  FROM lm JOIN ml_ok_enc e ON e.patient_id = lm.patient_id AND e.t <= lm.L + INTERVAL 1 DAY - INTERVAL 1 SECOND
   AND e.t > lm.L - INTERVAL 730 DAY GROUP BY 1, 2),
gi AS (
  SELECT lm.patient_id, lm.L,
         count(*) FILTER (WHERE g.datetime > lm.L - INTERVAL 182 DAY) AS n_gi_visits_6m,
         count(*) FILTER (WHERE g.datetime > lm.L - INTERVAL 365 DAY) AS n_gi_visits_12m,
         count(*) AS n_gi_visits_24m,
         count(*) FILTER (WHERE g.datetime > lm.L - INTERVAL 182 DAY)
           - count(*) FILTER (WHERE g.datetime > lm.L - INTERVAL 365 DAY AND g.datetime <= lm.L - INTERVAL 182 DAY) AS gi_visit_accel,
         date_diff('day', max(g.datetime), lm.L) AS days_since_last_gi_visit
  FROM lm JOIN ml_gi g ON g.patient_id = lm.patient_id AND g.datetime < lm.L + INTERVAL 1 DAY
   AND g.datetime > lm.L - INTERVAL 730 DAY GROUP BY 1, 2),
sx AS (
  SELECT lm.patient_id, lm.L,
         count(*) FILTER (WHERE s.concept_id = 2200) AS sx_epigastric, count(*) FILTER (WHERE s.concept_id = 2202) AS sx_vomiting,
         count(*) FILTER (WHERE s.concept_id = 2203) AS sx_dysphagia, count(*) FILTER (WHERE s.concept_id = 2205) AS sx_weight_loss,
         count(*) FILTER (WHERE s.concept_id = 2204) AS sx_early_satiety, count(*) FILTER (WHERE s.concept_id = 2206) AS sx_anorexia,
         count(*) FILTER (WHERE s.concept_id = 2213) AS sx_mass
  FROM lm JOIN ml_sym s ON s.patient_id = lm.patient_id AND s.datetime < lm.L + INTERVAL 1 DAY
   AND s.datetime > lm.L - INTERVAL 365 DAY GROUP BY 1, 2),
dx AS (
  SELECT lm.patient_id, lm.L,
         count(*) FILTER (WHERE d.concept_id IN (2016, 2017, 2018) AND d.dx_datetime > lm.L - INTERVAL 365 DAY) AS sx_gi_bleed,
         max((d.concept_id = 2101)::INT) AS hiv, max((d.concept_id = 2103)::INT) AS diabetes,
         max((d.concept_id = 2102)::INT) AS hypertension, max((d.concept_id = 2111)::INT) AS ckd
  FROM lm JOIN ml_dx d ON d.patient_id = lm.patient_id AND d.dx_datetime < lm.L + INTERVAL 1 DAY GROUP BY 1, 2),
hb AS (
  SELECT lm.patient_id, lm.L,
         arg_max(l.value_numeric, l.datetime) AS hb_last,
         min(l.value_numeric) FILTER (WHERE l.datetime > lm.L - INTERVAL 365 DAY) AS hb_min_12m,
         regr_slope(l.value_numeric, epoch(l.datetime) / 86400.0) FILTER (WHERE l.datetime > lm.L - INTERVAL 365 DAY) * 30.44 AS hb_slope_12m,
         count(*) FILTER (WHERE l.datetime > lm.L - INTERVAL 365 DAY) AS n_hb_12m,
         max(l.value_numeric) FILTER (WHERE l.datetime > lm.L - INTERVAL 365 DAY) - arg_max(l.value_numeric, l.datetime) AS hb_drop_12m
  FROM lm JOIN ml_lab l ON l.patient_id = lm.patient_id AND l.concept_id = 3100 AND l.datetime < lm.L + INTERVAL 1 DAY
   AND l.datetime > lm.L - INTERVAL 1095 DAY GROUP BY 1, 2),
labs AS (
  SELECT lm.patient_id, lm.L,
         arg_max(l.value_numeric, l.datetime) FILTER (WHERE l.concept_id = 3101) AS mcv_last,
         arg_max(l.value_numeric, l.datetime) FILTER (WHERE l.concept_id = 3102) AS ferritin_last,
         arg_max(l.value_numeric, l.datetime) FILTER (WHERE l.concept_id = 3107) AS albumin_last,
         arg_max(l.value_numeric, l.datetime) FILTER (WHERE l.concept_id = 3104) AS platelets_last,
         max((l.concept_id IN (3120, 3121, 3122))::INT) AS hp_tested_ever,
         max((l.concept_id IN (3120, 3121, 3122) AND l.value_coded = 7001)::INT) AS hp_positive_ever,
         min(l.datetime) FILTER (WHERE l.concept_id IN (3120, 3121, 3122) AND l.value_coded = 7001) AS hp_pos_at
  FROM lm JOIN ml_lab l ON l.patient_id = lm.patient_id AND l.datetime < lm.L + INTERVAL 1 DAY GROUP BY 1, 2),
wt AS (
  SELECT lm.patient_id, lm.L,
         100 * (arg_max(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3000 AND v.datetime > lm.L - INTERVAL 182 DAY)
              - arg_min(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3000 AND v.datetime > lm.L - INTERVAL 182 DAY))
           / nullif(arg_min(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3000 AND v.datetime > lm.L - INTERVAL 182 DAY), 0) AS weight_change_pct_6m,
         100 * (arg_max(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3000)
              - arg_min(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3000))
           / nullif(arg_min(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3000), 0) AS weight_change_pct_12m,
         arg_max(v.value_numeric, v.datetime) FILTER (WHERE v.concept_id = 3002) AS bmi_last
  FROM lm JOIN ml_vit v ON v.patient_id = lm.patient_id AND v.concept_id IN (3000, 3002) AND v.datetime < lm.L + INTERVAL 1 DAY
   AND v.datetime > lm.L - INTERVAL 365 DAY GROUP BY 1, 2),
meds AS (
  SELECT lm.patient_id, lm.L,
         count(*) FILTER (WHERE d.course_type IN ('PPI_COURSE', 'PPI_SHORT') AND d.datetime > lm.L - INTERVAL 365 DAY) AS n_ppi_courses_12m,
         count(*) FILTER (WHERE d.course_type = 'ANTACID' AND d.datetime > lm.L - INTERVAL 365 DAY) AS n_antacid_rx_12m,
         max((d.course_type = 'IRON_THERAPY' AND d.datetime > lm.L - INTERVAL 365 DAY)::INT) AS iron_rx_12m,
         max(d.datetime) FILTER (WHERE d.course_type = 'HP_ERADICATION') AS erad_at,
         list(d.datetime ORDER BY d.datetime) FILTER (WHERE d.course_type IN ('PPI_COURSE', 'PPI_SHORT') AND d.datetime > lm.L - INTERVAL 365 DAY) AS ppi_times
  FROM lm JOIN ml_drug d ON d.patient_id = lm.patient_id AND d.datetime < lm.L + INTERVAL 1 DAY GROUP BY 1, 2),
life AS (
  SELECT lm.patient_id, lm.L,
         arg_max(x.value_coded, x.t) FILTER (WHERE x.concept_id = 4000) AS tob, arg_max(x.value_coded, x.t) FILTER (WHERE x.concept_id = 4002) AS alc,
         arg_max(x.value_coded, x.t) FILTER (WHERE x.concept_id = 4004) AS fam, arg_max(x.value_coded, x.t) FILTER (WHERE x.concept_id = 4005) AS salt,
         arg_max(x.value_coded, x.t) FILTER (WHERE x.concept_id = 4006) AS smk, arg_max(x.value_coded, x.t) FILTER (WHERE x.concept_id = 4011) AS nsaid
  FROM lm JOIN ml_life x ON x.patient_id = lm.patient_id AND x.t < lm.L + INTERVAL 1 DAY GROUP BY 1, 2),
anaemic AS (
  SELECT l.patient_id, l.datetime AS t FROM ml_lab l JOIN core_dim_patient p USING (patient_id)
  WHERE l.concept_id = 3100 AND l.value_numeric < CASE WHEN p.sex = 'M' THEN 13 ELSE 12 END
  UNION ALL SELECT patient_id, dx_datetime FROM ml_dx WHERE concept_id IN (2022, 2023)),
conf AS (
  SELECT lm.patient_id, lm.L,
         max((d.concept_id = 2100)::INT) AS malaria_dx_12m_while_anaemic, max((d.concept_id = 2024)::INT) AS helminth_dx_12m_while_anaemic
  FROM lm JOIN ml_dx d ON d.patient_id = lm.patient_id AND d.concept_id IN (2100, 2024) AND d.dx_datetime < lm.L + INTERVAL 1 DAY
   AND d.dx_datetime > lm.L - INTERVAL 365 DAY
  WHERE EXISTS (SELECT 1 FROM anaemic a WHERE a.patient_id = d.patient_id AND abs(date_diff('day', a.t, d.dx_datetime)) <= 30)
  GROUP BY 1, 2)
SELECT b.patient_id, b.L, b.age, b.sex_male, geo.province_code, geo.home_facility_tier, geo.district_asr_prior,
       geo.home_endoscopy_access,
       coalesce(vis.n_visits_12m, 0) AS n_visits_12m, coalesce(vis.n_visits_24m, 0) AS n_visits_24m,
       coalesce(gi.n_gi_visits_6m, 0) AS n_gi_visits_6m, coalesce(gi.n_gi_visits_12m, 0) AS n_gi_visits_12m,
       coalesce(gi.n_gi_visits_24m, 0) AS n_gi_visits_24m, coalesce(gi.gi_visit_accel, 0) AS gi_visit_accel,
       gi.days_since_last_gi_visit,
       coalesce(sx.sx_epigastric, 0) AS sx_epigastric, coalesce(sx.sx_vomiting, 0) AS sx_vomiting,
       coalesce(sx.sx_dysphagia, 0) AS sx_dysphagia, coalesce(sx.sx_weight_loss, 0) AS sx_weight_loss,
       coalesce(sx.sx_early_satiety, 0) AS sx_early_satiety, coalesce(sx.sx_anorexia, 0) AS sx_anorexia,
       coalesce(sx.sx_mass, 0) AS sx_mass, coalesce(dx.sx_gi_bleed, 0) AS sx_gi_bleed,
       (coalesce(sx.sx_dysphagia, 0) > 0)::INT + (coalesce(sx.sx_weight_loss, 0) > 0)::INT + (coalesce(dx.sx_gi_bleed, 0) > 0)::INT
         + (coalesce(sx.sx_mass, 0) > 0)::INT + (coalesce(sx.sx_vomiting, 0) >= 2)::INT AS n_alarm_features_12m,
       hb.hb_last, hb.hb_min_12m, hb.hb_slope_12m, coalesce(hb.n_hb_12m, 0) AS n_hb_12m, hb.hb_drop_12m,
       CASE WHEN hb.hb_last IS NULL THEN NULL ELSE (hb.hb_last < CASE WHEN b.sex_male = 1 THEN 13 ELSE 12 END)::INT END AS anaemia_flag,
       labs.mcv_last, labs.ferritin_last, labs.albumin_last, labs.platelets_last,
       wt.weight_change_pct_6m, wt.weight_change_pct_12m, wt.bmi_last,
       coalesce(meds.n_ppi_courses_12m, 0) AS n_ppi_courses_12m, coalesce(meds.n_antacid_rx_12m, 0) AS n_antacid_rx_12m,
       coalesce(meds.iron_rx_12m, 0) AS iron_rx_12m, coalesce((life.nsaid = 7000)::INT, 0) AS nsaid_regular,
       (coalesce(meds.n_ppi_courses_12m, 0) >= 2 AND gi.days_since_last_gi_visit IS NOT NULL
        AND (SELECT max(g2.datetime) FROM ml_gi g2 WHERE g2.patient_id = b.patient_id AND g2.datetime < b.L + INTERVAL 1 DAY)
            > list_extract(meds.ppi_times, 2))::INT AS ppi_courses_without_resolution,
       coalesce(labs.hp_tested_ever, 0) AS hp_tested_ever, coalesce(labs.hp_positive_ever, 0) AS hp_positive_ever,
       (coalesce(labs.hp_positive_ever, 0) = 1 AND (meds.erad_at IS NULL OR meds.erad_at < labs.hp_pos_at - INTERVAL 7 DAY)
        AND labs.hp_pos_at < b.L - INTERVAL 30 DAY)::INT AS hp_pos_untreated,
       (meds.erad_at IS NOT NULL AND coalesce(labs.hp_positive_ever, 0) = 1)::INT AS hp_eradicated,
       CASE WHEN labs.hp_pos_at IS NOT NULL THEN date_diff('day', labs.hp_pos_at, b.L) / 365.25 END AS years_since_hp_pos,
       CASE life.tob WHEN 7030 THEN 'never' WHEN 7031 THEN 'former' WHEN 7032 THEN 'current' ELSE 'unknown' END AS tobacco,
       CASE life.alc WHEN 7030 THEN 'never' WHEN 7031 THEN 'former' WHEN 7032 THEN 'current' ELSE 'unknown' END AS alcohol,
       CASE life.fam WHEN 7000 THEN 'yes' WHEN 7005 THEN 'no' ELSE 'unknown' END AS family_hx,
       CASE life.salt WHEN 7000 THEN 'yes' WHEN 7005 THEN 'no' ELSE 'unknown' END AS high_salt,
       CASE life.smk WHEN 7000 THEN 'yes' WHEN 7005 THEN 'no' ELSE 'unknown' END AS smoked_food,
       coalesce(dx.hiv, 0) AS hiv, coalesce(dx.diabetes, 0) AS diabetes, coalesce(dx.hypertension, 0) AS hypertension,
       coalesce(dx.ckd, 0) AS ckd, coalesce(conf.malaria_dx_12m_while_anaemic, 0) AS malaria_dx_12m_while_anaemic,
       coalesce(conf.helminth_dx_12m_while_anaemic, 0) AS helminth_dx_12m_while_anaemic,
       b.cohort_entry_reason, b.days_in_cohort
FROM base b JOIN geo USING (patient_id, L) LEFT JOIN vis USING (patient_id, L) LEFT JOIN gi USING (patient_id, L)
LEFT JOIN sx USING (patient_id, L) LEFT JOIN dx USING (patient_id, L) LEFT JOIN hb USING (patient_id, L)
LEFT JOIN labs USING (patient_id, L) LEFT JOIN wt USING (patient_id, L) LEFT JOIN meds USING (patient_id, L)
LEFT JOIN life USING (patient_id, L) LEFT JOIN conf USING (patient_id, L)
"""


def build_feature_table(con, lm_df: pd.DataFrame, out: str = "ml_features") -> pd.DataFrame:
    con.register("_lm", lm_df[["patient_id", "L"]])
    con.execute(FEATURE_SQL.format(out=out, lm="_lm"))
    con.unregister("_lm")
    df = con.execute(f"SELECT * FROM {out}").df()
    df["L"] = pd.to_datetime(df["L"]).astype("datetime64[ns]")
    return df


def design_matrix(df: pd.DataFrame) -> pd.DataFrame:
    X = df[NUMERIC].astype(float).copy()
    for col, levels in CATEGORICAL.items():
        v = df[col].fillna("unknown").astype(str)
        for lvl in levels:
            X[f"{col}={lvl}"] = (v == lvl).astype(float)
    return X
