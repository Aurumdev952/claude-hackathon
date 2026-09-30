-- Secondary indexes created AFTER bulk load (SPEC §6.3 note)
ALTER TABLE obs ADD UNIQUE INDEX uq_obs_uuid (uuid);
CREATE INDEX idx_obs_person_concept ON obs (person_id, concept_id, obs_datetime);
CREATE INDEX idx_obs_concept_dt ON obs (concept_id, obs_datetime);
CREATE INDEX idx_obs_encounter ON obs (encounter_id);
