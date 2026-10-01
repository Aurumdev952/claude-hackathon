-- SPEC §8.7 GI-flagged cohort (earliest qualifying date + reason)
CREATE OR REPLACE TABLE core_gi_cohort AS
WITH gi_cc AS (SELECT patient_id, encounter_id, datetime FROM core_fact_symptom
               WHERE concept_id IN (2200, 2201, 2202, 2203, 2204, 2205, 2206, 2211, 2212, 2213)),
gi_cc_enc AS (SELECT patient_id, encounter_id, min(datetime) AS t FROM gi_cc GROUP BY 1, 2),
sym2 AS (SELECT a.patient_id, min(b.t) AS t FROM gi_cc_enc a JOIN gi_cc_enc b ON a.patient_id = b.patient_id
         AND b.encounter_id <> a.encounter_id AND b.t > a.t AND b.t <= a.t + INTERVAL 365 DAY GROUP BY 1),
ev AS (
  SELECT patient_id, dx_datetime AS t, 'GI_DX' AS reason, location_id FROM core_fact_diagnosis WHERE concept_id BETWEEN 2010 AND 2021
  UNION ALL SELECT s.patient_id, s.t, 'GI_SYMPTOMS_2X', NULL FROM sym2 s
  UNION ALL SELECT patient_id, datetime, 'HP_TEST', location_id FROM core_fact_lab WHERE concept_id IN (3120, 3121, 3122, 5006, 5024)
  UNION ALL SELECT patient_id, datetime, 'HP_TEST', location_id FROM core_fact_order WHERE concept_id = 8001
  UNION ALL SELECT patient_id, encounter_datetime, 'ENDOSCOPY', location_id FROM core_fact_encounter WHERE encounter_type = 5
  UNION ALL SELECT patient_id, datetime, 'ENDOSCOPY', location_id FROM core_fact_order WHERE concept_id = 8000
  UNION ALL SELECT d.patient_id, d.dx_datetime, 'IDA_40PLUS', d.location_id FROM core_fact_diagnosis d
            JOIN core_dim_patient p USING (patient_id) WHERE d.concept_id = 2022 AND date_diff('year', p.birthdate, d.dx_datetime) >= 40
  UNION ALL SELECT patient_id, dx_datetime, 'GC_DX', location_id FROM core_fact_diagnosis WHERE concept_id BETWEEN 2000 AND 2005
)
SELECT patient_id, CAST(min(t) AS DATE) AS entry_date, arg_min(reason, t) AS entry_reason,
       coalesce(arg_min(location_id, t),
                (SELECT arg_min(g.location_id, g.datetime) FROM core_gi_encounter g WHERE g.patient_id = ev.patient_id)) AS entry_facility_id
FROM ev GROUP BY patient_id;

-- SPEC §11.3 gastric cancer cases (one row per patient)
CREATE OR REPLACE TABLE core_gc_case AS
WITH histo AS (SELECT patient_id, min(datetime) AS t, arg_min(location_id, datetime) AS loc,
                      arg_min(lauren, datetime) AS lauren_code FROM core_fact_pathology WHERE histology = 7130 GROUP BY 1),
c16 AS (SELECT patient_id, min(dx_datetime) AS t, arg_min(location_id, dx_datetime) AS loc
        FROM core_fact_diagnosis WHERE concept_id BETWEEN 2000 AND 2004 GROUP BY 1),
cases AS (
  SELECT coalesce(h.patient_id, c.patient_id) AS patient_id,
         CASE WHEN h.patient_id IS NOT NULL THEN 'CONFIRMED' ELSE 'PROBABLE' END AS case_status,
         CAST(coalesce(h.t, c.t) AS DATE) AS dx_date, coalesce(h.loc, c.loc) AS diag_facility_id, h.lauren_code
  FROM histo h FULL OUTER JOIN c16 c USING (patient_id)
),
base AS (
  SELECT k.*, p.sex, p.birthdate, date_diff('year', p.birthdate, k.dx_date) AS age_at_dx,
         (SELECT arg_max(a.district_code, a.start_date) FROM stg_address a WHERE a.person_id = k.patient_id AND a.start_date <= k.dx_date + INTERVAL 1 DAY) AS dc_at,
         p.district_code AS dc_now, p.death_date, p.last_encounter_date
  FROM cases k JOIN core_dim_patient p USING (patient_id)
),
gi24 AS (SELECT b.patient_id, count(DISTINCT g.encounter_id) AS n_gi, min(g.datetime) AS first_gi,
                arg_min(g.location_id, g.datetime) AS first_gi_loc
         FROM base b JOIN core_gi_encounter g ON g.patient_id = b.patient_id
          AND g.datetime >= b.dx_date - INTERVAL 730 DAY AND g.datetime < b.dx_date
         GROUP BY 1),
hb AS (SELECT b.patient_id,
              CASE WHEN count(*) >= 2 THEN max(l.value_numeric) - min(CASE WHEN l.datetime >= b.dx_date - INTERVAL 365 DAY THEN l.value_numeric END) END AS hb_drop
       FROM base b JOIN core_fact_lab l ON l.patient_id = b.patient_id AND l.concept_id = 3100
        AND l.datetime >= b.dx_date - INTERVAL 730 DAY AND l.datetime <= b.dx_date GROUP BY 1),
first_scope AS (SELECT b.patient_id, min(e.datetime) AS t FROM base b JOIN core_fact_endoscopy e ON e.patient_id = b.patient_id
                AND e.datetime >= b.dx_date - INTERVAL 730 DAY GROUP BY 1),
ppi AS (SELECT b.patient_id, count(*) AS n FROM base b
        JOIN core_fact_drug d ON d.patient_id = b.patient_id AND d.course_type IN ('PPI_COURSE', 'PPI_SHORT')
         AND d.datetime >= b.dx_date - INTERVAL 730 DAY AND d.datetime < b.dx_date
        LEFT JOIN first_scope s ON s.patient_id = b.patient_id
        WHERE s.t IS NULL OR d.datetime < s.t GROUP BY 1),
anaemic AS (  -- anaemia evidence: low Hb (sex-specific) or an anaemia diagnosis
  SELECT l.patient_id, l.datetime AS t FROM core_fact_lab l JOIN core_dim_patient p USING (patient_id)
  WHERE l.concept_id = 3100 AND l.value_numeric < CASE WHEN p.sex = 'M' THEN 13 ELSE 12 END
  UNION ALL SELECT patient_id, dx_datetime FROM core_fact_diagnosis WHERE concept_id IN (2022, 2023)),
mal AS (SELECT DISTINCT b.patient_id FROM base b
        JOIN core_fact_diagnosis d ON d.patient_id = b.patient_id AND d.concept_id IN (2100, 2024)
         AND d.dx_datetime >= b.dx_date - INTERVAL 365 DAY AND d.dx_datetime < b.dx_date
        JOIN anaemic a ON a.patient_id = b.patient_id AND abs(date_diff('day', a.t, d.dx_datetime)) <= 30),
hp AS (SELECT b.patient_id, max(CASE WHEN l.value_coded = 7001 THEN 1 ELSE 0 END) AS pos, count(*) AS n
       FROM base b JOIN core_fact_lab l ON l.patient_id = b.patient_id AND l.concept_id IN (3120, 3121, 3122, 5006, 5024)
        AND l.datetime <= b.dx_date + INTERVAL 30 DAY GROUP BY 1),
stage AS (SELECT b.patient_id, arg_min(s.stage_code, s.datetime) AS stage_code, arg_min(s.intent, s.datetime) AS intent
          FROM base b JOIN core_fact_staging s ON s.patient_id = b.patient_id AND s.datetime >= b.dx_date - INTERVAL 60 DAY GROUP BY 1)
SELECT b.patient_id, b.case_status, b.dx_date, b.age_at_dx,
       CASE WHEN b.age_at_dx < 50 THEN '<50' WHEN b.age_at_dx < 65 THEN '50-64' ELSE '65+' END AS age_band,
       b.sex, coalesce(b.dc_at, b.dc_now) AS district_code, d.province_code,
       g.first_gi_loc AS first_gi_facility_id, fl.hp_testing_tier AS first_gi_facility_tier,
       b.diag_facility_id,
       CASE st.stage_code WHEN 7190 THEN 'I' WHEN 7191 THEN 'II' WHEN 7192 THEN 'III' WHEN 7193 THEN 'IV' ELSE 'Unknown' END AS stage_group,
       CASE b.lauren_code WHEN 7140 THEN 'Intestinal' WHEN 7141 THEN 'Diffuse' WHEN 7142 THEN 'Mixed' ELSE 'Unknown' END AS lauren,
       CASE WHEN hp.pos = 1 THEN 'Positive' WHEN hp.n > 0 THEN 'Negative' ELSE 'Never tested' END AS hp_status_ever,
       coalesce(g.n_gi, 0) AS n_gi_visits_24m, hb.hb_drop AS hb_drop_12m, coalesce(ppi.n, 0) AS n_ppi_courses_no_scope,
       CAST(g.first_gi AS DATE) AS first_gi_symptom_date,
       date_diff('day', CAST(g.first_gi AS DATE), b.dx_date) AS diag_interval_days,
       (mal.patient_id IS NOT NULL) AS malaria_or_worm_attrib_12m,
       b.death_date, b.last_encounter_date AS last_contact_date,
       CASE WHEN b.death_date IS NOT NULL THEN b.death_date
            WHEN b.last_encounter_date < DATE '{{sim_date}}' - INTERVAL 365 DAY THEN CAST(b.last_encounter_date + INTERVAL 90 DAY AS DATE)
            ELSE DATE '{{sim_date}}' END AS end_date,
       st.intent AS treatment_intent
FROM base b
LEFT JOIN ref_district d ON d.district_code = coalesce(b.dc_at, b.dc_now)
LEFT JOIN gi24 g USING (patient_id)
LEFT JOIN core_dim_location fl ON fl.location_id = g.first_gi_loc
LEFT JOIN hb USING (patient_id) LEFT JOIN ppi USING (patient_id) LEFT JOIN mal USING (patient_id)
LEFT JOIN hp USING (patient_id) LEFT JOIN stage st USING (patient_id)
WHERE b.dx_date <= DATE '{{sim_date}}';

ALTER TABLE core_gc_case ADD COLUMN surv_days INTEGER;
ALTER TABLE core_gc_case ADD COLUMN event_death BOOLEAN;
UPDATE core_gc_case SET surv_days = greatest(0, date_diff('day', dx_date, end_date)),
                        event_death = death_date IS NOT NULL AND death_date <= DATE '{{sim_date}}';
