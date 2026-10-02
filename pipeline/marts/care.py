"""v3 care marts (docs/contracts/v3-loop.md §5, track L2).

Runs inside `build_all` after the patient tables. Steps:
1. `care.snapshot.to_duckdb` copies care.sqlite into care_* tables (published with the care_ prefix).
2. pt_care_plan / pt_care_task: the snapshot plus derived fields (days_open, overdue_days, ...).
3. pt_treatment (published copy of core_fact_treatment for the cohort), pt_journey and pt_recovery (care/journey.py).
4. Ministry aggregates: mart_care_funnel, mart_care_adherence, mart_care_impact, mart_chw_workload.
Every step works on old data (no new concepts, empty care store).
"""
from __future__ import annotations

import datetime as dt
import json
from collections import defaultdict

import pandas as pd

TRIGGER_PATHWAY_SQL = """CASE "trigger" WHEN 'RISK_BAND_HIGH' THEN 'ENDOSCOPY_REFERRAL' WHEN 'ALARM_NO_SCOPE_90D' THEN 'ENDOSCOPY_REFERRAL'
                         WHEN 'HB_DROP' THEN 'ANAEMIA_WORKUP' WHEN 'HP_POS_UNTREATED' THEN 'HP_TEST_AND_TREAT' ELSE 'OTHER' END"""


def _has(con, t: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [t]).fetchone()[0] > 0


def build_care(con, sim_time, log=print):
    from care import snapshot
    try:
        snapshot.to_duckdb(con, log=log)
    except Exception as e:  # noqa: BLE001 - a broken care store must not stop the pipeline
        log(f"    care snapshot failed ({e}); building care marts from empty tables")
        from care.store import Store
        snapshot.to_duckdb(con, store=Store(":memory:"))
    S = pd.Timestamp(sim_time).strftime("%Y-%m-%d %H:%M:%S")
    _care_tables(con, S)
    _treatment(con)
    _journey(con, sim_time, log)
    _funnel(con)
    _adherence(con)
    _impact(con, S)
    _chw(con, S)
    n = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in
         ("pt_care_plan", "pt_care_task", "pt_journey", "pt_recovery", "mart_care_funnel", "mart_care_adherence")}
    log(f"    care marts: {n}")


def _care_tables(con, S: str):
    con.execute(f"""
        CREATE OR REPLACE TABLE pt_care_plan AS
        WITH t AS (SELECT plan_id, count(*) AS n_tasks,
                          count(*) FILTER (WHERE status IN ('SCHEDULED','DUE','NOTIFIED','OVERDUE','ESCALATED')) AS n_open,
                          count(*) FILTER (WHERE status = 'COMPLETED') AS n_completed,
                          count(*) FILTER (WHERE status IN ('OVERDUE','ESCALATED')) AS n_overdue,
                          max(escalation_level) AS max_escalation, sum(reminders) AS reminders
                   FROM care_tasks GROUP BY 1),
             n AS (SELECT plan_id, count(*) AS n_notifications, min(created_sim) AS first_notified FROM care_notifications GROUP BY 1)
        SELECT p.*, json_extract_string(p.context, '$.district_code') AS district_code,
               TRY_CAST(json_extract_string(p.context, '$.distance_km') AS DOUBLE) AS distance_km,
               date_diff('day', p.approved_at, coalesce(p.closed_sim, TIMESTAMP '{S}')) AS days_open,
               coalesce(t.n_tasks, 0) AS n_tasks, coalesce(t.n_open, 0) AS n_open, coalesce(t.n_completed, 0) AS n_completed,
               coalesce(t.n_overdue, 0) AS n_overdue, coalesce(t.max_escalation, 0) AS max_escalation,
               coalesce(t.reminders, 0) AS reminders, coalesce(n.n_notifications, 0) AS n_notifications, n.first_notified
        FROM care_plans p LEFT JOIN t ON t.plan_id = p.id LEFT JOIN n ON n.plan_id = p.id""")
    con.execute(f"""
        CREATE OR REPLACE TABLE pt_care_task AS
        SELECT t.*, p.pathway, p.facility_id, p.target_facility_id, p.display_id,
               json_extract_string(p.context, '$.district_code') AS district_code,
               date_diff('day', t.opens_at, coalesce(t.completed_at, TIMESTAMP '{S}')) AS days_open,
               CASE WHEN t.status IN ('SCHEDULED','DUE','NOTIFIED','OVERDUE','ESCALATED') AND t.due_at < TIMESTAMP '{S}'
                    THEN date_diff('day', t.due_at, TIMESTAMP '{S}') ELSE 0 END AS overdue_days,
               t.status IN ('SCHEDULED','DUE','NOTIFIED','OVERDUE','ESCALATED') AS is_open
        FROM care_tasks t JOIN care_plans p ON p.id = t.plan_id""")


def _treatment(con):
    if _has(con, "core_fact_treatment"):
        con.execute("""CREATE OR REPLACE TABLE pt_treatment AS SELECT t.patient_id, t.date, t.kind, t.value, t.value_coded,
                              t.value_numeric FROM core_fact_treatment t SEMI JOIN pt_patient p USING (patient_id)""")
    else:
        con.execute("""CREATE OR REPLACE TABLE pt_treatment (patient_id BIGINT, date TIMESTAMP, kind VARCHAR, value VARCHAR,
                       value_coded INTEGER, value_numeric DOUBLE)""")


def _rows(con, sql: str, params: list | None = None) -> list[dict]:
    r = con.execute(sql, params or [])
    cols = [d[0] for d in r.description]
    return [dict(zip(cols, x)) for x in r.fetchall()]


def _journey(con, sim_time, log):
    from care import journey, pathways
    now = pd.Timestamp(sim_time).to_pydatetime()
    has_alerts, has_risk = _has(con, "pt_alerts"), _has(con, "pt_risk")
    pop_sql = ["SELECT patient_id FROM pt_patient WHERE is_case", "SELECT patient_id FROM care_plans"]
    if has_alerts:
        pop_sql.append("SELECT patient_id FROM pt_alerts")
    if has_risk:
        pop_sql.append("SELECT patient_id FROM pt_risk WHERE risk_band = 'HIGH'")
    con.execute(f"CREATE OR REPLACE TEMP TABLE _jpop AS SELECT DISTINCT patient_id FROM ({' UNION '.join(pop_sql)}) "
                f"SEMI JOIN pt_patient USING (patient_id)")
    pts = {r["patient_id"]: r for r in _rows(con, """SELECT patient_id, is_case, dx_date, dead, death_date FROM pt_patient
                                                     SEMI JOIN _jpop USING (patient_id)""")}
    ev = defaultdict(list)
    for r in _rows(con, """SELECT patient_id, ts, event_type, concept_id, label, value_num, encounter_id FROM pt_timeline
                           SEMI JOIN _jpop USING (patient_id)
                           WHERE event_type IN ('VISIT', 'ENDOSCOPY', 'STAGING')
                              OR (event_type = 'VITAL' AND concept_id = 3000)
                              OR (event_type = 'LAB' AND concept_id IN (3100, 3107, 3125))
                              OR (event_type = 'DRUG' AND concept_id IN (6014, 6015))"""):
        ev[r.pop("patient_id")].append(r)
    tx = defaultdict(list)
    for r in _rows(con, "SELECT * FROM pt_treatment SEMI JOIN _jpop USING (patient_id)"):
        tx[r["patient_id"]].append(r)
    ecog = defaultdict(list)
    if _has(con, "stg_obs"):
        for r in _rows(con, """SELECT person_id AS patient_id, obs_datetime AS date, value_numeric AS value FROM stg_obs
                               WHERE concept_id = 5045 AND person_id IN (SELECT patient_id FROM _jpop) ORDER BY obs_datetime"""):
            ecog[r["patient_id"]].append(r)
    tum = {r["patient_id"]: r for r in _rows(con, "SELECT * FROM pt_tumour SEMI JOIN _jpop USING (patient_id)")} \
        if _has(con, "pt_tumour") else {}
    alerts = defaultdict(list)
    if has_alerts:
        for r in _rows(con, """SELECT patient_id, created_at, "trigger" FROM pt_alerts SEMI JOIN _jpop USING (patient_id)"""):
            alerts[r["patient_id"]].append(r)
    risk = {r["patient_id"]: r for r in _rows(con, "SELECT patient_id, first_high_at FROM pt_risk SEMI JOIN _jpop USING (patient_id)")} \
        if has_risk and "first_high_at" in [c[0] for c in con.execute("DESCRIBE pt_risk").fetchall()] else {}
    plans = defaultdict(list)
    names = {k: v["name"] for k, v in pathways.pathways().items()}
    tasks = defaultdict(list)
    for t in _rows(con, "SELECT * FROM care_tasks"):
        tasks[t["plan_id"]].append(t)
    for p in _rows(con, "SELECT * FROM care_plans"):
        p["tasks"] = tasks.get(p["id"], [])
        p["pathway_name"] = names.get(p["pathway"])
        plans[p["patient_id"]].append(p)
    first_n = dict(con.execute("SELECT patient_id, min(created_sim) FROM care_notifications GROUP BY 1").fetchall())
    jrows, rrows = [], []
    for pid, pt in pts.items():
        j = journey.compute(pt, ev.get(pid, []), treatment=tx.get(pid), ecog=ecog.get(pid), tumour=tum.get(pid),
                            alerts=alerts.get(pid), risk=risk.get(pid), plans=plans.get(pid), first_notification=first_n.get(pid),
                            now=now)
        for i, ph in enumerate(j["phases"]):
            jrows.append({"patient_id": pid, "seq": i + 1, "phase": ph["phase"], "start_date": ph["start"], "end_date": ph["end"],
                          "status": ph["status"], "milestones": json.dumps(ph["milestones"], default=str)})
        r = j["recovery"]
        if r:
            series = r.pop("series")
            rrows.append({"patient_id": pid, **r, "series": json.dumps(series, default=str)})
    jdf = pd.DataFrame(jrows, columns=["patient_id", "seq", "phase", "start_date", "end_date", "status", "milestones"])
    con.register("_j", jdf)
    con.execute("""CREATE OR REPLACE TABLE pt_journey AS SELECT CAST(patient_id AS BIGINT) AS patient_id, CAST(seq AS INTEGER) AS seq,
                   CAST(phase AS VARCHAR) AS phase, TRY_CAST(start_date AS DATE) AS start_date, TRY_CAST(end_date AS DATE) AS end_date,
                   CAST(status AS VARCHAR) AS status, CAST(milestones AS VARCHAR) AS milestones FROM _j""")
    con.unregister("_j")
    rcols = ["patient_id", "as_of", "dx_date", "intent", "gastrectomy", "weight_base", "weight_last", "weight_change_pct",
             "hb_last", "b12_last", "albumin_last", "ecog_last", "chemo_done", "chemo_planned", "missed_visits_12m",
             "recurrence", "next_visit_due", "series"]
    rdf = pd.DataFrame(rrows, columns=rcols)
    con.register("_r", rdf)
    con.execute("""CREATE OR REPLACE TABLE pt_recovery AS SELECT CAST(patient_id AS BIGINT) AS patient_id,
                   TRY_CAST(as_of AS DATE) AS as_of, TRY_CAST(dx_date AS DATE) AS dx_date, CAST(intent AS VARCHAR) AS intent,
                   CAST(gastrectomy AS BOOLEAN) AS gastrectomy, TRY_CAST(weight_base AS DOUBLE) AS weight_base,
                   TRY_CAST(weight_last AS DOUBLE) AS weight_last, TRY_CAST(weight_change_pct AS DOUBLE) AS weight_change_pct,
                   TRY_CAST(hb_last AS DOUBLE) AS hb_last, TRY_CAST(b12_last AS DOUBLE) AS b12_last,
                   TRY_CAST(albumin_last AS DOUBLE) AS albumin_last, TRY_CAST(ecog_last AS DOUBLE) AS ecog_last,
                   TRY_CAST(chemo_done AS INTEGER) AS chemo_done, TRY_CAST(chemo_planned AS INTEGER) AS chemo_planned,
                   TRY_CAST(missed_visits_12m AS INTEGER) AS missed_visits_12m, CAST(recurrence AS VARCHAR) AS recurrence,
                   TRY_CAST(next_visit_due AS DATE) AS next_visit_due, CAST(series AS VARCHAR) AS series FROM _r""")
    con.unregister("_r")


def _funnel(con):
    alerts = ""
    if _has(con, "pt_alerts"):
        alerts = f"""UNION ALL
            SELECT date_trunc('month', a.created_at) AS period, p.district_code, {TRIGGER_PATHWAY_SQL} AS pathway,
                   1 AS flagged, 0 AS approved, 0 AS notified, 0 AS attended, 0 AS endoscopy, 0 AS cancer_found, 0 AS early_stage
            FROM pt_alerts a JOIN pt_patient p USING (patient_id) WHERE "trigger" <> 'CARE_OVERDUE'"""
    con.execute(f"""
        CREATE OR REPLACE TABLE mart_care_funnel AS
        WITH plans AS (
          SELECT p.id, date_trunc('month', p.approved_at) AS period, coalesce(p.district_code, 'UNK') AS district_code, p.pathway,
                 p.n_notifications > 0 AS notified,
                 EXISTS (SELECT 1 FROM care_tasks t WHERE t.plan_id = p.id AND t.seq = 1 AND t.status = 'COMPLETED') AS attended,
                 EXISTS (SELECT 1 FROM care_tasks t WHERE t.plan_id = p.id AND t.type = 'ENDOSCOPY' AND t.status = 'COMPLETED') AS endoscopy,
                 coalesce(o.cancer_found, 0) = 1 AS cancer_found, o.stage_at_dx IN ('I', 'II') AS early
          FROM pt_care_plan p LEFT JOIN care_recommendation_outcomes o ON o.plan_id = p.id),
        x AS (
          SELECT period, district_code, pathway, 0 AS flagged, 1 AS approved, notified::INT AS notified, attended::INT AS attended,
                 endoscopy::INT AS endoscopy, cancer_found::INT AS cancer_found, coalesce(early, FALSE)::INT AS early_stage FROM plans
          {alerts})
        SELECT CAST(period AS DATE) AS period, district_code, pathway, sum(flagged)::INT AS flagged, sum(approved)::INT AS approved,
               sum(notified)::INT AS notified, sum(attended)::INT AS attended, sum(endoscopy)::INT AS endoscopy,
               sum(cancer_found)::INT AS cancer_found, sum(early_stage)::INT AS early_stage
        FROM x GROUP BY ALL ORDER BY 1, 2, 3""")


def _adherence(con):
    con.execute("""
        CREATE OR REPLACE TABLE mart_care_adherence AS
        WITH o AS (
          SELECT *, CASE WHEN channels LIKE '%CHW%' THEN 'APP+SMS+CHW' WHEN channels LIKE '%SMS%' THEN 'APP+SMS' ELSE 'APP' END AS channel,
                 CASE WHEN distance_km IS NULL THEN 'unknown' WHEN distance_km < 10 THEN '<10 km' WHEN distance_km < 25 THEN '10-25 km'
                      WHEN distance_km < 50 THEN '25-50 km' ELSE '50+ km' END AS distance
          FROM care_recommendation_outcomes WHERE adhered IS NOT NULL),
        d AS (
          SELECT 'channel' AS dim, channel AS level, adhered, days_to_completion FROM o
          UNION ALL SELECT 'distance', distance, adhered, days_to_completion FROM o
          UNION ALL SELECT 'sex', coalesce(sex, 'unknown'), adhered, days_to_completion FROM o
          UNION ALL SELECT 'age', coalesce(age_band, 'unknown'), adhered, days_to_completion FROM o
          UNION ALL SELECT 'district', coalesce(district_code, 'unknown'), adhered, days_to_completion FROM o
          UNION ALL SELECT 'pathway', pathway, adhered, days_to_completion FROM o)
        SELECT dim, level, count(*)::INT AS n, sum(adhered)::INT AS adhered, round(avg(adhered), 3) AS rate,
               median(days_to_completion) FILTER (WHERE adhered = 1) AS median_days
        FROM d GROUP BY ALL ORDER BY dim, level""")


def _impact(con, S: str):
    """Stage at diagnosis and 1-year survival, care-pathway vs usual-route diagnoses. Associational only."""
    if not _has(con, "core_gc_case"):
        con.execute("""CREATE OR REPLACE TABLE mart_care_impact (route VARCHAR, n INTEGER, early_stage_pct DOUBLE, surv_1y DOUBLE,
                       n_surv_eligible INTEGER, note VARCHAR, n_staged INTEGER, n_early INTEGER, n_dead_1y INTEGER)""")
        return
    con.execute(f"""
        CREATE OR REPLACE TABLE mart_care_impact AS
        WITH routed AS (
          SELECT c.patient_id, c.dx_date, c.stage_group, c.death_date, c.surv_days, c.event_death,
                 EXISTS (SELECT 1 FROM care_plans p WHERE p.patient_id = c.patient_id AND CAST(p.approved_at AS DATE) <= c.dx_date
                           AND c.dx_date <= CAST(p.approved_at AS DATE) + INTERVAL 365 DAY
                           AND p.pathway IN ('ENDOSCOPY_REFERRAL', 'ANAEMIA_WORKUP', 'HP_TEST_AND_TREAT')) AS via_care
          FROM core_gc_case c WHERE c.dx_date IS NOT NULL AND c.dx_date >= DATE '{S[:10]}' - INTERVAL 3 YEAR),
        r AS (SELECT CASE WHEN via_care THEN 'care_pathway' ELSE 'usual' END AS route, * FROM routed),
        routes AS (SELECT * FROM (VALUES ('care_pathway'), ('usual')) v(route))
        SELECT routes.route, count(r.patient_id)::INT AS n,
               round(100.0 * count(*) FILTER (WHERE r.stage_group IN ('I', 'II')) /
                     nullif(count(*) FILTER (WHERE r.stage_group IN ('I', 'II', 'III', 'IV')), 0), 1) AS early_stage_pct,
               round(1 - count(*) FILTER (WHERE coalesce(TRY_CAST(r.event_death AS INTEGER), 0) = 1 AND r.surv_days < 365)::DOUBLE /
                     nullif(count(*) FILTER (WHERE (coalesce(TRY_CAST(r.event_death AS INTEGER), 0) = 1 AND r.surv_days < 365) OR r.surv_days >= 365), 0), 3) AS surv_1y,
               count(*) FILTER (WHERE (coalesce(TRY_CAST(r.event_death AS INTEGER), 0) = 1 AND r.surv_days < 365) OR r.surv_days >= 365)::INT AS n_surv_eligible,
               'Synthetic data; associational comparison, not a causal effect estimate' AS note,
               -- the counts behind the two percentages (the API suppresses a percentage when any of them is small)
               count(*) FILTER (WHERE r.stage_group IN ('I', 'II', 'III', 'IV'))::INT AS n_staged,
               count(*) FILTER (WHERE r.stage_group IN ('I', 'II'))::INT AS n_early,
               count(*) FILTER (WHERE coalesce(TRY_CAST(r.event_death AS INTEGER), 0) = 1 AND r.surv_days < 365)::INT AS n_dead_1y
        FROM routes LEFT JOIN r USING (route) GROUP BY 1 ORDER BY 1""")


def _chw(con, S: str):
    con.execute(f"""
        CREATE OR REPLACE TABLE mart_chw_workload AS
        SELECT coalesce(district_code, 'UNK') AS district_code,
               count(*) FILTER (WHERE is_open)::INT AS open_visits,
               count(*) FILTER (WHERE is_open AND due_at < TIMESTAMP '{S}')::INT AS overdue,
               count(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= TIMESTAMP '{S}' - INTERVAL 30 DAY)::INT AS completed_30d
        FROM pt_care_task WHERE type = 'CHW_VISIT' GROUP BY 1 ORDER BY 1""")
