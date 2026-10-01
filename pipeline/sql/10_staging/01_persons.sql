-- SPEC §10.3 step 3: typed, cleaned person-level staging
CREATE OR REPLACE TABLE stg_person AS
SELECT person_id, gender AS sex, CAST(birthdate AS DATE) AS birthdate, birthdate_estimated, dead,
       death_date, cause_of_death, date_created
FROM raw_person WHERE voided = 0;

CREATE OR REPLACE TABLE stg_name AS
SELECT person_id, arg_max(given_name, person_name_id) AS given_name, arg_max(family_name, person_name_id) AS family_name
FROM raw_person_name WHERE voided = 0 GROUP BY 1;

CREATE OR REPLACE TABLE stg_phone AS
SELECT person_id, max(value) AS phone FROM raw_person_attribute
WHERE person_attribute_type_id = 1 AND voided = 0 GROUP BY 1;

CREATE OR REPLACE TABLE stg_identifier AS
SELECT patient_id AS person_id, arg_max(identifier, patient_identifier_id) AS display_id, arg_max(location_id, patient_identifier_id) AS id_location
FROM raw_patient_identifier WHERE identifier_type = 1 AND voided = 0 GROUP BY 1;

-- address history -> district codes (names normalised; ref_district loaded from shared/geo.py)
CREATE OR REPLACE TABLE stg_address AS
SELECT a.person_id, a.start_date,
       coalesce(lead(a.start_date) OVER (PARTITION BY a.person_id ORDER BY a.start_date, a.person_address_id),
                TIMESTAMP '2100-01-01') AS valid_to,
       d.district_code, d.province_code, a.address3 AS sector,
       try_cast(a.latitude AS DOUBLE) AS lat, try_cast(a.longitude AS DOUBLE) AS lon
FROM raw_person_address a
JOIN ref_district d ON lower(strip_accents(trim(a.county_district))) = d.name_norm
WHERE a.voided = 0;
