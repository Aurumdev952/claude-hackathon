# Architecture

Early Signals is a local pipeline from a synthetic EMR to a dashboard, an AI agent and a patient app. The full
specification is in [`spec.md`](spec.md) (v1.1). Agreed deviations, with reasons, are in [`decisions.md`](decisions.md).

```
generator/ ──► MySQL (OpenMRS-style EAV) ──► pipeline/ (DuckDB: staging → core → marts → pt_*) ──► api/ (FastAPI :8000)
   │                ▲                               │                                                  │
   │          simulator/ (live ticks)               ml/ (3 risk tiers, forecasts, learning loop)       ├─► frontend/ (React :5173)
   │                                                │                                                  ├─► agent/ (Hono :8787, MCP)
   └─► data/ground_truth.json                       care/ (care plans, reminders, EMR write-back)      └─► video/ (Remotion :8790)
```

The pipeline publishes blue/green: it builds a new `serve_*.duckdb`, then flips `data/analytics/current.json`. The API,
the agent and the video server read the published database read-only and pick up each new run without a restart.

## Components

| Part | Folder | What it does |
|---|---|---|
| Synthetic EMR generator | `generator/` | 1.5M-person Rwanda population, OpenMRS EAV schema, life-course simulation. Gastric cancer natural history and **8 planted insights** (INS-1…8), realistic data-quality noise, `data/ground_truth.json` |
| Live simulator | `simulator/` | Replays the pre-simulated future into MySQL tick by tick (insert-only, one transaction per tick) |
| Pipeline | `pipeline/` | MySQL → DuckDB incremental ETL (id watermarks), staging, dedup, core facts, marts, scoring. Blue/green publish via `current.json` |
| Epi methods | `pipeline/metrics/` | ASR with Fay–Feuer CIs, WLS joinpoint (permutation-test selection, BIC optional), Local Moran's I / Gi* / SIR / EB smoothing, KM + log-rank, Cox, nested case-control, funnel limits |
| Risk models | `ml/` | Tier 1 points score, Tier 2 XGBoost + isotonic calibration + SHAP reasons, Tier 3 JAX GRU/Transformer + Integrated Gradients, ensemble bands, alerts |
| API | `api/` | FastAPI, role-scoped (ministry = aggregates only; doctor = own facility; patient = own record), WebSocket refresh, NL→SQL with sqlglot guard rails, insight cards, case payload |
| Dashboard | `frontend/` | React + TypeScript, HeroUI + Framer Motion, ECharts, deck.gl 3D map, react-three-fiber 3D views |
| 3D anatomy | `frontend/public/models/` | Z-Anatomy / BodyParts3D organs as a meshopt GLB (2.9 MB), organ anchors, credits |
| AI agent | `agent/` | Hono + Vercel AI SDK: clinical assistant and ministry analyst, chart widgets, Python sandbox, MCP server. See [agent-and-mcp.md](agent-and-mcp.md) |
| Care engine | `care/`, `config/care_pathways.yaml` | Six pathways, tasks closed by EMR evidence, reminder ladder app → SMS → CHW → doctor. See [care-loop.md](care-loop.md) |
| Sim clock + care world | `simulator/local.py`, `simulator/care_world.py` | MySQL-free time travel: replay the future, simulate how patients respond, write EMR rows back, re-run the pipeline |
| Learning loop | `ml/retrain.py`, `ml/adherence.py` | IPW challenger on verified outcomes, gates, human Promote in Model Arena |
| Forecasting | `ml/forecast/`, `generator/external/` | Synthetic registry 2000-2026, surveys, projections; APC + ETS forecasts to 2031 with 80/95% bands, drivers, scenarios |
| Patient app | `frontend/src/views/patient` | Phone-frame simulator at `/patient` (PWA screens) |
| Videos | `video/` | Remotion case summary (doctor) and national reel (ministry), MP4 with poster |
| Automations | `.claude/skills/`, `scripts/`, `reports/` | `/validate-risk` and `/daily-report` for Claude Code. See [claude-code.md](claude-code.md) |

## Roles

| Role | Header | Sees |
|---|---|---|
| Ministry | `X-Role: ministry` | Aggregates only; cells with fewer than 5 are suppressed. Never patient-level fields |
| Doctor | `X-Role: doctor`, `X-Facility-Id` | Only patients linked to that facility (`pt_patient_facility`) |
| Patient | `X-Role: patient`, `X-Patient-Id` | Only their own `/me*` data |

Nothing reaches a patient before a doctor approves a care plan in the UI. Patient messages never contain a diagnosis
word: they advise a visit only.

## Dashboard views

The UI uses HeroUI + Framer Motion on a light, card-based design (dark mode toggle in the top bar). Explanations sit
behind ⓘ icons and details open in modals, so the screens show charts, numbers and titles.

1. **National Overview**: KPIs with deltas and sparklines, national trend with joinpoints, mini 3D map.
2. **Geo Explorer**: extruded district map (ASR / crude / SIR / LISA / HP testing / stage IV), hexbins, facilities,
   referral arcs, time slider.
3. **Trends Lab**: multi-series ASR with CIs, joinpoint table, 3D "rate landscape", crude vs ASR.
4. **Early Warning**: care cascades, aligned pre-diagnostic curves (cases vs matched controls), signal ORs, diagnostic
   intervals, 3D journey helix.
5. **H. pylori & Care Quality**: funnel plot, stage mix by tier, KM curves, eradication HR next to the HIV negative control.
6. **Model Arena**: tier cards, ROC/PR, calibration, lead time, SHAP, subgroups, the challenger and its Promote gate.
7. **Follow-up** (`/programme`): funnel flagged → approved → notified → attended → endoscopy, adherence by channel and
   distance, CHW workload.
8. **Outlook** (`/outlook`): the 2031 fan chart with 80/95% bands, drivers (population, ageing, risk) and a what-if
   scenario simulator.
9. **Doctor Workspace**: risk-ranked patient list, risk card, "why flagged" reasons, timeline, alert actions, care plans.
   - **Case Analysis (3D)**, the doctor's deep dive on one case:
     - the patient's symptoms, diagnoses, labs and vitals are aggregated per organ and glow on a realistic anatomical body;
     - tumour + nodal stations + metastatic spread for diagnosed cases;
     - "suspected region" search rings for flagged patients;
     - heart beats at the recorded pulse, lungs breathe at the respiratory rate, blood pales with haemoglobin, and the
       body outline thins with weight loss;
     - X-ray mode, layer toggles, click-to-fly camera, two-way hover between the lists and the body;
     - a timeline **replay** that relights the body month by month;
     - a table fallback and reduced-motion support.
10. **Patient app** (`/patient`): a phone frame with notifications, the care plan, the journey and weekly check-ins.
11. **Agent** (`/agent`): chat with the clinical assistant (doctor role) or the ministry analyst (ministry role).

## Key tables and endpoints

- `pt_risk` (band, `ensemble_prob`, `t1_score`, `top_reasons` JSON), `pt_alerts` (`RISK_BAND_HIGH`,
  `ALARM_NO_SCOPE_90D`, `HB_DROP`, `HP_POS_UNTREATED`, `CARE_OVERDUE`), `pt_timeline`, `pt_features`, `pt_patient`,
  `mart_kpis`, `mart_rates`, `mart_data_quality`, `ml_model_registry`, `ml_risk_history`.
- Care loop: `care_plans` / `care_tasks` / `care_events` / `care_notifications`, `pt_journey`, `pt_recovery`,
  `mart_care_funnel` / `_adherence` / `_impact`, `mart_forecast`, `ml_retrain_runs`. Contract:
  [`contracts/v3-loop.md`](contracts/v3-loop.md).
- API (`/api/v1`): `/kpis`, `/rates`, `/patients`, `/patients/{id}/case`, `/alerts`, `/data-quality`, `/health`,
  `/care/*`, `/patients/{id}/care|journey`, `/me*`, `/forecast/*`, `/models/learning-loop`, `/admin/sim`. Interactive
  docs at http://localhost:8000/api/v1/docs.
