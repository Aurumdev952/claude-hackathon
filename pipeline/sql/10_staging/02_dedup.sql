-- SPEC §10.5 probabilistic duplicate resolution.
-- Blocking: sex + first-address district + birthdate (birth year when either side is estimated).
-- Score: 0.4*JW(given) + 0.4*JW(family) + 0.2*phone_match, re-normalised over names when a phone is missing.
-- Pairs whose (estimated) birthdates differ link only with a matching phone (blocking alone is too weak there).
CREATE OR REPLACE TABLE stg_dedup_candidates AS
WITH base AS (
  SELECT p.person_id, p.sex, p.birthdate, p.birthdate_estimated, year(p.birthdate) AS by,
         lower(strip_accents(n.given_name)) AS g, lower(strip_accents(n.family_name)) AS f, ph.phone,
         (SELECT arg_min(a.district_code, a.start_date) FROM stg_address a WHERE a.person_id = p.person_id) AS dc
  FROM stg_person p JOIN stg_name n USING (person_id) LEFT JOIN stg_phone ph USING (person_id)
)
SELECT a.person_id AS id_a, b.person_id AS id_b, a.birthdate = b.birthdate AS same_birthdate,
       coalesce(a.phone = b.phone, FALSE) AS phone_match,
       CASE WHEN a.phone IS NOT NULL AND b.phone IS NOT NULL
            THEN 0.4 * jaro_winkler_similarity(a.g, b.g) + 0.4 * jaro_winkler_similarity(a.f, b.f)
                 + 0.2 * CAST(a.phone = b.phone AS DOUBLE)
            ELSE (0.4 * jaro_winkler_similarity(a.g, b.g) + 0.4 * jaro_winkler_similarity(a.f, b.f)) / 0.8 END AS score
FROM base a JOIN base b
  ON a.sex = b.sex AND a.dc = b.dc AND a.person_id < b.person_id
 AND (a.birthdate = b.birthdate OR ((a.birthdate_estimated = 1 OR b.birthdate_estimated = 1) AND abs(a.by - b.by) <= 1));

CREATE OR REPLACE TABLE core_patient_link AS
WITH links AS (SELECT id_a, id_b, score FROM stg_dedup_candidates
               WHERE score >= 0.92 AND (same_birthdate OR phone_match)),
     masters AS (SELECT id_b AS patient_id, min(id_a) AS master_patient_id, max(score) AS score FROM links GROUP BY 1)
SELECT p.person_id AS patient_id, coalesce(m.master_patient_id, p.person_id) AS master_patient_id, m.score
FROM stg_person p LEFT JOIN masters m ON m.patient_id = p.person_id;
