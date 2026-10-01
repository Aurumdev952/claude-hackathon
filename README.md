# Early Signals — gastric cancer surveillance from routine EMR data (Rwanda, synthetic)

> **Synthetic data for demonstration — not real patients or real district statistics.**

Early Signals shows how routine OpenMRS-style EMR data can:

- track gastric cancer trends (age-standardised rates, joinpoint trends, spatial hotspots, survival);
- surface missed warning signs and care gaps;
- flag high-risk patients for endoscopy with three tiers of risk models;
- let a doctor analyse a flagged case on an interactive 3D body.

Everything runs locally. The full specification is in [`SPEC.md`](SPEC.md) (v1.1). Agreed deviations, with reasons, are in [`docs/decisions.md`](docs/decisions.md).

## What's inside

| Part | Folder | What it does |
|---|---|---|
| Synthetic EMR generator | `generator/` | 1.5M-person Rwanda population, OpenMRS EAV schema, life-course simulation. Gastric cancer natural history and **8 planted insights** (INS-1…8), realistic data-quality noise, `data/ground_truth.json` |
| Live simulator | `simulator/` | Replays the pre-simulated future into MySQL tick by tick (insert-only, one transaction per tick) |
| Pipeline | `pipeline/` | MySQL → DuckDB incremental ETL (id watermarks), staging, dedup, core facts, marts, scoring. Blue/green publish via `current.json` |
| Epi methods | `pipeline/metrics/` | ASR with Fay–Feuer CIs, WLS joinpoint (permutation-test selection, BIC optional), Local Moran's I / Gi* / SIR / EB smoothing, KM + log-rank, Cox, nested case-control, funnel limits |
| Risk models | `ml/` | Tier 1 points score, Tier 2 XGBoost + isotonic calibration + SHAP reasons, Tier 3 JAX GRU/Transformer + Integrated Gradients, ensemble bands, alerts |
| API | `api/` | FastAPI, role-scoped (ministry = aggregates only; doctor = own facility), WebSocket refresh, NL→SQL with sqlglot guard rails, insight cards, case payload |
| Dashboard | `frontend/` | React + TypeScript + Tailwind ("Highland Watch" design), ECharts, deck.gl 3D map, react-three-fiber 3D views |
| 3D anatomy | `frontend/public/models/` | Z-Anatomy / BodyParts3D organs as a meshopt GLB (2.9 MB), organ anchors, credits |

### Dashboard views

The UI uses HeroUI + Framer Motion on a light, card-based design (dark mode toggle in the top bar). Explanations sit behind ⓘ icons and details open in modals, so the screens show charts, numbers and titles.

1. **National Overview**: KPIs with deltas and sparklines, national trend with joinpoints, mini 3D map.
2. **Geo Explorer**: extruded district map (ASR / crude / SIR / LISA / HP testing / stage IV), hexbins, facilities, referral arcs, time slider.
3. **Trends Lab**: multi-series ASR with CIs, joinpoint table, 3D "rate landscape", crude vs ASR.
4. **Early Warning**: care cascades, aligned pre-diagnostic curves (cases vs matched controls), signal ORs, diagnostic intervals, 3D journey helix.
5. **H. pylori & Care Quality**: funnel plot, stage mix by tier, KM curves, eradication HR next to the HIV negative control.
6. **Model Arena**: tier cards, ROC/PR, calibration, lead time, SHAP, subgroups.
7. **Doctor Workspace**: risk-ranked patient list, risk card, timeline, alert actions.
   - **Case Analysis (3D)** — the doctor's deep dive on one case:
     - the patient's symptoms, diagnoses, labs and vitals are aggregated per organ and glow on a realistic anatomical body;
     - tumour + nodal stations + metastatic spread for diagnosed cases;
     - "suspected region" search rings for flagged patients;
     - heart beats at the recorded pulse, lungs breathe at the respiratory rate, blood pales with haemoglobin, and the body outline thins with weight loss;
     - X-ray mode, layer toggles, click-to-fly camera, two-way hover between the lists and the body;
     - a timeline **replay** that relights the body month by month;
     - a table fallback and reduced-motion support.
8. **Agent** (`/agent`): chat with the clinical assistant (doctor role) or the ministry analyst (ministry role). Answers stream with markdown, chart widgets, patient cards and sandbox plots; messages can be edited, rewound and regenerated. See [AI agent and MCP](#ai-agent-and-mcp).

## Quick start

**New machine (Ubuntu): follow [`SETUP.md`](SETUP.md).** It covers requirements, a one-time setup script, one command that rebuilds data, models and MySQL, and a results check against the verified build.

```bash
bash scripts/setup_ubuntu.sh    # one time: MySQL 8 + config, Node 22, uv, project packages, .env
make doctor                     # check tools, RAM, disk, MySQL
make reproduce                  # generate 1.5M people -> analytics -> 3 model tiers -> MySQL -> verify (~1.5 h)
make up                         # simulator + pipeline scheduler + API (:8000) + dashboard (:5173)
```

Open http://localhost:5173. Use the header switch for **Ministry** vs **Doctor** (pick a facility). API docs are at http://localhost:8000/api/v1/docs.

Docker: `docker-compose.yml` describes the same services (SPEC §17.2). The development container had no Docker Hub access, so only the native path is verified (D-02).

### Demo mode

`make demo` restores the last snapshot (`make snapshot`) and starts in demo mode: 30-second ticks, 7 simulated days each. `make reset-demo` gives a fresh demo in under 2 minutes.

### AI provider

`LLM_PROVIDER=template | ollama | anthropic` (default `template`). Template mode is deterministic and rule-based, and is what the tests exercise:
- NL→SQL uses the semantic layer;
- insight cards use fact templates.

Ollama and Anthropic are implemented behind the same interface. Set the provider plus `OLLAMA_BASE_URL` / `ANTHROPIC_API_KEY` to switch (D-16). Every generated SQL statement passes the guard rails:
- single SELECT only, allow-listed tables, no table functions or file access;
- row limit and timeout;
- numbers in the answer are checked against the result.

## Tests

```bash
make test            # everything
make test-insights   # ground-truth recovery only
make e2e             # Playwright journeys (API + Vite running)
```

| Suite | Checks |
|---|---|
| `tests/generator/test_realism.py` | §19.2 realism: age pyramid, cohort size, calibration targets, visit rates, seasonality, no impossible dates |
| `tests/pipeline/test_methods.py` | ASR, Fay–Feuer, joinpoint recovery on known series, spatial statistics |
| `tests/insights/test_insight_recovery.py` | §19.3: every planted insight (INS-1…8, micro-cluster, dedup) is re-discovered from the published marts |
| `tests/ml/test_leakage.py` | §19.4: features unchanged when post-landmark data or the excluded diagnostic pathway is deleted; shuffled labels give AUROC ≈ 0.5 |
| `tests/api/test_contract.py` | Envelope, roles, facility scoping, no PII to ministry, alert workflow, notes, case payload, SQL guard |
| `tests/api/test_nl2sql_benchmark.py` | §19.5: 20-question benchmark in template mode (≥ 18/20) |
| `frontend/e2e/` | §19.6 journeys + the 3D case-analysis journey |

### Verified results (scale 1.0: 1.5M people, history to 30 Jun 2026)

What the build container measured on the final dataset:

- **Tests:**
  - `pytest tests`: 88 passed, 0 skipped. This covers realism, methods, insight recovery, leakage, API contract and NL→SQL.
  - NL→SQL benchmark: **20/20** in template mode.
  - Playwright: **7/7** journeys pass, including alert acknowledgement and the 3D case analysis.
- **Epidemiology** (all planted insights recovered):
  - National ASR 2024: 34.7 per 100,000 (95% CI 30.7–39.2).
  - 2,283 incident cases (1,860 confirmed) in a GI cohort of 49,142 people.
  - Under-50 trend: APC +7.3%/yr (CI 2.9–11.9) from 2017.
  - LISA High-High cluster: Musanze, Rutsiro, Nyabihu, Ngororero, Gakenke.
  - 1-year survival: 35% overall; low- vs high-testing facilities 24% vs 48% (log-rank p < 0.001).
  - H. pylori eradication: HR 0.55 (0.41–0.75). HIV negative control: HR 0.74 (0.48–1.15), not significant, as expected.
- **Models** (test period, 1,023 cases; [D-32](docs/decisions.md) explains why these exceed the SPEC guidance):

| Model | AUROC | AUPRC | Sens @ 90% spec | Median lead time |
|---|---|---|---|---|
| Tier 1 points score | 0.883 | 0.364 | 67% | 3.5 mo |
| Tier 2 XGBoost | 0.964 | 0.573 | 94% | 6.2 mo |
| Tier 3 sequence (GRU) | 0.963 | 0.536 | 92% | 6.3 mo |
| Ensemble (final band) | 0.970 | 0.594 | 95% | 6.2 mo |

- **Live loop** (`make up`: simulator tick every 5 min = 1 simulated day, pipeline scheduler every 5 min):
  - About 2,750 encounters and 17,500 obs are inserted per tick in 45–60 s.
  - A warm incremental batch takes about 3 min: stage 51 s, core 18 s, marts 44 s, scoring 60 s, publish 4 s.
  - Most Tier 3 attributions come from the cache (for example 4,497 of 4,552).
  - The API and the dashboard header pick up each new run without a restart.
  - The first run in a new process adds about 1 min for numba/JAX compilation.

### Offline demo (no backend)

`VITE_USE_MOCKS=true npm run dev` (in `frontend/`) replays API responses recorded from a full walk-through (`src/mocks/fixtures.json`). Re-record them with `npm run mocks:record` while the API and Vite are running.

## AI agent and MCP

`agent/` is a Node service (Hono + Vercel AI SDK 7) with two agents: a **clinical assistant** for doctors (facility-scoped, patient widgets) and a **ministry analyst** for health officials (aggregates only, cells under 5 suppressed). Both read the published DuckDB marts read-only, answer with chart widgets by default, can run small Python plotting scripts in a sandbox, and keep chats in SQLite (edit, rewind, regenerate).

```bash
make agent-setup        # pnpm install + sandbox venv
make agent-dev          # http://localhost:8787/agent/health ; the dashboard chat is at /agent
make agent-test         # unit tests
make eval-agent         # DeepEval readiness gate (needs OpenRouter credit)
```

Model: `AGENT_MODEL` (default `deepseek/deepseek-v4.1-flash` on OpenRouter, key in `OPENROUTER_API_KEY`). For a government-hosted model set `AGENT_PROVIDER=openai-compatible` and `AGENT_BASE_URL`.

Connect your own agent through MCP (no auth in the demo):

```bash
claude mcp add --transport http early-signals http://localhost:8787/mcp -H "X-Role: ministry"
claude mcp add --transport http early-signals-doctor http://localhost:8787/mcp -H "X-Role: doctor" -H "X-Facility-Id: 1215"
```

Details: [`agent/README.md`](agent/README.md), evals: [`evals/agent/README.md`](evals/agent/README.md).

## Claude Code automations

Project skills live in `.claude/skills/`. Repo notes for Claude are in [`CLAUDE.md`](CLAUDE.md). Both skills need published
data (`make dev-data` builds a small MySQL-free dataset). They identify patients by display ID only.

| Command (in Claude Code) | What it does |
|---|---|
| `/validate-risk 5` | Fetches the 5 newest HIGH-risk patients that have not been reviewed yet (`scripts/risk_validation.py cases`). Claude checks each flag against the record (alarm features, labs, H. pylori, endoscopy status, demographics) and appends a verdict (`agree / disagree / uncertain`, confidence, evidence, per-reason checks) to `reports/risk_validation.jsonl`. It then commits and pushes `reports/` |
| `/loop 30m /validate-risk 5` | Repeats the review every 30 minutes for as long as the session is open. Once every HIGH case is reviewed, each run does nothing |
| `/daily-report` | Builds `reports/daily/<today>.pdf`, a one-page A4 brief with KPIs, trend, alerts by trigger, the top 10 high-risk patients with Claude's verdicts, data quality and provenance. Adds 3-4 observations against the previous day, then commits and pushes |

The **daily Routine** (07:00 Africa/Kigali) starts a fresh cloud session, runs `/daily-report` and pushes the PDF. A fresh
session has no generated data, so the report renders from the committed `reports/snapshots/latest.json` and the
validation log. The snapshot is refreshed whenever validations are appended or a report is built against live data.

```bash
make validate-cases N=5                                  # what /validate-risk sees, as JSON
uv run python scripts/risk_validation.py summary         # agreement so far
make report                                              # PDF for today (live data, or the snapshot)
uv run python scripts/daily_report.py --from-snapshot --check
```

See [`reports/README.md`](reports/README.md) for the file formats.

## Data, privacy and licences

- All people, facilities and statistics are synthetic. Facility names carry "(Synthetic)". District choices for the insights are illustrative only (SPEC §9).
- District boundaries come from geoBoundaries (CC BY 4.0).
- The 3D anatomy is from **Z-Anatomy** (CC BY-SA 4.0), which is derived from **BodyParts3D**, © DBCLS (CC BY-SA 2.1 JP). See [`frontend/public/models/CREDITS.md`](frontend/public/models/CREDITS.md).
  - Z-Anatomy's licence file also lists two CC BY-NC sub-sources whose meshes it does not identify. The `brain` and kidney nodes may come from them; check before any commercial use.
- The ministry role never receives patient-level fields. The doctor role sees only patients linked to its facility.
- AI output is labelled as decision support. Insight cards cite the numbers they are built from.
