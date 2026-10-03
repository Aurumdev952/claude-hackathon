# Early Signals: notes for Claude Code

Gastric cancer surveillance for Rwanda, built on a **synthetic** OpenMRS-style EMR. Python 3.11 (uv) does the generator, the
DuckDB pipeline, the ML models and the FastAPI API. The dashboard uses React 18 and Vite. The AI agent uses Hono on Node 22.
The full spec is in `docs/spec.md` and the agreed deviations are in `docs/decisions.md`.

## Data rules (always)

- All data is synthetic. Facility names carry "(Synthetic)". Never present the output as real patients or real statistics.
- Refer to patients by **display ID only** (`pt_patient.display_id`, e.g. `NYA-0119453Y`). Never write names in reports,
  commits, logs or chat. `given_name` and `family_name` exist only for the doctor UI.
- Patient-name exception (v3, D-53): the patient's **given name** may appear only inside the patient's own app (`/me`, the
  APP greeting). Never in logs, videos, reports, agent output, eval results or stored notification bodies.
- Patient messages never contain a diagnosis word (cancer, tumour, oncology, ...): advice to visit only (D-54). Nothing
  reaches a patient before a doctor approves a care plan in the UI; the agent only drafts.
- The ministry role never receives patient-level fields (aggregates only, counts below 5 suppressed). The doctor role sees
  only patients linked to its facility (`pt_patient_facility`). The patient role (`X-Patient-Id`) sees only its own `/me*`
  data. Keep these guards in any new endpoint or tool.

## Project map

| Path | What |
|---|---|
| `generator/` | Synthetic EMR (Parquet in `data/bulk`, ground truth `data/ground_truth.json`) |
| `pipeline/` | DuckDB ETL: staging, core, marts (`mart_*`), patient tables (`pt_*`), scoring, blue/green publish (`data/analytics/current.json`) |
| `ml/` | Tier 1 points, Tier 2 XGBoost + SHAP, Tier 3 JAX sequence model; `ml/score.py` writes `pt_risk`, `pt_alerts`; `ml/reasons.yaml` is the source of reason labels |
| `api/` | FastAPI on :8000 (`/api/v1/...`); `api/deps.py` reads the serve DB read-only; `api/app_state.py` stores alert status and notes in `data/analytics/app_state.sqlite` |
| `frontend/` | React + Vite on :5173. Design system (v3, D-44): HeroUI 2.7 + Framer Motion, Urbanist, flat cards, one orange accent, light theme by default, tokens in `src/styles.css`, shared kit in `src/components/ui`, chart palette in `src/lib/viz.ts` |
| `agent/` | AI agent: Hono on :8787. `POST /agent/chat` (streaming), MCP (Streamable HTTP) at `/mcp`, `GET /agent/health`. Python sandbox in `agent/sandbox`. v3 tools: care plan, follow-ups, journey, `draft_care_plan` (preview only, never creates or sends), forecast, scenario, learning loop, `create_video` |
| `evals/agent/` | DeepEval gate for the agent (`make eval-agent`, needs a running agent at `AGENT_URL`) |
| `care/` | v3 care coordination: `engine.py` (plans, reconcile, reminder ladder, worklist), `config/care_pathways.yaml`, `messages.yaml` (patient copy), `evidence.py`, `emr.py` (write-back adapter); writable state in `data/analytics/care.sqlite`, snapshot to `care_*` |
| `simulator/local.py`, `simulator/care_world.py` | MySQL-free sim clock (`advance(days)`: replay future, care world, pipeline, publish) and synthetic patient behaviour for open care tasks (`config/care_world.yaml`) |
| `ml/forecast/`, `ml/retrain.py`, `ml/adherence.py` | Incidence forecasts to 2031 (APC + ETS, scenarios, backtests, `config/forecast.yaml`); learning loop (IPW challenger, gates, human promote); adherence model for the worklist |
| `generator/external/` | Synthetic registry 2000-2026, risk-factor surveys, population projections to 2035 (`data/<dir>/external`, `ext_*`) |
| `video/` | Remotion data videos (patient case summary, ministry reel) + Hono render server on :8790 (`/video/jobs`) |
| `scripts/` | `verify_results.py`, `risk_validation.py` (/validate-risk), `daily_report.py` (/daily-report), `report_data.py` (shared) |
| `reports/` | Automation outputs: `risk_validation.jsonl`, `daily/<date>.pdf/.json`, `snapshots/latest.json` (see `reports/README.md`) |

## Commands (MySQL-free development)

```bash
cp .env.example .env
uv sync --extra dev --extra report
make dev-data          # small dataset: generate (SCALE 0.1) -> bootstrap -> train, about 15 min
make serve             # API :8000 + dashboard :5173 (+ agent :8787 when agent/node_modules exists); stop with make down
make agent-setup       # pnpm install for agent/ + uv sync for the sandbox
make agent-dev         # agent only, with reload
make test-fast         # pipeline + API tests
make report            # today's 1-page PDF (scripts/daily_report.py --check)
make validate-cases N=5  # next unvalidated HIGH cases as JSON
make eval-agent        # DeepEval gate against a running agent
# v3 (dataset in data/v3: make exports DATA_DIR from .env; prefix hand-started processes with DATA_DIR=data/v3)
make dev-data-next     # regenerate the v3 dev dataset into data/v3; make swap-next moves it into data/
make advance DAYS=7    # MySQL-free sim clock: +7 sim days (care world, reconcile, pipeline, publish); make sim-local = auto clock
make care-seed         # ~8 demo care plans (facilities 1207 Musanze, 1219 Kayonza)
make forecast          # forecasts + backtests; make retrain = challenger + gates; make external-data = ext_* sources
make video-serve       # render server :8790; make video-render KIND=patient ID=<patient_id> | KIND=ministry FROM= TO=
```

- Re-run marts and scoring without regenerating: `uv run python -m pipeline.run --no-extract`.
- `make pipeline-once`, `make up`, `make load` and `make seed` need MySQL. Do not use them in cloud sessions.
- `make verify` and `tests/insights` expect the full scale 1.0 dataset. They fail on dev data by design.

## Conventions

- Run Python from the repo root with `PYTHONPATH=.` (the SessionStart hook exports it in cloud sessions):
  `PYTHONPATH=. uv run python -m ...`. The scripts in `scripts/` also work without it.
- Read the serve DB read-only and follow `current.json`; never write to `serve_*.duckdb`. `work.duckdb` belongs to the pipeline.
- Key tables: `pt_risk` (band, `ensemble_prob`, `t1_score`, `top_reasons` JSON, `scoped_since_flag`), `pt_alerts`
  (`trigger`: RISK_BAND_HIGH, ALARM_NO_SCOPE_90D, HB_DROP, HP_POS_UNTREATED, CARE_OVERDUE), `pt_timeline`, `pt_features`,
  `pt_patient`, `mart_kpis`, `mart_rates`, `mart_data_quality`, `ml_model_registry`, `ml_risk_history`.
- v3 tables: `care_plans` / `care_tasks` / `care_events` / `care_notifications` (snapshot of care.sqlite), `pt_care_plan`,
  `pt_care_task`, `pt_journey`, `pt_recovery`, `pt_treatment`, `mart_care_funnel` / `_adherence` / `_impact`,
  `mart_chw_workload`, `mart_forecast` (80/95% bands), `mart_forecast_drivers`, `ml_forecast_backtest`,
  `ml_feedback_labels`, `ml_retrain_runs`, `mart_model_monitoring`, `ext_registry` / `ext_surveys` / `ext_population`.
  Contracts: `docs/contracts/v3-loop.md`.
- Key endpoints: `/api/v1/kpis`, `/rates`, `/patients` (doctor: `X-Role: doctor`, `X-Facility-Id`), `/patients/{id}/case`,
  `/alerts`, `/data-quality`, `/health`; v3: `/care/*`, `/patients/{id}/care|journey`, `/me*` (`X-Role: patient`,
  `X-Patient-Id`), `/forecast/*`, `/models/learning-loop`, `/admin/sim`.

## Claude Code automations

| Skill | Run | Output |
|---|---|---|
| `/validate-risk [N]` | once, or `/loop 30m /validate-risk 5` | Claude reviews the newest HIGH flags against the record (and verified care outcomes when a plan exists) and appends verdicts to `reports/risk_validation.jsonl` (one per patient per model). It then commits and pushes `reports/`. The skill does nothing when every case has been reviewed |
| `/daily-report [date]` | by hand or from the daily Routine (07:00 Africa/Kigali) | `reports/daily/<date>.pdf` (one A4 page, incl. care coordination and the 2031 outlook) + `.json`, with observations against the previous day. It then commits and pushes |

`/loop` lasts only as long as the session. The Routine is the durable schedule. It starts a fresh cloud session with no
generated data, so the report falls back to the committed `reports/snapshots/latest.json`.
`.claude/settings.json` holds the permission allow/deny lists and the SessionStart hook (`.claude/hooks/session-start.sh`).

## Agent MCP

```bash
claude mcp add --transport http early-signals http://localhost:8787/mcp -H "X-Role: ministry"
# doctor view: add -H "X-Role: doctor" -H "X-Facility-Id: <location_id>"
```

`.mcp.json` equivalent:

```json
{ "mcpServers": { "early-signals": { "type": "http", "url": "http://localhost:8787/mcp", "headers": { "X-Role": "ministry" } } } }
```
