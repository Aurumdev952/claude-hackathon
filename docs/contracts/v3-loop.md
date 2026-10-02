# v3 "close the loop": frozen contracts

This is the shared interface between the parallel work tracks (L1 sim/generator, L2 care engine/API, L3 learning loop and
forecasting, L4 video, U1–U3 UI). Change it only together with every track that consumes it. The plan is in
`/root/.claude/plans/we-have-achieved-amazing-tender-map.md` (sections 1–8).

## 0. Glossary

- **sim time**: the simulated "now", stored in `data/sim_state/sim_state.json` (`{"sim_time": "2026-07-15T23:59:59"}`) and
  mirrored to the pipeline through `raw_sim_tick_log`. It starts at 2026-06-30T23:59:59. The hard end is 2027-12-31.
- **writeback**: new EMR rows that appear after the bootstrap. In local mode they are Parquet parts; in MySQL mode they are
  `INSERT`s. Writeback rows are either replayed pre-simulated future rows or rows created by the care engine or care world.
- **day**: integer days since 1970-01-01, the same convention as `generator/dates.py`.

## 1. Concepts (already added in Wave 0)

These are already added to `data/reference/concepts.yaml`, `shared/concepts.py` (`class C`) and
`generator/reference_tables.py`. Use the constants and never hard-code the numbers.

| What | Ids |
|---|---|
| Encounter types | 15 `CARE_COORDINATION`, 16 `PATIENT_REPORTED`, 17 `CHW_HOME_VISIT` |
| Care questions | `CARE_PATHWAY` 1010 (answers `PW_*` 7240–7245), `CARE_TASK` 1011 (text = task type), `NOTIFIED` 1012 (answers `CH_APP` 7250 / `CH_SMS` 7251 / `CH_CHW` 7252), `PT_CONFIRMED` 1013 (text), `TASK_OUTCOME` 1014 (7255 done / 7256 declined / 7257 not reached) |
| Survivorship labs | `B12` 3125 (pg/mL), `VIT_D` 3126, `CALCIUM` 3127 |
| Patient-reported (encounter 16) | `PRO_APPETITE` 4020, `PRO_PAIN` 4021, `PRO_ENERGY` 4022 (all 0–10), `PRO_DUMPING` 4023 (yes/no), `PRO_WEIGHT` 4024 (kg), `PRO_DOSE` 4025 (yes/no, value_text = course id) |
| Oncology | `CHEMO_CYCLE` 5063, `POSTOP_COMPLICATION` 5064, `RECURRENCE` 5070 (7220 none / 7221 local / 7222 distant), `SURV_IMAGING` 5071 (7230 NED / 7231 suspicious) |
| Drugs | `CYANOCOBALAMIN` 6017 (drug_id 18), `CALCIUM_VITD` 6018 (drug_id 19) |
| Orders | `ORD_B12` 8007, `ORD_FOLLOWUP` 8008, `ORD_CHW` 8009. The existing `ORD_ENDOSCOPY` 8000, `ORD_HP` 8001, `ORD_FBC` 8002 and `ORD_ONCOLOGY` 8004 are reused |

The concept tables reach DuckDB only after the generator re-runs (`make dev-data`). Any pipeline code that names a new
concept must not fail on old data where it is absent.

## 2. Writeback and EMR adapter (L1 owns; L2 calls it)

- **Module:** `care/emr.py`
  - `get_adapter()` returns `ParquetEMR` or `MySQLEMR`, selected by env `EMR_MODE=local|mysql` (default `local`).
  - `write(rows: dict[str, polars.DataFrame], tick: str) -> dict[str, int]` takes the table name and rows, with columns
    exactly as `generator/writers.py:COLUMNS[table]`. Missing optional columns are filled with null.
  - `next_ids(table: str, n: int) -> list[int]`
  - `supersede(patient_id: int, from_day: int, reason: str)`
  - `superseded() -> polars.DataFrame` returns columns `patient_id, from_day, reason, at_sim_time`.
- **Builder helpers:** `care/emr_rows.py`, an `EMRBuilder` modelled on the generator's `Recorder`.
  - It creates encounter, obs, order and drug_order rows for one patient with consistent visit, encounter and obs ids,
    `uuid`, `creator=2` (2 = "care engine" system user), and `date_created` = sim time.
  - L2 uses it for care-coordination encounters and patient check-ins. L1 uses it for care-world outcomes.
- **Parquet layout (local mode):**
  - `data/bulk/writeback/<table>/part-<seq:06d>.parquet`, plus `data/bulk/writeback/sim_tick_log/part-<seq>.parquet`
    with `(tick_id, sim_time, wall_time, encounters_added, obs_added)`.
  - `data/bulk/writeback/superseded.parquet`
  - `data/bulk/writeback/state.json` holds the id counters and the last seq.
- **Id ranges:**
  - Replayed future rows keep their generator ids.
  - Care-created rows use `CARE_ID_BASE = 1_900_000_000` plus a per-table counter. This fits int32 and sits above every
    generator id at scale 1.0.
- **Extract** (`pipeline/extract.py`):
  - New function `local_extract(con)`, enabled by `pipeline.run --extract-local` or env `EMR_MODE=local`.
  - It loads the writeback parts that are not yet ingested; ingested parts are tracked in `etl_local_parts(part_path)`.
  - It inserts only ids not already in `raw_<t>` (anti-join), then appends `sim_tick_log` parts to `raw_sim_tick_log`.
  - MySQL mode (`incremental_extract`) keeps the id watermark for ids below `CARE_ID_BASE`, plus a second watermark
    `<t>#care` for ids at or above it.
- **Supersede:** a superseded patient's pre-simulated future rows dated on or after `from_day` are never replayed. That
  covers the patient's encounters, the obs and orders of those encounters, and the patient's drug orders. The
  re-simulated trajectory replaces them.

## 3. Sim clock (L1)

- **Module:** `simulator/local.py`
  - `advance(days: int, *, on_progress=None) -> dict` returns
    `{tick_id, sim_time_from, sim_time_to, rows: {table: n}, care: {...}, pipeline_s, status}`.
  - The lock file is `data/sim_state/advance.lock`; a second caller gets `BusyError`.
  - `status() -> dict` returns `{sim_time, sim_end, auto: {enabled, seconds_per_day}, running_job}`.
- **Order inside `advance`:**
  1. Replay future rows in (t0, t1], excluding superseded ones.
  2. Run `care_world.step(t0, t1)`. It returns outcome rows to write plus `outcomes` for `care.engine`.
  3. Write the writeback parts and the tick log.
  4. Run `pipeline.run(do_extract=True, extract_local=True)` through the stage step.
  5. Run `care.engine.reconcile(t0, t1)`. It reads evidence straight from the new raw rows (§4), not from the serve DB,
     so reconciliation never lags a tick.
  6. Run the care snapshot (`care.snapshot.to_duckdb(con)`), then marts, score and publish.
  7. Write `data/sim_state/last_tick.json`. The API `_watch()` then broadcasts it.
- **Auto clock:** `python -m simulator.local --auto`, or `make sim-local`. It reads `data/sim_state/control.json`
  `{paused, seconds_per_day, demo_mode}`, which is the existing control file.
- **API control** (L2 implements the routes in `api/routers/admin.py`, calling `simulator.local`):
  - `POST /admin/sim {action:"advance", days}` returns `{job_id}`.
  - `GET /admin/sim/jobs/{id}` returns `{id, status: queued|running|done|failed, progress 0-1, step, result, error}`.
  - `GET /admin/sim/status` returns the output of `status()`.
  - The existing `pause`, `resume`, `demo_mode` and `fast_forward` actions keep working.

## 4. Care engine (L2 owns)

### 4.1 SQLite schema

The file is `data/analytics/care.sqlite`. Times are ISO sim-time strings, and every row carries `created_sim`.

```sql
care_plans(id TEXT PK,            -- 'CP-' + 8 hex
  patient_id INT, display_id TEXT, facility_id INT, pathway TEXT, status TEXT, -- ACTIVE|COMPLETED|CANCELLED|ESCALATED
  source_alert_id TEXT, trigger TEXT, approved_by TEXT, approved_at TEXT, channels TEXT /*json ["APP","SMS","CHW"]*/,
  model_id TEXT, risk_at_approval REAL, band_at_approval TEXT, propensity REAL,   -- for IPW (L3)
  due_override TEXT, target_facility_id INT, note TEXT, emr_encounter_id INT, created_sim TEXT, closed_sim TEXT)
care_tasks(id TEXT PK, plan_id TEXT, patient_id INT, seq INT, type TEXT, title TEXT,
  status TEXT,  -- SCHEDULED|DUE|NOTIFIED|COMPLETED|OVERDUE|ESCALATED|CANCELLED|DECLINED
  opens_at TEXT, due_at TEXT, completed_at TEXT, evidence TEXT /*json {table, id, concept_id, value, date}*/,
  result TEXT /*e.g. NEGATIVE|POSITIVE|CANCER_FOUND|NORMAL|LOW|...*/, reminders INT, last_reminder_sim TEXT,
  escalation_level INT /*0 none,1 SMS,2 CHW,3 doctor*/, created_sim TEXT)
care_events(id INTEGER PK AUTOINCREMENT, plan_id TEXT, task_id TEXT, patient_id INT, kind TEXT, detail TEXT /*json*/,
  actor TEXT /*doctor|patient|system|chw*/, sim_time TEXT, wall_time TEXT)
notifications(id TEXT PK, patient_id INT, plan_id TEXT, task_id TEXT, channel TEXT /*APP|SMS|CHW*/,
  template_key TEXT, title TEXT, body TEXT, created_sim TEXT, delivered_sim TEXT, read_sim TEXT, acted_sim TEXT)
patient_reports(id TEXT PK, patient_id INT, kind TEXT /*CHECKIN|DOSE|CONFIRM*/, payload TEXT /*json*/,
  emr_encounter_id INT, created_sim TEXT)
recommendation_outcomes(plan_id TEXT PK, patient_id INT, pathway TEXT, approved_sim TEXT, first_completion_sim TEXT,
  days_to_completion INT, adhered INT /*0/1*/, on_time INT, finding TEXT, cancer_found INT, stage_at_dx TEXT,
  channels TEXT, reminders INT, escalation_level INT, district_code TEXT, distance_km REAL, sex TEXT, age_band TEXT,
  risk_at_approval REAL, propensity REAL, closed_sim TEXT)
```

**Snapshot to DuckDB:** `care.snapshot.to_duckdb(con)` copies all six tables into the work DB as `care_plans`,
`care_tasks` and so on. `publish.py` must copy the `care_*` tables too, as `SERVE_EXTRA` or a prefix. The serve copy is
read-only and is used by the agent, video, ministry marts and `ml/`.

**Pathways:** `config/care_pathways.yaml`. Task types are:

`ENDOSCOPY`, `PATHOLOGY_REVIEW`, `RESULT_DISCUSSED`, `HP_TEST`, `HP_TREATMENT`, `HP_TEST_OF_CURE`, `HB_RECHECK`,
`IRON_COURSE`, `ONCOLOGY_INTAKE`, `STAGING_CT`, `MDT_PLAN`, `SURGERY`, `CHEMO_CYCLE`, `FOLLOWUP_VISIT`, `B12_CHECK`,
`B12_INJECTION`, `NUTRITION_REVIEW`, `SURVEILLANCE_IMAGING`, `PAIN_REVIEW`, `CHW_VISIT`.

**Evidence rules.** Each task type has one evidence rule, matching a fact dated on or after `opens_at`. The engine
module `care/evidence.py` defines the mapping:

| Task | Evidence |
|---|---|
| `ENDOSCOPY` | encounter type 5 |
| `HP_TEST` / `HP_TEST_OF_CURE` | obs concept 3120, 3121, 3122 or 5006 |
| `HB_RECHECK` | obs concept 3100 |
| `B12_CHECK` | obs 3125 |
| `FOLLOWUP_VISIT` | encounter type 3 or 7 at any facility |
| `HP_TREATMENT` | drug_order for 6001+6002 or 6003/6004 |
| `IRON_COURSE` | drug 6005 |
| `SURGERY` | obs 5061 = 7000 |
| `CHEMO_CYCLE` | obs 5063 |
| `CHW_VISIT` | encounter type 17 |

**Public functions** (`care/engine.py`):
- `create_plan(patient_id, facility_id, pathway, *, alert_id=None, due_override=None, channels=None, target_facility_id=None, note=None, actor="doctor") -> dict`
- `preview(patient_id, pathway, ...) -> {tasks, messages}`
- `reconcile(t0, t1, con) -> {completed, overdue, reminders, escalations, new_tasks}`
- `patch_task(task_id, action: complete|decline|reschedule, ...)`
- `plans_for(patient_id)`, `worklist(facility_id)`, `notifications_for(patient_id)`, `record_checkin(patient_id, payload)`

**Messages:** `care/messages.yaml`, English only. Keys are `<pathway>.<task>.<stage>` where stage is
`approved|reminder|due|overdue|completed`. Bodies are plain advice ("Please visit {facility} for a check-up by {date}").
These words are forbidden in any body: cancer, malignant, tumour, tumor, carcinoma, oncology, biopsy result. A test
enforces this.

### 4.2 API

All endpoints are under `/api/v1` and use the standard envelope `{meta, data}`.

**Doctor** (`X-Role: doctor`, `X-Facility-Id`):
- `GET /care/pathways` returns
  `[{id, name, description, triggers, tasks:[{type,title,due_days}], default_channels}]`.
- `POST /care/notifications/preview {patient_id, pathway, due_override?, channels?}` returns
  `{tasks:[...], messages:[{channel,title,body}]}`.
- `POST /care/plans {patient_id, pathway, alert_id?, due_override?, channels?, target_facility_id?, note?}` returns
  `{plan, tasks, notifications}` with status 201.
- `GET /care/plans?status=` and `GET /patients/{id}/care` return `{plans:[{...plan, tasks:[...], events:[...]}]}`.
- `PATCH /care/tasks/{id} {action, reason?, due_at?}`.
- `GET /care/worklist` returns `[{task, plan, patient:{patient_id, display_id, given_name, family_name, age, sex}, p_adhere, priority}]`.
  Names are allowed here because this is the doctor UI.
- `GET /patients/{id}/journey` returns
  `{phases:[{phase,start,end,status,milestones:[{date,label,kind}]}], recovery:{series:{weight,hb,b12,albumin,ecog}, chemo:{done,planned}, next_visit, missed_visits, recurrence}}`.

**Ministry** (aggregates only; cells with n < 5 are suppressed to `null` with a `"<5"` label):
- `GET /care/funnel?from&to&district`
- `GET /care/adherence?by=channel|distance|sex|age|district`
- `GET /care/impact`
- `GET /care/chw-workload`

**Patient** (`X-Role: patient`, `X-Patient-Id: <patient_id>`). Every endpoint returns only that patient's data:
- `GET /me` returns `{patient_id, display_id, given_name, facility:{id,name}, chw:{name:"CHW (Synthetic)", phone:"+250 7xx xxx xxx"}}`.
- `GET /me/notifications`, `POST /me/notifications/{id}/read`, and `POST /me/notifications/{id}/acted`.
- `GET /me/plan`, which returns the same shape as `/patients/{id}/care`, minus doctor notes and model fields.
- `GET /me/journey`, which is the patient-friendly version of the doctor journey.
- `POST /me/checkins {appetite, pain, energy, dumping, weight_kg?}`, which writes encounter 16 through the EMR adapter.
- `POST /me/doses {course, taken: bool}`
- `POST /me/tasks/{id}/confirm {text}`
- `GET /patient-app/demo-patients` returns `[{patient_id, display_id, plan_count, has_notifications}]`. It needs no role
  and is for the demo picker only.

`deps.role()` accepts `patient`. `Role` gains `patient_id`. Without `X-Patient-Id` the API returns 400
`PATIENT_REQUIRED`. Ministry and patient callers get 403 on every doctor route, and doctor callers get 403 on `/me*`.

### 4.3 WebSocket

`api/ws.py`:
- **Subscribe:** after connecting, a client may send `{"subscribe":{"role":"doctor","facility_id":123}}` or
  `{"subscribe":{"role":"patient","patient_id":456}}`. Without a subscription the client gets only broadcast events
  (backward compatible).
- **New targeted events:**
  - `{"type":"care_update","facility_id","patient_id","plan_id","task_id","kind"}`, sent to doctors of that facility.
  - `{"type":"notification","patient_id","notification":{id,channel,title,body,created_sim}}`, sent to that patient.
    The doctor at the facility also gets a `care_update`.
  - `{"type":"sim_job","job_id","status","progress","step"}`, broadcast to everyone.
- The engine queues events in `care.sqlite` (`outbox` table: id, payload, created). The API `_watch()` drains the queue
  every 2 s and dispatches. This works because the simulator runs in another process.

### 4.4 Additive details (L2, backward compatible)

- **Extra columns:** `care_plans.context` (json clinical facts at approval: alarm, gastrectomy, advanced, hb_baseline,
  distance_km, district_code, sex, age_band), `care_tasks.occurrence` (index of a recurring task, NULL for one-off
  tasks), `created_sim` on `care_events` and `recommendation_outcomes`. Task `reminders` counts the ladder steps passed.
  A recurring occurrence whose next window opens unattended is closed as `CANCELLED` with `result = 'MISSED'`.
- **Snapshot names in DuckDB / serve:** `care_plans`, `care_tasks`, `care_events`, `care_notifications`,
  `care_patient_reports`, `care_recommendation_outcomes` (all `care_` so publish copies them). Sim-time columns are
  TIMESTAMP.
- **Evidence for task types not in the §4.1 table:** PATHOLOGY_REVIEW encounter 6; RESULT_DISCUSSED encounter 3/7;
  ONCOLOGY_INTAKE encounter 7; STAGING_CT obs 5040; MDT_PLAN obs 5060 (result CURATIVE/PALLIATIVE/BSC); B12_INJECTION
  drug 6017; NUTRITION_REVIEW obs 3000 or 3107; SURVEILLANCE_IMAGING obs 5071; PAIN_REVIEW encounter 3/7 or drug 6016.
  HP_TREATMENT accepts any of drugs 6001-6004. A fact closes at most one task per plan.
- **API:** `GET /care/pathways` is also open to the ministry (configuration only; patient role 403). Doctor care routes
  return 403 `FORBIDDEN` for a patient not linked to the facility (and not on a plan approved at / targeted to it).
  A patient addressing another patient's notification or task gets 403. `POST /admin/sim advance` takes days 1-90 and
  returns 409 `SIM_BUSY` while an advance runs. `GET /patients/{id}/journey` adds `source` (`pt_journey`|`live`) and
  `recovery.summary` (the pt_recovery scalars). `GET /me/notifications` items carry `greeting` ("Hi {first name},")
  for APP messages only; stored bodies never contain a name.
- **Marts:** `pt_treatment` (published copy of `core_fact_treatment` for the cohort; the live journey uses it),
  `pt_recovery.series` (json weight/hb/b12/albumin/ecog series).

## 5. Pipeline marts (L2: care; L3: forecasting and monitoring)

| Table | Owner | Key columns |
|---|---|---|
| `core_fact_treatment` | L2 | patient_id, date, kind (INTENT, GASTRECTOMY, CHEMO_REGIMEN, CHEMO_CYCLE, RECURRENCE, SURV_IMAGING, B12_INJ), value |
| `pt_journey` | L2 | patient_id, seq, phase, start_date, end_date, status (done/current/upcoming/missed), milestones JSON |
| `pt_recovery` | L2 | patient_id, as_of, dx_date, intent, gastrectomy, weight_base, weight_last, weight_change_pct, hb_last, b12_last, albumin_last, ecog_last, chemo_done, chemo_planned, missed_visits_12m, recurrence, next_visit_due |
| `pt_care_plan` / `pt_care_task` | L2 | snapshot + derived (days_open, overdue_days) |
| `mart_care_funnel` | L2 | period, district_code, pathway, flagged, approved, notified, attended, endoscopy, cancer_found, early_stage |
| `mart_care_adherence` | L2 | dim, level, n, adhered, rate, median_days |
| `mart_care_impact` | L2 | route (care_pathway/usual), n, early_stage_pct, surv_1y |
| `mart_chw_workload` | L2 | district_code, open_visits, overdue, completed_30d |
| `ml_feedback_labels` | L3 | patient_id, landmark_date, label, source, verified, propensity |
| `ml_retrain_runs` | L3 | run_id, sim_time, champion_id, challenger_id, metrics JSON, gates JSON, decision, decided_by, decided_at |
| `mart_model_monitoring` | L3 | as_of, model_id, metric (psi:<feature>, calib_slope, alert_volume, ppv_verified), value |
| `ext_registry` / `ext_surveys` / `ext_population` | L1 → refs | see §6 |
| `mart_forecast` | L3 | series_id, geo_level, geo_code, sex, age_band, freq (Y/M), period (date), kind (history/forecast), mean, lo80, hi80, lo95, hi95, model, run_id |
| `mart_forecast_drivers` | L3 | geo_code, from_year, to_year, component (population/ageing/risk), cases, pct |
| `mart_risk_factor_forecast` | L3 | indicator, geo_code, sex, year, kind (survey/forecast/nowcast), value, lo95, hi95 |
| `ml_forecast_backtest` | L3 | series_id, origin_year, horizon, mape, cov80, cov95, crps |
| `mart_forecast_tracking` | L3 | series_id, period, forecast_run_id, forecast_mean, actual |
| `mart_operational_forecast` | L3 | district_code, month, metric (gi_visits, high_flags, endoscopy_demand, care_tasks), mean, lo80, hi80 |

`series_id` uses the existing format `GEO|SEX|AGE|CASEDEF`, for example `NATIONAL|ALL|ALL|CONFIRMED`.

`ml_model_registry` gains these columns: `status` (champion/challenger/retired), `parent_model_id`, `n_feedback_labels`,
`promoted_at`, `promoted_by`, `promote_reason`. They are added with `ALTER ... ADD COLUMN IF NOT EXISTS`, and existing
rows get champion where `is_active`.

## 6. External synthetic sources (L1)

All three are written to `data/external/`, carry a `source_note` column with the text "(Synthetic)", and are loaded by
`pipeline/refs.py` into `ext_*`.
- **`registry_incidence.parquet`:** year 2000–2026, district_code, sex (M/F), age_band (5-year bands `00-04` to `85+`),
  cases, completeness, morphology_intestinal_pct, stage_I..IV pct.
- **`risk_factor_surveys.parquet`:** survey (`DHS-2005`, …), year, province_code, sex, age_band (`15-29`, `30-49`, `50+`),
  indicator (hp_seroprev, smoking_current, high_salt, alcohol_any, smoked_food), value, lo95, hi95, n.
- **`population_projections.parquet`:** year 2000–2035, district_code, sex, age_band (5-year), population, kind
  (estimate/projection).

## 7. Forecast and model API (L3)

These are ministry only. Promote and rollback require `X-Role: ministry`, with an `X-Actor` header for the audit log.
- `GET /forecast/series?geo=NATIONAL&code=&sex=ALL&age=ALL&freq=Y` returns `{history:[...], forecast:[...], model, backtest:{mape,cov80,cov95}}`.
- `GET /forecast/drivers?geo&code`
- `GET /forecast/risk-factors?indicator&province`
- `GET /forecast/operational?district`
- `GET /forecast/backtest`
- `GET /forecast/map?year=2031&metric=asr|change`
- `POST /forecast/scenario {hp_coverage_delta, smoking_delta, salt_delta, endoscopy_access:[district_code], until: 2031}`
  returns `{baseline:[{year,mean,lo95,hi95}], scenario:[...], cases_averted, stage_shift:{early_pct_baseline, early_pct_scenario}, assumptions:[...]}`.
  It must respond in under 300 ms.
- `GET /models/learning-loop` returns `{champion, challenger, gates:[{name, value, threshold, pass}], history:[ml_retrain_runs], feedback:{n, by_source}, monitoring:{...}}`.
- `POST /models/{id}/promote {reason}` and `POST /models/{id}/rollback {reason}`. Both re-score and publish
  synchronously and return a job id like the sim jobs.
- `POST /models/retrain` returns `{job_id}`.

### 7.1 Additive details (L3, backward compatible)

- **Tables.** `mart_forecast` adds `metric` (`cases` | `asr`; monthly rows use the operational metric names) and
  `cases_obs` (observed count on history rows, for suppression). Yearly series ids end in `REGISTRY` when the synthetic
  registry (`ext_registry`) is the source, and in `CONFIRMED_PROBABLE` for the EMR fallback; monthly national totals
  use `NATIONAL|ALL|ALL|OPS`. `mart_forecast_drivers` adds `geo_level`, `cases_from`, `cases_to`, `total_change`
  (`pct` = component / cases_from x 100). `mart_risk_factor_forecast` adds `n`, `source`, `period`, `freq` (Y/M) and
  the kind `fitted` (trend inside the survey years). `mart_operational_forecast` adds the metric `endoscopy_capacity`
  (mean only) and `as_of`; national rows use `district_code = 'RW'`. `mart_forecast_tracking` adds `forecast_lo80`,
  `forecast_hi80`, `abs_pct_error`, `in_band80`. `ml_forecast_backtest` adds `year`, `actual`, `forecast`, `model`;
  `crps` is scaled by the actual. `ml_feedback_labels` adds `label_kind` (cancer/hp), `risk_at_landmark`,
  `outcome_date`, `model_id`, `plan_id`. `mart_model_monitoring` adds `n`, `detail` and the metrics `high_count`,
  `verified_outcomes`. `ml_retrain_runs` adds `n_feedback_labels`, `train_window`, `runtime_s`, `started_at`; decision is
  `pending` (all gates pass) | `gates_failed` | `promoted` | `rolled_back` | `rolled_back_to`. New: `ml_model_audit`
  (audit_at, sim_time, action, model_id, previous_model_id, tier, actor, reason), `ml_forecast_runs`,
  `ml_forecast_coef`, `ml_forecast_scenario_base`, `ml_forecast_series`, `ml_forecast_hist`, `ml_monitoring_hist`.
- **API.** `/forecast/series` also takes `metric=cases|asr` (default cases; with `freq=M`: gi_visits, high_flags,
  endoscopy_demand, care_tasks, endoscopy_capacity) and `case_def`; history rows with fewer than 5 observed cases are
  returned as `mean: null, cases_label: "<5"`. `/forecast/map` also takes `metric=cases`. The scenario response adds
  `cases_averted_range`, `stage_shift.districts_gaining_access`, `coefficients` and `elapsed_ms`; `smoking_delta` and
  `salt_delta` are relative changes (-0.2 = -20%), `hp_coverage_delta` is the share of infected people treated (0-1).
  `GET /forecast/meta` returns the forecast run and the scenario coefficients. `POST /models/{id}/promote` takes an
  optional `force` (a challenger whose run failed a gate returns 409 `GATES_FAILED` without it); rollback with the id
  of the current champion restores the model it replaced. Job status: `GET /models/jobs/{id}`.
- **Schedule.** `ml.retrain.maybe_retrain(sim_time)` retrains the challenger (+ adherence model) and refits the
  forecasts every 30 sim days; the sim clock calls it after a tick (it opens the work DB and republishes itself).
- **Adherence.** `ml.adherence.predict_p_adhere(rows)` returns P(on time) for worklist rows (pathway, channels,
  distance_km, sex, age_band, risk_at_approval); the config prior is used until 50 outcomes exist.

### 7.2 Additive details (U2, backward compatible)

- `GET /forecast/series` history rows add `completeness` (registry completeness for that year, case-weighted national
  share) when the source is the registry; the Outlook dashes years below 0.85. `GET /forecast/backtest` adds
  `tracking` (rows of `mart_forecast_tracking`; empty until sim time passes a forecast year).
- Learning-loop gate `high_volume_change` passes when the relative change is within +/-25% **or** the absolute change
  is at most max(10, 0.5% of scored patients) (`config/forecast.yaml` gates `high_volume_abs_min`, `high_volume_abs_pct`).
- `POST /admin/sim {action:"auto_start", seconds_per_day}` (5-3600) and `{action:"auto_stop"}`: an in-API loop submits
  `advance(1)` jobs at that pace (control.json `api_auto` {enabled, seconds_per_day, owner, beat, stopped_reason}); it
  skips while any advance runs or while `simulator.local --auto` is alive, and stops at the sim end (409 `SIM_END` on
  start). `auto_start` also sets control.json `paused=false, seconds_per_day`; `auto_stop` sets `paused=true`.
  `GET /admin/sim/status` adds `auto.api` {enabled, requested, seconds_per_day, running, owner, next_tick_at, ticks,
  last_job_id, last_error, stopped_reason} and `auto.source` (`process` | `api` | null); `auto.enabled` is true when
  either clock runs.

## 8. Video (L4)

- **Package:** `video/` (pnpm, ESM). Exports compositions `PatientCaseSummary` and `MinistryReel` (plus `MinistryReelVertical`).
- **Props:** zod schemas in `video/src/props.ts`, which must have no Node imports because the frontend imports it
  through the `@video` alias.
  - `PatientVideoProps`:
    - `{display_id, facility, sim_date, synthetic:true}`
    - `risk:{t1_score, t2_prob, ensemble_prob, band, top_reasons:[{label, value, direction}]}`
    - `organs:[{id, label, score, conditions:[{name, date, severity}], labs:[{name, unit, series:[{date, value}], low, high}]}]`
    - `timeline:[{date, type, label, organ_ids}]`
    - `care:{plans:[{pathway, status, tasks:[{title, status, due, completed}]}]} | null`
    - `journey:{phases:[...], recovery:{...}} | null`
    - `tumour | null`
    - **No names.**
  - `MinistryReelProps`:
    - `{period:{from, to}, filters, kpis:[{label, value, unit, delta}], national_asr:[{year, value, lo, hi}], joinpoint:{year, apc_before, apc_after}}`
    - `districts:[{code, name, values_by_year:{[year]: number}}]`, `geo: GeoJSON (simplified)`, `hotspots:[code]`
    - `young_onset:[{year, value}]`, `cascade:[{step, n}]`, `stage_mix:[{year, I, II, III, IV}]`
    - `care:{funnel, adherence} | null`, `forecast:{history, forecast} | null`, `models:{auroc, auprc, ppv}`
    - `messages:[string]`
- **Server:** `video/src/server.ts` (Hono, port `VIDEO_PORT=8790`).
  - `POST /video/jobs {kind:"patient"|"ministry"|"ministry_vertical", params}`. For a patient, params is
    `{patient_id}`. For the ministry, params is `{from, to, sex, age, def}`. Role headers are forwarded to the API.
    Returns `{job_id, cached}`.
  - `GET /video/jobs/:id` returns `{status, progress, url, poster_url, error}`.
  - `GET /video/files/:hash.mp4` and `GET /video/files/:hash.png`.
  - `GET /video/health`
  - `GET /video/props/:kind?...` returns the built props, for the frontend Player preview.
- **Frontend:** Vite proxies `/video` to `:8790`. The alias is `@video` → `../video/src`.

**L4 implementation notes (additive, backward compatible):**
- Props: `geo`, `models`, `joinpoint` may be `null`; scenes whose data is null or fully suppressed are skipped.
  Optional extras: patient `risk.t1_band`, `risk.thresholds{medium,high}`, `timeline[].abnormal`, `alerts[]`
  (`{trigger,severity,summary}`), `next_step`; ministry `kpis[].{delta_label,higher_is_better,spark,decimals}`,
  `joinpoint.{fitted,aapc}`, `map_label`, `smoothed{label,values}` (pooled EB map), `young_onset_label`,
  `stage_mix_label`, `care.adherence_label`, `forecast.label`, `models.{sens_at_spec90,lead_time_days,name}`, `sim_date`.
  Patient organ ids pair `kidney_l/kidney_r` and `lung_l/lung_r` into `kidneys` and `lungs`.
- `values_by_year` holds 3-year pooled ASR keyed by the window's end year (single-year district rates are mostly
  suppressed). `stage_mix` falls back to 3-year blocks when fewer than 3 years pass the small-cell rule.
- Server: `GET /video/jobs/:id/events` (SSE, same fields as the job); the job view adds `download_url`
  (`?download=1` sets `Content-Disposition: attachment`) and `render_seconds`. `/video/files` supports Range.
  `GET /video/props/:kind` returns the props object with an `X-Composition` header. The cache key includes a hash of
  the composition sources. The API base is `VIDEO_API_URL` (or `API_URL` + `/api/v1`).

## 9. Frontend roles (U1)

- **Role store:** `role: "ministry"|"doctor"|"patient"` plus `patientId`. `client.ts` sends `X-Patient-Id`.
- **Routes:**
  - `/patient` (phone frame and demo picker), `/patient/app` (full-screen PWA scope)
  - `/outlook`, `/programme` (ministry; the follow-up programme view, nav label "Follow-up")
- **Nav:** the ministry gains "Outlook" and "Care programme". The doctor workspace gains the "Follow-ups" and "In recovery" tabs.

## 10. L1 implementation notes (additive, backward compatible)

- **§2 adapter extras:** `superseded()` also returns `seq` (a supersede record applies only to rows created before
  it). Re-simulated rows dated after the current tick are stored in `writeback/deferred/<table>/part-*.parquet` (column
  `_sup` = the supersede seq that created them) and replayed by date like the generator future. `ParquetEMR.read(table)`,
  `log_tick(...)`, `defer(...)`, `deferred()` and `care.emr.window()` / `drop_superseded()` helpers exist. Care-created
  rows get a deterministic `uuid` and `date_created = max(sim time, event time)`.
- **Interventions:** `generator/intervention.py` `resimulate_from_endoscopy(patient_id, endo_day, site, *, seed)` ->
  `(rows, update)`; `commit()` writes rows <= tick end and defers the rest. Every call is logged in
  `writeback/interventions.parquet` (latent truth: original vs new stage, dx day, curative probability, death day).
  `patient_id` is the EMR id; persons first seen after the history end map back through `_person_id_map.parquet`.
- **§3 clock extras:** `advance(days, *, on_progress, fast=True, run_pipeline=True, care_world=True,
  learning_loop=True, seed=None)`. Progress is also written to `data/sim_state/advance_progress.json`; `status()` adds
  `days_left`, `last_tick`, and `auto.{running, paused, demo_mode}`. `last_tick.json` keeps the `simulator/tick.py`
  fields and adds `rows`, `care`, `care_world`, `learning_loop`, `timings`. `pipeline.run --fast` reuses the heavy
  population marts (joinpoint, spatial, survival, cox, warning, rate_surface) within a sim month.
- **Latent tables (v3 generator):** `gastric_cases.parquet` adds `case_seed, sojourn_months, stage_months (list),
  bg_death_day, hb_decline_start/rate, wt_loss_start/rate, intent, gastrectomy, gastrectomy_type, surgery_day, regimen,
  chemo_planned, chemo_done, recurrence_day, recurrence_type, lost_to_fu_day`; `persons.parquet` adds `home2, hb_base,
  height, bmi, alcohol_heavy, nsaid, atrophy_day`. Survivorship rows: B12 (3125) + cyanocobalamin (drug 18), vitamin D /
  calcium, albumin, ECOG at every oncology RETURN visit, chemo cycle visits (5063 = planned cycle number, gaps = missed
  cycles), surgical ADMISSION/DISCHARGE with 5064, recurrence 5070, surveillance CT 5071.
- **§6 column names:** registry `stage_I_pct, stage_II_pct, stage_III_pct, stage_IV_pct` plus `expected_true_cases`,
  `population` (registry denominators) and `provisional` (2026); surveys add `design_effect`.

## 11. Review fixes (F1, additive, backward compatible unless noted)

- **§2 MySQL extract:** the care id range (`>= CARE_ID_BASE`) is extracted by an anti-join on the id, not a watermark:
  deferred re-simulated rows get their ids when the intervention runs but reach MySQL later. `<t>#care` in
  `etl_watermark` is kept as the largest care id seen (informational).
- **§3 clock:** after `care_world.step` the supersede filter is applied again to the rows collected for replay (an
  intervention inside the tick drops that tick's original rows too). `advance_progress.json` is written with
  `running: false, step: "failed", error` when an advance fails; `status().running_job` also requires the lock to be
  held. `simulator.local.acquire(label)` / `exclusive(label)` / `lock_free()` expose the advance lock: model jobs
  (promote / rollback / retrain, API and `python -m ml.retrain`) hold it, so they never run next to an advance (409
  `MODEL_JOB_BUSY` / `SIM_BUSY`). `reconcile(t0, t1, con, outcomes=...)` receives the care world's outcomes.
- **§3 API control:** `POST /admin/sim` is a demo control open to every role, but needs a recognised `X-Role` (400
  `ROLE_REQUIRED` without one). Jobs carry `requested_by` (`role[:facility|patient id]`), control-file actions write
  `updated_by`.
- **§4.1 evidence:** a fact counts from the start of the task's opening *day* (not before `created_sim`), so a visit
  earlier on the day a task opens at 23:59:59 closes it. Serve-DB facts carry a unique `key` (stored in the task
  evidence json). The care world acts at most once per task (`writeback/care_world_actions.jsonl`), draws declines
  once per notification attempt (task + `reminders`), and the engine closes a declined task as `DECLINED` (event actor
  `patient`, detail `source: care_world`, TASK_OUTCOME 7256); a plan whose tasks were declined and none completed
  closes as `CANCELLED`. CHEMO_CYCLE obs 5063 = the cycle number within the plan.
- **§4.1 ids:** plan / task / notification / report ids are deterministic hashes of their content (`CP-`/`CT-`/`NT-`/
  `PR-` + 8 hex, re-salted on a collision); EMR rows written by the engine get uuid5(table:id) like `care.emr`. One open
  (ACTIVE/ESCALATED) plan per patient + pathway is enforced inside the create transaction and by the partial unique
  index `ux_plans_open`. `reconcile` and `patch_task` run their read-modify-write in one `BEGIN IMMEDIATE`.
- **§4.1 outcomes:** `care_plans.propensity` is NULL at approval (the risk score is not a propensity).
  `recommendation_outcomes.cancer_found` is 1/0 only for ENDOSCOPY_REFERRAL / ANAEMIA_WORKUP plans with a completed
  ENDOSCOPY (1 = diagnosis or CANCER_FOUND between approval and endoscopy + 60 days; 0 = 60 days after the endoscopy
  without one); NULL otherwise (other pathways, no endoscopy, pending, or diagnosed before approval). Outcomes of
  screening plans closed in the last 180 days are refreshed each reconcile.
- **§4.2 ministry:** all care aggregates use `api/suppress.py`: primary (1-4), complementary across the rows of a
  breakdown against its totals (funnel by district and by pathway, adherence levels, impact routes, CHW districts),
  in-row complements (n - adhered, cancers found - early stage, open - overdue) and derived values (rate, median_days,
  early_stage_pct, surv_1y) hidden when a count behind them is. A hidden cell's `<field>_label` is `"<5"` when the value
  is small and `"suppressed"` when it is 5+ and hidden only to protect a small one. `mart_care_impact` adds `n_staged`,
  `n_early`, `n_dead_1y` (used for suppression, not returned).
- **§4.2 patient:** `/me/plan` drops the `pathway` code (`pathway_name` stays) and maps diagnosis-revealing task types
  to neutral codes (ONCOLOGY_INTAKE -> SPECIALIST_VISIT, STAGING_CT / SURVEILLANCE_IMAGING -> SCAN, MDT_PLAN -> TEAM_PLAN,
  SURGERY -> OPERATION, CHEMO_CYCLE -> TREATMENT_CYCLE, PATHOLOGY_REVIEW -> LAB_REVIEW, RESULT_DISCUSSED -> RESULTS_VISIT,
  PAIN_REVIEW -> COMFORT_REVIEW; others unchanged, field name `type` kept). `/me/notifications` `template_key` becomes
  `care.<neutral task>.<stage>`. (Not backward compatible for a client reading `pathway` from `/me/plan`.)
- **§7.1 learning loop:** `ml_feedback_labels` adds `ipw_weight` = P(verified) / P(verified | x), clipped to [0.1, 10];
  care-plan propensities come from a logistic model of "verified label exists" on logit risk + band + facility tier.
  Care plans give cancer labels only as in §4.1 outcomes above and `hp` labels from the first H. pylori test. The
  challenger's `high_cut` / `medium_cut`, `ppv_at_high` and the HIGH-volume gate use the production quantity (Tier 2 +
  Tier 3 ensemble when Tier 3 is active). Rolling back the champion restores the model it replaced when it was
  *promoted* (no ping-pong); without one the API returns 409 `NO_PREDECESSOR`. `GET /models/learning-loop`
  `running_job` is live. The adherence model drops rows whose target is still NULL.

## 12. U1 implementation notes (additive, backward compatible)

- **API fields for the UI:** `GET /me/doses` returns the caller's dose taps `[{id, course, taken, created_sim}]` (newest
  first; patient role only). `/me/plan` plans add `target_facility_name` (the next-step card names the facility).
  `GET /patients?status=diagnosed` rows add `journey: {phase, phase_status, phase_start, intent, gastrectomy,
  missed_visits, next_visit, recurrence, chemo_done, chemo_planned, weight_change_pct}` (current `pt_journey` phase,
  else the latest done one, plus `pt_recovery` scalars) for the doctor's "In recovery" tab. `/me/journey` `recovery`
  now carries `next_visit`, `treatment_cycles` and `missed_visits` whichever shape the journey came from.
- **Frontend:** `/patient` (phone simulator, event log, simulate strip) and `/patient/app` (full screen). The PWA
  manifest is `/manifest.webmanifest` (scope and start_url `/patient/app`); the worker `/sw.js` is registered only by
  the full-screen route in production builds with scope `/patient/app` and has no runtime caching. `useLiveSocket`
  subscribes per role and re-subscribes on role, facility or patient change; `notification` events feed the phone
  banner (`usePush`).

## 13. Next-plan suggestions (F2, additive, backward compatible)

- The engine still only records `NEXT_PATHWAY_SUGGESTED` care events (cancer found -> `ONCOLOGY_TREATMENT`, curative
  treatment -> `SURVIVORSHIP`, palliative intent or BSC -> `PALLIATIVE_SUPPORT`). It never creates the plan: the doctor
  starts it through the usual approval (`POST /care/plans`).
- `GET /care/suggestions` (doctor only; ministry and patient get 403) returns the facility's open suggestions
  `[{patient_id, display_id, pathway, pathway_name, reason, since, from_plan_id}]`, newest first. One per patient and
  pathway (the latest event). A suggestion is open until a plan on that pathway is created at or after it (any status
  except `CANCELLED`), and is not offered while a plan on that pathway is open or when the patient has died. Facility
  scope is the `check_access` rule: patients linked to the facility, or with a plan approved at or targeted to it.
- `GET /patients/{id}/care` adds `suggested_next: [...]` (same row shape) next to `plans`. `/me/plan` is unchanged: the
  patient app sees nothing until the doctor approves.
