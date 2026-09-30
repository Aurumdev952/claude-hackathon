-- OpenMRS-style schema (SPEC §6.3). Generated from SPEC.md; obs indexes live in indexes.sql.
CREATE DATABASE IF NOT EXISTS openmrs CHARACTER SET utf8mb4;
USE openmrs;

CREATE TABLE person (
  person_id            INT PRIMARY KEY AUTO_INCREMENT,
  gender               VARCHAR(1)  NOT NULL,          -- 'M','F'
  birthdate            DATE        NULL,
  birthdate_estimated  TINYINT(1)  NOT NULL DEFAULT 0,
  dead                 TINYINT(1)  NOT NULL DEFAULT 0,
  death_date           DATETIME    NULL,
  cause_of_death       INT         NULL,              -- concept_id
  creator              INT NOT NULL DEFAULT 1,
  date_created         DATETIME NOT NULL,
  voided               TINYINT(1) NOT NULL DEFAULT 0,
  uuid                 CHAR(38) NOT NULL UNIQUE,
  INDEX idx_person_birth (birthdate)
);

CREATE TABLE person_name (
  person_name_id  INT PRIMARY KEY AUTO_INCREMENT,
  person_id       INT NOT NULL,
  preferred       TINYINT(1) NOT NULL DEFAULT 1,
  given_name      VARCHAR(50),
  family_name     VARCHAR(50),
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  FOREIGN KEY (person_id) REFERENCES person(person_id)
);

CREATE TABLE person_address (
  person_address_id INT PRIMARY KEY AUTO_INCREMENT,
  person_id         INT NOT NULL,
  preferred         TINYINT(1) NOT NULL DEFAULT 1,
  country           VARCHAR(50) DEFAULT 'Rwanda',
  state_province    VARCHAR(50),   -- province name
  county_district   VARCHAR(50),   -- district name
  address3          VARCHAR(50),   -- sector name
  address4          VARCHAR(50),   -- cell (optional)
  city_village      VARCHAR(50),   -- village (optional)
  latitude          VARCHAR(50),
  longitude         VARCHAR(50),
  start_date        DATETIME NULL,
  end_date          DATETIME NULL,    -- supports migration between districts
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  INDEX idx_addr_district (county_district),
  FOREIGN KEY (person_id) REFERENCES person(person_id)
);

CREATE TABLE person_attribute_type (
  person_attribute_type_id INT PRIMARY KEY,
  name VARCHAR(50) NOT NULL, format VARCHAR(50), uuid CHAR(38) NOT NULL UNIQUE
);
-- Seed: 1 'Telephone Number', 2 'Ubudehe Category', 3 'Health Insurance' (CBHI/RAMA/MMI/Private/None)

CREATE TABLE person_attribute (
  person_attribute_id INT PRIMARY KEY AUTO_INCREMENT,
  person_id INT NOT NULL, value VARCHAR(50) NOT NULL,
  person_attribute_type_id INT NOT NULL,
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  FOREIGN KEY (person_id) REFERENCES person(person_id)
);

CREATE TABLE patient (
  patient_id   INT PRIMARY KEY,     -- = person.person_id
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (patient_id) REFERENCES person(person_id)
);

CREATE TABLE patient_identifier_type (
  patient_identifier_type_id INT PRIMARY KEY,
  name VARCHAR(50) NOT NULL, uuid CHAR(38) NOT NULL UNIQUE
);
-- Seed: 1 'OpenMRS ID' (Luhn mod-30 check digit), 2 'Synthetic National ID'

CREATE TABLE patient_identifier (
  patient_identifier_id INT PRIMARY KEY AUTO_INCREMENT,
  patient_id INT NOT NULL, identifier VARCHAR(50) NOT NULL,
  identifier_type INT NOT NULL, preferred TINYINT(1) NOT NULL DEFAULT 1,
  location_id INT NULL,
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  UNIQUE KEY uq_ident (identifier, identifier_type),
  FOREIGN KEY (patient_id) REFERENCES patient(patient_id)
);

CREATE TABLE location (
  location_id      INT PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  description      VARCHAR(255),
  state_province   VARCHAR(50),
  county_district  VARCHAR(50),
  address3         VARCHAR(50),       -- sector
  latitude         VARCHAR(50),
  longitude        VARCHAR(50),
  parent_location  INT NULL,
  retired          TINYINT(1) NOT NULL DEFAULT 0,
  uuid CHAR(38) NOT NULL UNIQUE
);

-- Extension table (not in OpenMRS core) holding facility metadata used by the generator/ETL.
CREATE TABLE location_ext (
  location_id          INT PRIMARY KEY,
  facility_type        ENUM('REFERRAL','PROVINCIAL','DISTRICT','HEALTH_CENTRE') NOT NULL,
  district_code        VARCHAR(10) NOT NULL,
  endoscopy_from_year  SMALLINT NULL,
  hp_testing_tier      ENUM('low','medium','high') NOT NULL,
  FOREIGN KEY (location_id) REFERENCES location(location_id)
);

CREATE TABLE visit_type (visit_type_id INT PRIMARY KEY, name VARCHAR(255), uuid CHAR(38) UNIQUE);
-- Seed: 1 'Outpatient', 2 'Inpatient', 3 'Emergency'

CREATE TABLE visit (
  visit_id       INT PRIMARY KEY AUTO_INCREMENT,
  patient_id     INT NOT NULL,
  visit_type_id  INT NOT NULL,
  date_started   DATETIME NOT NULL,
  date_stopped   DATETIME NULL,
  location_id    INT NOT NULL,
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  INDEX idx_visit_patient (patient_id, date_started),
  FOREIGN KEY (patient_id) REFERENCES patient(patient_id)
);

CREATE TABLE encounter_type (encounter_type_id INT PRIMARY KEY, name VARCHAR(50), uuid CHAR(38) UNIQUE);

CREATE TABLE encounter (
  encounter_id        INT PRIMARY KEY AUTO_INCREMENT,
  encounter_type      INT NOT NULL,
  patient_id          INT NOT NULL,
  location_id         INT NOT NULL,
  visit_id            INT NULL,
  encounter_datetime  DATETIME NOT NULL,
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  INDEX idx_enc_patient_dt (patient_id, encounter_datetime),
  INDEX idx_enc_created (date_created),
  FOREIGN KEY (patient_id) REFERENCES patient(patient_id),
  FOREIGN KEY (visit_id) REFERENCES visit(visit_id)
);

CREATE TABLE concept_datatype (concept_datatype_id INT PRIMARY KEY, name VARCHAR(255), hl7_abbreviation VARCHAR(3), uuid CHAR(38) UNIQUE);
CREATE TABLE concept_class    (concept_class_id    INT PRIMARY KEY, name VARCHAR(255), uuid CHAR(38) UNIQUE);

CREATE TABLE concept (
  concept_id    INT PRIMARY KEY,
  datatype_id   INT NOT NULL,
  class_id      INT NOT NULL,
  is_set        TINYINT(1) NOT NULL DEFAULT 0,
  retired       TINYINT(1) NOT NULL DEFAULT 0,
  uuid CHAR(38) NOT NULL UNIQUE
);

CREATE TABLE concept_name (
  concept_name_id   INT PRIMARY KEY AUTO_INCREMENT,
  concept_id        INT NOT NULL,
  name              VARCHAR(255) NOT NULL,
  locale            VARCHAR(50) NOT NULL DEFAULT 'en',   -- also 'rw', 'fr' for a few
  concept_name_type VARCHAR(50) NULL,                    -- 'FULLY_SPECIFIED','SHORT'
  locale_preferred  TINYINT(1) DEFAULT 1,
  uuid CHAR(38) NOT NULL UNIQUE,
  FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE concept_numeric (
  concept_id INT PRIMARY KEY, hi_absolute DOUBLE, low_absolute DOUBLE,
  hi_normal DOUBLE, low_normal DOUBLE, units VARCHAR(50),
  FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE TABLE concept_answer (
  concept_answer_id INT PRIMARY KEY AUTO_INCREMENT,
  concept_id INT NOT NULL, answer_concept INT NOT NULL, sort_weight DOUBLE,
  uuid CHAR(38) NOT NULL UNIQUE
);

CREATE TABLE concept_reference_source (concept_source_id INT PRIMARY KEY, name VARCHAR(50), hl7_code VARCHAR(50), uuid CHAR(38) UNIQUE);
-- Seed: 1 'ICD-10-WHO', 2 'LOINC', 3 'SNOMED CT' (codes illustrative)

CREATE TABLE concept_reference_term (
  concept_reference_term_id INT PRIMARY KEY AUTO_INCREMENT,
  concept_source_id INT NOT NULL, code VARCHAR(255) NOT NULL, name VARCHAR(255),
  uuid CHAR(38) NOT NULL UNIQUE
);

CREATE TABLE concept_reference_map (
  concept_map_id INT PRIMARY KEY AUTO_INCREMENT,
  concept_id INT NOT NULL, concept_reference_term_id INT NOT NULL,
  map_type VARCHAR(20) DEFAULT 'SAME-AS', uuid CHAR(38) NOT NULL UNIQUE
);

CREATE TABLE obs (
  obs_id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  person_id       INT NOT NULL,
  concept_id      INT NOT NULL,          -- the question
  encounter_id    INT NULL,
  order_id        INT NULL,
  obs_datetime    DATETIME NOT NULL,
  location_id     INT NULL,
  obs_group_id    BIGINT NULL,           -- groups e.g. endoscopy findings
  value_coded     INT NULL,              -- answer concept_id
  value_numeric   DOUBLE NULL,
  value_text      TEXT NULL,
  value_datetime  DATETIME NULL,
  comments        VARCHAR(255) NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'FINAL',   -- 'FINAL','AMENDED','PRELIMINARY'
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, void_reason VARCHAR(255) NULL,
  uuid CHAR(38) NOT NULL
);
-- NOTE: create obs indexes AFTER bulk load (much faster).

CREATE TABLE order_type (order_type_id INT PRIMARY KEY, name VARCHAR(255), uuid CHAR(38) UNIQUE);
-- Seed: 1 'Drug Order', 2 'Test Order', 3 'Referral Order'

CREATE TABLE orders (
  order_id       INT PRIMARY KEY AUTO_INCREMENT,
  order_type_id  INT NOT NULL,
  concept_id     INT NOT NULL,
  patient_id     INT NOT NULL,
  encounter_id   INT NOT NULL,
  date_activated DATETIME NOT NULL,
  date_stopped   DATETIME NULL,
  urgency        VARCHAR(20) DEFAULT 'ROUTINE',
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE,
  INDEX idx_orders_patient (patient_id, date_activated)
);

CREATE TABLE drug (drug_id INT PRIMARY KEY, concept_id INT NOT NULL, name VARCHAR(255), strength VARCHAR(255), uuid CHAR(38) UNIQUE);

CREATE TABLE drug_order (
  order_id INT PRIMARY KEY, drug_inventory_id INT NULL,
  dose DOUBLE, dose_units INT NULL, frequency VARCHAR(50), duration INT, duration_units VARCHAR(20),
  quantity DOUBLE, num_refills INT DEFAULT 0,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE TABLE program (program_id INT PRIMARY KEY, concept_id INT, name VARCHAR(50), uuid CHAR(38) UNIQUE);
-- Seed: 1 'HIV Care', 2 'NCD (HTN/DM)', 3 'Oncology', 4 'TB'

CREATE TABLE patient_program (
  patient_program_id INT PRIMARY KEY AUTO_INCREMENT,
  patient_id INT NOT NULL, program_id INT NOT NULL,
  date_enrolled DATETIME, date_completed DATETIME NULL, location_id INT,
  outcome_concept_id INT NULL,
  creator INT NOT NULL DEFAULT 1, date_created DATETIME NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0, uuid CHAR(38) NOT NULL UNIQUE
);

-- Pipeline bookkeeping (not OpenMRS): simulator heartbeat
CREATE TABLE sim_tick_log (
  tick_id INT PRIMARY KEY AUTO_INCREMENT, sim_time DATETIME NOT NULL,
  wall_time DATETIME NOT NULL, encounters_added INT, obs_added INT
);
