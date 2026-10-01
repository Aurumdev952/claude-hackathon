-- SPEC §10.5 probabilistic duplicate resolution.
-- Blocking: sex + first-address district + birthdate (birth year +-1 when either side is estimated). Written as
-- equi-joins so DuckDB can hash-join (an OR in the join condition degrades to a per-block cross product).
-- Score: 0.4*JW(given) + 0.4*JW(family) + 0.2*phone_match, re-normalised over names when a phone is missing.
-- Pairs whose (estimated) birthdates differ link only with a matching phone (blocking alone is too weak there).
CREATE OR REPLACE TABLE stg_dedup_base AS
WITH first_addr AS (SELECT person_id, arg_min(district_code, start_date) AS dc FROM stg_address GROUP BY 1)
SELECT p.person_id, p.sex, p.birthdate, p.birthdate_estimated AS est, year(p.birthdate) AS by,
       lower(strip_accents(n.given_name)) AS g, lower(strip_accents(n.family_name)) AS f, ph.phone, fa.dc
FROM stg_person p JOIN stg_name n USING (person_id) LEFT JOIN stg_phone ph USING (person_id) JOIN first_addr fa USING (person_id);

CREATE OR REPLACE TABLE stg_dedup_candidates AS
WITH pairs AS (
  SELECT a.person_id AS id_a, b.person_id AS id_b FROM stg_dedup_base a JOIN stg_dedup_base b
    ON a.sex = b.sex AND a.dc = b.dc AND a.birthdate = b.birthdate AND a.person_id < b.person_id
  UNION
  SELECT a.person_id, b.person_id FROM (SELECT * FROM stg_dedup_base WHERE est = 1) a
    JOIN stg_dedup_base b ON a.sex = b.sex AND a.dc = b.dc AND b.by BETWEEN a.by - 1 AND a.by + 1 AND a.person_id <> b.person_id
)
SELECT least(p.id_a, p.id_b) AS id_a, greatest(p.id_a, p.id_b) AS id_b, a.birthdate = b.birthdate AS same_birthdate,
       coalesce(a.phone = b.phone, FALSE) AS phone_match,
       CASE WHEN a.phone IS NOT NULL AND b.phone IS NOT NULL
            THEN 0.4 * jaro_winkler_similarity(a.g, b.g) + 0.4 * jaro_winkler_similarity(a.f, b.f) + 0.2 * CAST(a.phone = b.phone AS DOUBLE)
            ELSE (0.4 * jaro_winkler_similarity(a.g, b.g) + 0.4 * jaro_winkler_similarity(a.f, b.f)) / 0.8 END AS score
FROM (SELECT DISTINCT least(id_a, id_b) AS id_a, greatest(id_a, id_b) AS id_b FROM pairs) p
JOIN stg_dedup_base a ON a.person_id = p.id_a JOIN stg_dedup_base b ON b.person_id = p.id_b;

CREATE OR REPLACE TABLE core_patient_link AS
WITH links AS (SELECT id_a, id_b, score FROM stg_dedup_candidates
               WHERE score >= 0.92 AND (same_birthdate OR phone_match)),
     masters AS (SELECT id_b AS patient_id, min(id_a) AS master_patient_id, max(score) AS score FROM links GROUP BY 1)
SELECT p.person_id AS patient_id, coalesce(m.master_patient_id, p.person_id) AS master_patient_id, m.score
FROM stg_person p LEFT JOIN masters m ON m.patient_id = p.person_id;
