-- Secondary indexes created AFTER bulk load (SPEC §6.3 note)
ALTER TABLE obs ADD UNIQUE INDEX uq_obs_uuid (uuid);
CREATE INDEX idx_obs_person_concept ON obs (person_id, concept_id, obs_datetime);
CREATE INDEX idx_obs_concept_dt ON obs (concept_id, obs_datetime);
CREATE INDEX idx_obs_encounter ON obs (encounter_id);
ALTER TABLE person_name ADD UNIQUE INDEX uq_person_name_uuid (uuid);
ALTER TABLE person_address ADD UNIQUE INDEX uq_person_address_uuid (uuid);
ALTER TABLE person_attribute ADD UNIQUE INDEX uq_person_attribute_uuid (uuid);
ALTER TABLE patient_identifier ADD UNIQUE INDEX uq_patient_identifier_uuid (uuid);
ALTER TABLE visit ADD UNIQUE INDEX uq_visit_uuid (uuid);
ALTER TABLE encounter ADD UNIQUE INDEX uq_encounter_uuid (uuid);
ALTER TABLE orders ADD UNIQUE INDEX uq_orders_uuid (uuid);
ALTER TABLE patient_program ADD UNIQUE INDEX uq_patient_program_uuid (uuid);
ALTER TABLE person ADD UNIQUE INDEX uq_person_uuid (uuid);
ALTER TABLE patient_identifier ADD UNIQUE INDEX uq_ident (identifier, identifier_type);
