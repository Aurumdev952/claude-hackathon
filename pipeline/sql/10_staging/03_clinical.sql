-- encounters: drop future-dated and before-birth rows (logged), map to master patient ids
CREATE OR REPLACE TABLE stg_dq_dropped AS
SELECT e.encounter_id, e.patient_id,
       CASE WHEN e.encounter_datetime > TIMESTAMP '{{sim_time}}' + INTERVAL 1 DAY THEN 'FUTURE_DATED' ELSE 'BEFORE_BIRTH' END AS reason
FROM raw_encounter e JOIN stg_person p ON p.person_id = e.patient_id
WHERE e.voided = 0 AND (e.encounter_datetime > TIMESTAMP '{{sim_time}}' + INTERVAL 1 DAY
                        OR CAST(e.encounter_datetime AS DATE) < p.birthdate - INTERVAL 1 DAY);

CREATE OR REPLACE TABLE stg_encounter AS
SELECT e.encounter_id, e.encounter_type, l.master_patient_id AS patient_id, e.patient_id AS source_patient_id,
       e.location_id, e.visit_id, e.encounter_datetime
FROM raw_encounter e
JOIN core_patient_link l ON l.patient_id = e.patient_id
ANTI JOIN stg_dq_dropped d ON d.encounter_id = e.encounter_id
WHERE e.voided = 0;

-- obs: voided removed; AMENDED groups -> latest row; Hb g/L -> g/dL
CREATE OR REPLACE TABLE stg_obs AS
WITH o AS (
  SELECT r.obs_id, l.master_patient_id AS person_id, r.concept_id, r.encounter_id, r.order_id, r.obs_datetime,
         r.location_id, r.obs_group_id, r.value_coded, r.value_numeric, r.value_text, r.status, r.date_created
  FROM raw_obs r
  JOIN core_patient_link l ON l.patient_id = r.person_id
  SEMI JOIN stg_encounter e ON e.encounter_id = r.encounter_id
  WHERE r.voided = 0
),
amended AS (SELECT DISTINCT encounter_id, concept_id FROM o WHERE status = 'AMENDED'),
plain AS (SELECT o.* FROM o ANTI JOIN amended a ON a.encounter_id = o.encounter_id AND a.concept_id = o.concept_id),
latest AS (
  SELECT o.* FROM o SEMI JOIN amended a ON a.encounter_id = o.encounter_id AND a.concept_id = o.concept_id
  QUALIFY row_number() OVER (PARTITION BY o.encounter_id, o.concept_id ORDER BY o.date_created DESC, o.obs_id DESC) = 1
),
u AS (SELECT *, status = 'AMENDED' AS amended_flag FROM plain UNION ALL BY NAME SELECT *, TRUE AS amended_flag FROM latest)
SELECT * EXCLUDE (value_numeric),
       CASE WHEN concept_id = 3100 AND value_numeric > 30 THEN round(value_numeric / 10, 1) ELSE value_numeric END AS value_numeric,
       (concept_id = 3100 AND value_numeric > 30) AS unit_fixed_flag
FROM u;

CREATE OR REPLACE TABLE stg_orders AS
SELECT r.order_id, r.order_type_id, r.concept_id, l.master_patient_id AS patient_id, r.encounter_id,
       r.date_activated, r.date_stopped, r.urgency
FROM raw_orders r JOIN core_patient_link l ON l.patient_id = r.patient_id
SEMI JOIN stg_encounter e ON e.encounter_id = r.encounter_id
WHERE r.voided = 0;
