"""Patient-level tables for the GI cohort (SPEC §11.5): pt_patient, pt_patient_facility, pt_timeline, pt_tumour.

pt_timeline rows carry organ ids from config/body_map.yaml so the 3D Case Analysis (SPEC v1.1) can light organs."""
from __future__ import annotations

import polars as pl

from shared.config import body_map

from .common import to_table

ENC_LABEL = {1: "Adult intake", 2: "OPD consultation", 3: "Follow-up visit", 4: "Lab results", 5: "Upper GI endoscopy",
             6: "Pathology report", 7: "Oncology intake", 8: "Admission", 9: "Discharge", 10: "Pharmacy", 11: "Antenatal visit",
             12: "HIV follow-up", 13: "NCD follow-up", 14: "Death"}


def _body_map_table(con):
    bm = body_map()
    rows = [{"concept_id": int(k), "organ_ids": v["organs"], "organ_weight": float(v.get("weight", 0.3)),
             "region": v.get("region")} for k, v in bm["concepts"].items()]
    df = pl.DataFrame(rows, schema={"concept_id": pl.Int32, "organ_ids": pl.List(pl.Utf8), "organ_weight": pl.Float64,
                                    "region": pl.Utf8})
    to_table(con, "ref_body_map", df)


def build_patient_tables(con, sim_time, log=print):
    _body_map_table(con)
    con.execute(f"""
    CREATE OR REPLACE TABLE pt_patient AS
    SELECT g.patient_id, i.display_id, n.given_name, n.family_name, p.sex,
           date_diff('year', p.birthdate, DATE '{sim_time:%Y-%m-%d}') AS age, p.birthdate, p.district_code, p.province_code,
           p.home_facility_id, g.entry_date, g.entry_reason, g.entry_facility_id,
           c.patient_id IS NOT NULL OR pv.patient_id IS NOT NULL AS is_case,   -- prevalent = known cancer diagnosed pre-EMR
           coalesce(c.case_status, CASE WHEN pv.patient_id IS NOT NULL THEN 'PREVALENT' END) AS case_status,
           coalesce(c.dx_date, pv.first_c16_date) AS dx_date, p.dead, p.death_date, p.last_encounter_date
    FROM core_gi_cohort g JOIN core_dim_patient p USING (patient_id)
    LEFT JOIN stg_identifier i ON i.person_id = g.patient_id
    LEFT JOIN stg_name n ON n.person_id = g.patient_id
    LEFT JOIN core_gc_case c USING (patient_id)
    LEFT JOIN core_gc_prevalent pv USING (patient_id)""")
    con.execute(f"""
    CREATE OR REPLACE TABLE pt_patient_facility AS
    SELECT DISTINCT patient_id, facility_id FROM (
      SELECT patient_id, home_facility_id AS facility_id FROM pt_patient
      UNION ALL SELECT t.patient_id, l.parent_location FROM pt_patient t JOIN core_dim_location l ON l.location_id = t.home_facility_id
      UNION ALL SELECT g.patient_id, g.location_id FROM core_gi_encounter g SEMI JOIN pt_patient t ON t.patient_id = g.patient_id
                WHERE g.datetime >= TIMESTAMP '{sim_time:%Y-%m-%d}' - INTERVAL 730 DAY)
    WHERE facility_id IS NOT NULL""")
    con.execute("""
    CREATE OR REPLACE TABLE pt_timeline AS
    WITH coh AS (SELECT patient_id FROM pt_patient),
    names AS (SELECT concept_id, name, units, low_normal, hi_normal FROM core_dim_concept),
    ev AS (
      SELECT e.patient_id, e.encounter_datetime AS ts, 'VISIT' AS event_type, e.encounter_type AS concept_id, NULL::DOUBLE AS value_num,
             NULL::VARCHAR AS value_text, NULL::VARCHAR AS unit, e.location_id AS facility_id, FALSE AS is_abnormal, e.encounter_id
      FROM core_fact_encounter e SEMI JOIN coh USING (patient_id)
      UNION ALL
      SELECT d.patient_id, d.dx_datetime, 'DIAGNOSIS', d.concept_id, NULL, d.certainty, NULL, d.location_id,
             d.concept_id BETWEEN 2000 AND 2005 OR d.concept_id IN (2016, 2017, 2018, 2021), d.encounter_id
      FROM core_fact_diagnosis d SEMI JOIN coh USING (patient_id)
      UNION ALL
      SELECT s.patient_id, s.datetime, 'SYMPTOM', s.concept_id, s.duration_weeks, NULL, 'weeks', s.location_id,
             s.concept_id IN (2203, 2205, 2213), s.encounter_id
      FROM core_fact_symptom s SEMI JOIN coh USING (patient_id)
      UNION ALL
      SELECT l.patient_id, l.datetime, 'LAB', l.concept_id, l.value_numeric, a.name, n.units, l.location_id,
             CASE WHEN l.concept_id = 3100 THEN l.value_numeric < CASE WHEN p.sex = 'M' THEN 13 ELSE 12 END
                  WHEN l.value_numeric IS NOT NULL THEN l.value_numeric < n.low_normal OR l.value_numeric > n.hi_normal
                  ELSE l.value_coded = 7001 END, l.encounter_id
      FROM core_fact_lab l SEMI JOIN coh USING (patient_id)
      JOIN core_dim_patient p USING (patient_id) LEFT JOIN names n ON n.concept_id = l.concept_id
      LEFT JOIN names a ON a.concept_id = l.value_coded
      UNION ALL
      SELECT v.patient_id, v.datetime, 'VITAL', v.concept_id, v.value_numeric, NULL, n.units, v.location_id,
             coalesce(v.value_numeric < n.low_normal OR v.value_numeric > n.hi_normal, FALSE), v.encounter_id
      FROM core_fact_vital v SEMI JOIN coh USING (patient_id) LEFT JOIN names n ON n.concept_id = v.concept_id
      UNION ALL
      SELECT d.patient_id, d.datetime, 'DRUG', d.drug_concept_id, d.duration_days, d.course_type, 'days', d.location_id, FALSE, d.encounter_id
      FROM core_fact_drug d SEMI JOIN coh USING (patient_id)
      UNION ALL
      SELECT o.patient_id, o.datetime, 'ORDER', o.concept_id, NULL,
             CASE WHEN o.fulfilled_datetime IS NOT NULL THEN 'fulfilled' ELSE 'open' END, NULL, o.location_id, FALSE, NULL
      FROM core_fact_order o SEMI JOIN coh USING (patient_id)
      UNION ALL
      SELECT e.patient_id, e.datetime, 'ENDOSCOPY', e.impression, e.lesion_size_mm, loc.name, 'mm', e.location_id,
             e.impression = 7113, e.encounter_id
      FROM core_fact_endoscopy e SEMI JOIN coh USING (patient_id) LEFT JOIN names loc ON loc.concept_id = e.lesion_location
      UNION ALL
      SELECT p.patient_id, p.datetime, 'PATHOLOGY', p.histology, NULL, la.name, NULL, p.location_id, p.histology = 7130, p.encounter_id
      FROM core_fact_pathology p SEMI JOIN coh USING (patient_id) LEFT JOIN names la ON la.concept_id = p.lauren
      UNION ALL
      SELECT s.patient_id, s.datetime, 'STAGING', s.stage_code, s.ecog,
             concat_ws(' ', tn.name, nn.name, mn.name), NULL, s.location_id, s.stage_code IN (7192, 7193), s.encounter_id
      FROM core_fact_staging s SEMI JOIN coh USING (patient_id) LEFT JOIN names tn ON tn.concept_id = s.t
      LEFT JOIN names nn ON nn.concept_id = s.n LEFT JOIN names mn ON mn.concept_id = s.m
    )
    SELECT ev.patient_id, ev.ts, ev.event_type, ev.concept_id,
           CASE WHEN ev.event_type = 'VISIT' THEN NULL ELSE coalesce(n.name, 'concept ' || ev.concept_id) END AS label,
           ev.value_num, ev.value_text, ev.unit, ev.facility_id, ev.is_abnormal, ev.encounter_id,
           CASE ev.event_type WHEN 'ENDOSCOPY' THEN ['stomach', 'oesophagus'] WHEN 'PATHOLOGY' THEN ['stomach']
                WHEN 'STAGING' THEN ['stomach', 'lymph_nodes'] ELSE bm.organ_ids END AS organ_ids,
           CASE ev.event_type WHEN 'ENDOSCOPY' THEN 0.6 WHEN 'PATHOLOGY' THEN 0.85 WHEN 'STAGING' THEN 0.9
                ELSE bm.organ_weight END AS organ_weight,
           bm.region
    FROM ev LEFT JOIN names n ON n.concept_id = ev.concept_id AND ev.event_type <> 'VISIT'
    LEFT JOIN ref_body_map bm ON bm.concept_id = ev.concept_id AND ev.event_type <> 'VISIT'""")
    # visit labels from the encounter type
    con.execute("CREATE OR REPLACE TEMP TABLE _enc_label (t INTEGER, label VARCHAR)")
    con.executemany("INSERT INTO _enc_label VALUES (?, ?)", list(ENC_LABEL.items()))
    con.execute("""UPDATE pt_timeline SET label = l.label FROM _enc_label l
                   WHERE pt_timeline.event_type = 'VISIT' AND pt_timeline.concept_id = l.t""")
    con.execute("""
    CREATE OR REPLACE TABLE pt_tumour AS
    WITH e AS (SELECT patient_id, arg_max(lesion_location, datetime) AS loc, arg_max(lesion_size_mm, datetime) AS size_mm,
                      max(datetime) AS endo_date FROM core_fact_endoscopy WHERE impression IN (7112, 7113) GROUP BY 1),
         p AS (SELECT patient_id, arg_max(lauren, datetime) AS lauren, arg_max(grade, datetime) AS grade,
                      arg_max(hp_histology, datetime) AS hp_hist FROM core_fact_pathology WHERE histology = 7130 GROUP BY 1),
         s AS (SELECT patient_id, arg_min(t, datetime) AS t, arg_min(n, datetime) AS n, arg_min(m, datetime) AS m,
                      arg_min(stage_code, datetime) AS stage_code, arg_min(intent, datetime) AS intent FROM core_fact_staging GROUP BY 1)
    SELECT c.patient_id, c.case_status, c.dx_date, c.stage_group, c.lauren,
           CASE e.loc WHEN 7120 THEN 'cardia' WHEN 7121 THEN 'body' WHEN 7122 THEN 'antrum' WHEN 7123 THEN 'diffuse' END AS lesion_location,
           e.size_mm AS lesion_size_mm, e.endo_date,
           CASE s.t WHEN 7160 THEN 'T1' WHEN 7161 THEN 'T2' WHEN 7162 THEN 'T3' WHEN 7163 THEN 'T4a' WHEN 7164 THEN 'T4b' END AS t_stage,
           CASE s.n WHEN 7170 THEN 'N0' WHEN 7171 THEN 'N1' WHEN 7172 THEN 'N2' WHEN 7173 THEN 'N3' END AS n_stage,
           CASE s.m WHEN 7180 THEN 'M0' WHEN 7181 THEN 'M1' END AS m_stage,
           CASE p.grade WHEN 7150 THEN 'Well' WHEN 7151 THEN 'Moderate' WHEN 7152 THEN 'Poor' END AS grade,
           CASE s.intent WHEN 7200 THEN 'Curative' WHEN 7201 THEN 'Palliative' WHEN 7202 THEN 'Best supportive care' END AS treatment_intent
    FROM core_gc_case c LEFT JOIN e USING (patient_id) LEFT JOIN p USING (patient_id) LEFT JOIN s USING (patient_id)""")
    n = con.execute("SELECT count(*) FROM pt_timeline").fetchone()[0]
    log(f"    pt_patient={con.execute('SELECT count(*) FROM pt_patient').fetchone()[0]:,} pt_timeline={n:,}")
