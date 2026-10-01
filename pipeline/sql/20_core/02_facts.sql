-- SPEC §11.2 facts
CREATE OR REPLACE TABLE core_fact_diagnosis AS
SELECT d.person_id AS patient_id, d.encounter_id, d.obs_datetime AS dx_datetime, d.value_coded AS concept_id, c.icd10,
       coalesce(cert.value_coded = 7011, FALSE) AS confirmed, CASE WHEN cert.value_coded = 7011 THEN 'Confirmed' ELSE 'Presumed' END AS certainty,
       coalesce(ord.value_coded = 7012, TRUE) AS is_primary, d.location_id, d.obs_id
FROM stg_obs d
LEFT JOIN stg_obs cert ON cert.obs_group_id = d.obs_id AND cert.concept_id = 1001
LEFT JOIN stg_obs ord ON ord.obs_group_id = d.obs_id AND ord.concept_id = 1002
LEFT JOIN core_dim_concept c ON c.concept_id = d.value_coded
WHERE d.concept_id = 1000;

CREATE OR REPLACE TABLE core_fact_symptom AS
SELECT s.person_id AS patient_id, s.encounter_id, s.obs_datetime AS datetime, s.value_coded AS concept_id, s.location_id,
       (SELECT max(w.value_numeric) FROM stg_obs w WHERE w.encounter_id = s.encounter_id AND w.concept_id = 1004) AS duration_weeks
FROM stg_obs s WHERE s.concept_id = 1003;

CREATE OR REPLACE TABLE core_fact_lab AS
SELECT person_id AS patient_id, encounter_id, obs_datetime AS datetime, concept_id, value_numeric, value_coded,
       unit_fixed_flag, location_id, order_id, amended_flag
FROM stg_obs WHERE concept_id BETWEEN 3100 AND 3199 OR concept_id IN (5006, 5024);

CREATE OR REPLACE TABLE core_fact_vital AS
SELECT person_id AS patient_id, encounter_id, obs_datetime AS datetime, concept_id, value_numeric, location_id
FROM stg_obs WHERE concept_id BETWEEN 3000 AND 3049;

CREATE OR REPLACE TABLE core_fact_drug AS
WITH d AS (
  SELECT o.order_id, o.patient_id, o.encounter_id, o.date_activated AS datetime, o.concept_id AS drug_concept_id,
         coalesce(dr.duration, 0) AS duration_days, e.location_id
  FROM stg_orders o JOIN raw_drug_order dr USING (order_id) JOIN stg_encounter e USING (encounter_id)
  WHERE o.order_type_id = 1
),
erad AS (  -- HP_ERADICATION = PPI + >= 2 of {amoxicillin, clarithromycin, metronidazole, bismuth} within 3 days, >= 7 days
  SELECT p.order_id
  FROM d p JOIN d a ON a.patient_id = p.patient_id AND a.drug_concept_id IN (6001, 6002, 6003, 6004)
                   AND abs(date_diff('day', p.datetime, a.datetime)) <= 3
  WHERE p.drug_concept_id = 6000 AND p.duration_days >= 7
  GROUP BY p.order_id HAVING count(DISTINCT a.drug_concept_id) >= 2
)
SELECT d.*, CASE WHEN d.order_id IN (SELECT order_id FROM erad) THEN 'HP_ERADICATION'
                 WHEN d.drug_concept_id = 6000 AND d.duration_days >= 14 THEN 'PPI_COURSE'
                 WHEN d.drug_concept_id = 6000 THEN 'PPI_SHORT'
                 WHEN d.drug_concept_id = 6005 THEN 'IRON_THERAPY' WHEN d.drug_concept_id = 6006 THEN 'ANTACID'
                 WHEN d.drug_concept_id = 6007 THEN 'ANTIMALARIAL' WHEN d.drug_concept_id = 6008 THEN 'ANTHELMINTHIC'
                 WHEN d.drug_concept_id IN (6001, 6002, 6003, 6004) THEN 'ANTIBIOTIC'
                 WHEN d.drug_concept_id IN (6014, 6015) THEN 'CHEMOTHERAPY' ELSE 'OTHER' END AS course_type
FROM d;

CREATE OR REPLACE TABLE core_fact_endoscopy AS
SELECT s.person_id AS patient_id, s.encounter_id, s.obs_datetime AS datetime, s.location_id,
       max(CASE WHEN c.concept_id = 5001 THEN c.value_coded END) AS indication,
       max(CASE WHEN c.concept_id = 5002 THEN c.value_coded END) AS impression,
       max(CASE WHEN c.concept_id = 5003 THEN c.value_coded END) AS lesion_location,
       max(CASE WHEN c.concept_id = 5004 THEN c.value_numeric END) AS lesion_size_mm,
       max(CASE WHEN c.concept_id = 5005 THEN c.value_coded END) AS biopsy,
       max(CASE WHEN c.concept_id = 5006 THEN c.value_coded END) AS rut_result
FROM stg_obs s LEFT JOIN stg_obs c ON c.obs_group_id = s.obs_id
WHERE s.concept_id = 5000 GROUP BY ALL;

CREATE OR REPLACE TABLE core_fact_pathology AS
SELECT s.person_id AS patient_id, s.encounter_id, s.obs_datetime AS datetime, s.location_id,
       max(CASE WHEN c.concept_id = 5021 THEN c.value_coded END) AS histology,
       max(CASE WHEN c.concept_id = 5022 THEN c.value_coded END) AS lauren,
       max(CASE WHEN c.concept_id = 5023 THEN c.value_coded END) AS grade,
       max(CASE WHEN c.concept_id = 5024 THEN c.value_coded END) AS hp_histology
FROM stg_obs s LEFT JOIN stg_obs c ON c.obs_group_id = s.obs_id
WHERE s.concept_id = 5020 GROUP BY ALL;

CREATE OR REPLACE TABLE core_fact_staging AS
SELECT s.person_id AS patient_id, s.encounter_id, s.obs_datetime AS datetime, s.location_id,
       max(CASE WHEN c.concept_id = 5041 THEN c.value_coded END) AS t,
       max(CASE WHEN c.concept_id = 5042 THEN c.value_coded END) AS n,
       max(CASE WHEN c.concept_id = 5043 THEN c.value_coded END) AS m,
       max(CASE WHEN c.concept_id = 5044 THEN c.value_coded END) AS stage_code,
       (SELECT max(e.value_numeric) FROM stg_obs e WHERE e.encounter_id = s.encounter_id AND e.concept_id = 5045) AS ecog,
       (SELECT max(e.value_coded) FROM stg_obs e WHERE e.encounter_id = s.encounter_id AND e.concept_id = 5060) AS intent
FROM stg_obs s LEFT JOIN stg_obs c ON c.obs_group_id = s.obs_id
WHERE s.concept_id = 5040 GROUP BY ALL;

CREATE OR REPLACE TABLE core_fact_order AS
WITH o AS (SELECT o.*, e.location_id FROM stg_orders o JOIN stg_encounter e USING (encounter_id) WHERE o.order_type_id IN (2, 3))
SELECT o.order_id, o.patient_id, o.date_activated AS datetime, o.concept_id, o.location_id, o.urgency,
       CASE WHEN o.concept_id = 8000 THEN (SELECT min(x.encounter_datetime) FROM stg_encounter x
                                          WHERE x.patient_id = o.patient_id AND x.encounter_type = 5
                                            AND x.encounter_datetime BETWEEN o.date_activated AND o.date_activated + INTERVAL 180 DAY)
            WHEN o.concept_id = 8001 THEN (SELECT min(x.obs_datetime) FROM stg_obs x WHERE x.person_id = o.patient_id
                                            AND x.concept_id IN (3120, 3121, 3122)
                                            AND x.obs_datetime BETWEEN o.date_activated AND o.date_activated + INTERVAL 30 DAY)
            WHEN o.concept_id = 8002 THEN (SELECT min(x.obs_datetime) FROM stg_obs x WHERE x.person_id = o.patient_id
                                            AND x.concept_id = 3100
                                            AND x.obs_datetime BETWEEN o.date_activated AND o.date_activated + INTERVAL 7 DAY)
       END AS fulfilled_datetime
FROM o;

CREATE OR REPLACE TABLE core_fact_lifestyle AS
SELECT person_id AS patient_id,
       arg_max(CASE WHEN concept_id = 4000 THEN value_coded END, CASE WHEN concept_id = 4000 THEN obs_datetime END) AS tobacco,
       arg_max(CASE WHEN concept_id = 4002 THEN value_coded END, CASE WHEN concept_id = 4002 THEN obs_datetime END) AS alcohol,
       arg_max(CASE WHEN concept_id = 4004 THEN value_coded END, CASE WHEN concept_id = 4004 THEN obs_datetime END) AS family_hx,
       arg_max(CASE WHEN concept_id = 4005 THEN value_coded END, CASE WHEN concept_id = 4005 THEN obs_datetime END) AS high_salt,
       arg_max(CASE WHEN concept_id = 4006 THEN value_coded END, CASE WHEN concept_id = 4006 THEN obs_datetime END) AS smoked_food,
       arg_max(CASE WHEN concept_id = 4011 THEN value_coded END, CASE WHEN concept_id = 4011 THEN obs_datetime END) AS nsaid,
       list_distinct(list(concept_id)) AS recorded_flags,
       min(CASE WHEN concept_id = 4000 THEN obs_datetime END) AS tobacco_recorded_at,
       min(CASE WHEN concept_id = 4004 THEN obs_datetime END) AS family_hx_recorded_at
FROM stg_obs WHERE concept_id BETWEEN 4000 AND 4011 GROUP BY 1;

-- GI encounter flag (complaint in the GI symptom set or GI diagnosis 2010-2021)
CREATE OR REPLACE TABLE core_gi_encounter AS
SELECT encounter_id, any_value(patient_id) AS patient_id, min(datetime) AS datetime, any_value(location_id) AS location_id FROM (
  SELECT encounter_id, patient_id, datetime, location_id FROM core_fact_symptom
  WHERE concept_id IN (2200, 2201, 2202, 2203, 2204, 2205, 2206, 2211, 2212, 2213)
  UNION ALL
  SELECT encounter_id, patient_id, dx_datetime, location_id FROM core_fact_diagnosis WHERE concept_id BETWEEN 2010 AND 2021)
GROUP BY encounter_id;
