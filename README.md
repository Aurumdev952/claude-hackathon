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
| Epi methods | `pipeline/metrics/` | ASR with Fay–Feuer CIs, WLS joinpoint (BIC), Local Moran's I / Gi* / SIR / EB smoothing, KM + log-rank, Cox, nested case-control, funnel limits |
| Risk models | `ml/` | Tier 1 points score, Tier 2 XGBoost + isotonic calibration + SHAP reasons, Tier 3 JAX GRU/Transformer + Integrated Gradients, ensemble bands, alerts |
| API | `api/` | FastAPI, role-scoped (ministry = aggregates only; doctor = own facility), WebSocket refresh, NL→SQL with sqlglot guard rails, insight cards, case payload |
| Dashboard | `frontend/` | React + TypeScript + Tailwind ("Highland Watch" design), ECharts, deck.gl 3D map, react-three-fiber 3D views |
| 3D anatomy | `frontend/public/models/` | Z-Anatomy / BodyParts3D organs as a meshopt GLB (2.9 MB), organ anchors, credits |

### Dashboard views

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
8. **Ask the Data**: natural-language questions → validated read-only SQL → answer, chart, table, SQL.

## Quick start (native, what the build container verifies)

Prerequisites: Python 3.11 + [uv](https://docs.astral.sh/uv/), Node 22, MySQL 8 (for the live loop), ~60 GB disk for scale 1.0.

```bash
cp .env.example .env            # set MySQL credentials
make setup                      # uv sync + npm ci (+ ollama models if ollama is installed)
make seed SCALE=0.05            # small dataset; `make seed-full` for 1.5M people (~5 min generate, ~1 h MySQL load)
make bootstrap                  # DuckDB load from Parquet -> marts -> publish
make train                      # 3 model tiers, then re-score + publish
make up                         # simulator + pipeline scheduler + API (:8000) + dashboard (:5173)
```

Open http://localhost:5173. Use the header switch for **Ministry** vs **Doctor** (pick a facility). API docs are at http://localhost:8000/api/v1/docs.

Docker: `docker compose up -d --build` uses the same layout (see `docker-compose.yml`, SPEC §17.2). The development container had no Docker Hub access, so it was verified natively (D-02).

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

## Data, privacy and licences

- All people, facilities and statistics are synthetic. Facility names carry "(Synthetic)". District choices for the insights are illustrative only (SPEC §9).
- District boundaries come from geoBoundaries (CC BY 4.0).
- The 3D anatomy is from **Z-Anatomy** (CC BY-SA 4.0), which is derived from **BodyParts3D**, © DBCLS (CC BY-SA 2.1 JP). See [`frontend/public/models/CREDITS.md`](frontend/public/models/CREDITS.md).
  - Z-Anatomy's licence file also lists two CC BY-NC sub-sources whose meshes it does not identify. The `brain` and kidney nodes may come from them; check before any commercial use.
- The ministry role never receives patient-level fields. The doctor role sees only patients linked to its facility.
- AI output is labelled as decision support. Insight cards cite the numbers they are built from.
