-- v3 (docs/contracts/v3-loop.md §5, track L2): treatment events after diagnosis.
-- Concepts 5063/5070/5071 and drug 6017 only exist in data generated after Wave 0; on older data those kinds are empty.
CREATE OR REPLACE TABLE core_fact_treatment AS
WITH o AS (
  SELECT o.person_id AS patient_id, o.obs_datetime AS date, o.encounter_id, o.location_id, o.concept_id,
         o.value_coded, o.value_numeric, o.obs_id AS source_id
  FROM stg_obs o
  WHERE o.concept_id IN (5060, 5061, 5062, 5063, 5070, 5071)
)
SELECT o.patient_id, o.date,
       CASE o.concept_id WHEN 5060 THEN 'INTENT' WHEN 5061 THEN 'GASTRECTOMY' WHEN 5062 THEN 'CHEMO_REGIMEN'
                         WHEN 5063 THEN 'CHEMO_CYCLE' WHEN 5070 THEN 'RECURRENCE' WHEN 5071 THEN 'SURV_IMAGING' END AS kind,
       CASE WHEN o.value_coded IS NOT NULL THEN coalesce(c.name, CAST(o.value_coded AS VARCHAR))
            WHEN o.value_numeric IS NOT NULL THEN CAST(CAST(o.value_numeric AS INTEGER) AS VARCHAR) END AS value,
       o.value_coded, o.value_numeric, o.concept_id, o.encounter_id, o.location_id, 'obs' AS source, o.source_id
FROM o LEFT JOIN core_dim_concept c ON c.concept_id = o.value_coded
UNION ALL
SELECT r.patient_id, r.date_activated AS date, 'B12_INJ' AS kind, 'Cyanocobalamin' AS value, NULL::INTEGER AS value_coded,
       NULL::DOUBLE AS value_numeric, r.concept_id, r.encounter_id, e.location_id, 'drug_order' AS source, r.order_id AS source_id
FROM stg_orders r LEFT JOIN stg_encounter e USING (encounter_id)
WHERE r.order_type_id = 1 AND r.concept_id = 6017;
