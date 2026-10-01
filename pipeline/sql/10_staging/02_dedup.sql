-- SPEC §10.5 probabilistic duplicate resolution.
-- Blocking: sex + first-address district + birthdate, plus birth year +-1 with the same phone when a birthdate is estimated.
-- equi-joins so DuckDB can hash-join (an OR in the join condition degrades to a per-block cross product).
-- Score: 0.4*JW(given) + 0.4*JW(family) + 0.2*phone_match, re-normalised over names when a phone is missing.
-- Link rule (D-24): score >= 0.92 and either a matching phone, or the same birthdate in the same first sector where
-- the birthdate is exact, or (estimated) at least one of the two full names is unique in the district
-- (term-frequency weighting: estimated birthdates heap on 1 Jan / 1 Jul and common names are shared by strangers).
CREATE OR REPLACE TABLE stg_dedup_base AS
WITH first_addr AS (SELECT person_id, arg_min(district_code, start_date) AS dc, arg_min(lower(trim(sector)), start_date) AS sec
                    FROM stg_address GROUP BY 1)
SELECT p.person_id, p.sex, p.birthdate, p.birthdate_estimated AS est, year(p.birthdate) AS by,
       lower(strip_accents(n.given_name)) AS g, lower(strip_accents(n.family_name)) AS f, ph.phone, fa.dc, fa.sec
FROM stg_person p JOIN stg_name n USING (person_id) LEFT JOIN stg_phone ph USING (person_id) JOIN first_addr fa USING (person_id);

-- only pairs that could matter are kept (links need >= 0.92; 0.85-0.92 stays for review): blocking yields ~10^8 pairs
-- at scale 1.0, and storing them all would rewrite gigabytes on every incremental run
CREATE OR REPLACE TABLE stg_dedup_candidates AS
SELECT * FROM (
WITH name_freq AS (SELECT dc, g, f, count(*) AS n FROM stg_dedup_base GROUP BY ALL),
pairs AS (
  SELECT a.person_id AS id_a, b.person_id AS id_b FROM stg_dedup_base a JOIN stg_dedup_base b
    ON a.sex = b.sex AND a.dc = b.dc AND a.birthdate = b.birthdate AND a.person_id < b.person_id
  UNION
  -- estimated birthdates (+-1 year): with different birthdates only a matching phone can link a pair (rule below),
  -- so the phone is part of this block (same links, ~100x fewer pairs than blocking on the birth year alone)
  SELECT a.person_id, b.person_id FROM (SELECT * FROM stg_dedup_base WHERE est = 1 AND phone IS NOT NULL) a
    JOIN stg_dedup_base b ON a.sex = b.sex AND a.dc = b.dc AND a.phone = b.phone AND b.by BETWEEN a.by - 1 AND a.by + 1
                         AND a.person_id <> b.person_id
)
SELECT least(p.id_a, p.id_b) AS id_a, greatest(p.id_a, p.id_b) AS id_b, a.birthdate = b.birthdate AS same_birthdate,
       (a.birthdate = b.birthdate AND a.sec = b.sec AND ((a.est = 0 AND b.est = 0) OR least(na.n, nb.n) = 1)) AS exact_same_place,
       coalesce(a.phone = b.phone, FALSE) AS phone_match,
       CASE WHEN a.phone IS NOT NULL AND b.phone IS NOT NULL
            THEN 0.4 * jaro_winkler_similarity(a.g, b.g) + 0.4 * jaro_winkler_similarity(a.f, b.f) + 0.2 * CAST(a.phone = b.phone AS DOUBLE)
            ELSE (0.4 * jaro_winkler_similarity(a.g, b.g) + 0.4 * jaro_winkler_similarity(a.f, b.f)) / 0.8 END AS score
FROM (SELECT DISTINCT least(id_a, id_b) AS id_a, greatest(id_a, id_b) AS id_b FROM pairs) p
JOIN stg_dedup_base a ON a.person_id = p.id_a JOIN stg_dedup_base b ON b.person_id = p.id_b
JOIN name_freq na ON na.dc = a.dc AND na.g = a.g AND na.f = a.f JOIN name_freq nb ON nb.dc = b.dc AND nb.g = b.g AND nb.f = b.f
) WHERE score >= 0.85;

CREATE OR REPLACE TABLE core_patient_link AS
WITH links AS (SELECT id_a, id_b, score FROM stg_dedup_candidates
               WHERE score >= 0.92 AND (exact_same_place OR phone_match)),
     masters AS (SELECT id_b AS patient_id, min(id_a) AS master_patient_id, max(score) AS score FROM links GROUP BY 1)
SELECT p.person_id AS patient_id, coalesce(m.master_patient_id, p.person_id) AS master_patient_id, m.score
FROM stg_person p LEFT JOIN masters m ON m.patient_id = p.person_id;
