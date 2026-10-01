-- SPEC §11.2 dimensions
CREATE OR REPLACE TABLE core_dim_location AS
SELECT l.location_id, l.name, x.facility_type, x.district_code, d.province_code,
       try_cast(l.latitude AS DOUBLE) AS lat, try_cast(l.longitude AS DOUBLE) AS lon,
       x.endoscopy_from_year, f.endoscopy_from_date, x.hp_testing_tier, f.go_live_date, l.parent_location, l.address3 AS sector
FROM raw_location l JOIN raw_location_ext x USING (location_id)
JOIN ref_district d ON d.district_code = x.district_code
LEFT JOIN ref_facility f USING (location_id);

CREATE OR REPLACE TABLE core_dim_concept AS
SELECT c.concept_id, n.name, cc.name AS class, dt.name AS datatype, cn.units, cn.low_normal, cn.hi_normal,
       t.code AS icd10,
       CASE WHEN c.concept_id BETWEEN 1000 AND 1099 THEN 'question' WHEN c.concept_id BETWEEN 2000 AND 2199 THEN 'diagnosis'
            WHEN c.concept_id BETWEEN 2200 AND 2299 THEN 'symptom' WHEN c.concept_id BETWEEN 3000 AND 3049 THEN 'vital'
            WHEN c.concept_id BETWEEN 3100 AND 3199 THEN 'lab' WHEN c.concept_id BETWEEN 4000 AND 4099 THEN 'lifestyle'
            WHEN c.concept_id BETWEEN 5000 AND 5199 THEN 'oncology' WHEN c.concept_id BETWEEN 6000 AND 6099 THEN 'drug'
            WHEN c.concept_id BETWEEN 7000 AND 7299 THEN 'answer' WHEN c.concept_id BETWEEN 8000 AND 8099 THEN 'order' END AS group_range
FROM raw_concept c
LEFT JOIN raw_concept_name n ON n.concept_id = c.concept_id AND n.locale = 'en'
LEFT JOIN raw_concept_class cc ON cc.concept_class_id = c.class_id
LEFT JOIN raw_concept_datatype dt ON dt.concept_datatype_id = c.datatype_id
LEFT JOIN raw_concept_numeric cn ON cn.concept_id = c.concept_id
LEFT JOIN raw_concept_reference_map m ON m.concept_id = c.concept_id
LEFT JOIN raw_concept_reference_term t ON t.concept_reference_term_id = m.concept_reference_term_id;

CREATE OR REPLACE TABLE core_dim_date AS
SELECT CAST(d AS DATE) AS date, year(d) AS year, quarter(d) AS quarter, month(d) AS month, weekofyear(d) AS iso_week
FROM range(DATE '2015-01-01', DATE '2028-01-01', INTERVAL 1 DAY) t(d);

-- encounters first (needed by the patient dimension)
CREATE OR REPLACE TABLE core_fact_encounter AS
SELECT encounter_id, patient_id, encounter_type, location_id, encounter_datetime, visit_id FROM stg_encounter;

CREATE OR REPLACE TABLE core_dim_patient AS
WITH enc AS (SELECT patient_id, min(encounter_datetime) AS first_enc, max(encounter_datetime) AS last_enc FROM stg_encounter GROUP BY 1),
deaths AS (SELECT patient_id, min(encounter_datetime) AS death_enc FROM stg_encounter WHERE encounter_type = 14 GROUP BY 1),
addr AS (SELECT person_id, arg_max(district_code, start_date) AS district_code, arg_max(province_code, start_date) AS province_code,
                arg_max(sector, start_date) AS sector FROM stg_address GROUP BY 1),
ident AS (SELECT l.master_patient_id AS person_id, arg_min(i.id_location, i.person_id) AS home_facility_id
          FROM stg_identifier i JOIN core_patient_link l ON l.patient_id = i.person_id GROUP BY 1)
SELECT p.person_id AS patient_id, p.sex, p.birthdate, p.birthdate_estimated, a.district_code, a.province_code, a.sector,
       i.home_facility_id, CAST(e.first_enc AS DATE) AS first_encounter_date, CAST(e.last_enc AS DATE) AS last_encounter_date,
       (p.dead = 1 OR d.death_enc IS NOT NULL) AS dead,
       CAST(coalesce(p.death_date, d.death_enc) AS DATE) AS death_date,
       CASE WHEN date_diff('year', p.birthdate, DATE '{{sim_date}}') >= 85 THEN '85+'
            ELSE CAST(5 * (date_diff('year', p.birthdate, DATE '{{sim_date}}') // 5) AS VARCHAR) || '-' ||
                 CAST(5 * (date_diff('year', p.birthdate, DATE '{{sim_date}}') // 5) + 4 AS VARCHAR) END AS age_group_current
FROM stg_person p
JOIN core_patient_link l ON l.patient_id = p.person_id AND l.master_patient_id = p.person_id
JOIN enc e ON e.patient_id = p.person_id
LEFT JOIN deaths d ON d.patient_id = p.person_id
LEFT JOIN addr a ON a.person_id = p.person_id
LEFT JOIN ident i ON i.person_id = p.person_id;
