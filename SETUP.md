# Setting up Early Signals on a new Ubuntu PC

This guide rebuilds everything from the repository on a fresh Ubuntu machine:

- synthetic data (1.5M people);
- analytics;
- the 3 trained model tiers;
- the MySQL live loop;
- the dashboard.

You end with the same results as the verified build. `make verify` checks them against [`docs/reference_results.json`](docs/reference_results.json).

> Data, models and databases are **not** stored in git: they are generated, and the generated data is about 4 GB. The generator is deterministic (`SEED=42`), so every machine builds the same data. Training gives nearly the same models.

## 1. What you need

| | Minimum | Recommended | Why |
|---|---|---|---|
| OS | Ubuntu 22.04 or 24.04 | 24.04 | the scripts use `apt` |
| CPU | 4 cores | 4+ cores | the timings below are for 4 cores |
| RAM | 8 GB | 16 GB | DuckDB uses up to 6 GB, MySQL 3 GB, plus model training |
| Free disk | 27 GB | 40 GB+ | see the table below; the live loop keeps adding rows to MySQL |
| Internet | for setup | | apt, PyPI, npm. Nothing is downloaded while the app runs |

Disk used at scale 1.0 (measured):

| Part | Size |
|---|---|
| Generated data (`data/bulk`) | 3.3 GB (+0.5 GB temporary while generating) |
| DuckDB work + serve databases (`data/analytics`) | 9–10.5 GB, plus 1–2 GB temporary spill during a pipeline run |
| MySQL (`/var/lib/mysql`) | about 12 GB after the load |
| Python env + Node modules | 2.5 GB |

## 2. Install (one time, about 10 minutes)

```bash
git clone https://github.com/aurumdev952/claude-hackathon.git
cd claude-hackathon
git checkout claude/youthful-newton-3pem7l   # until the PR is merged
bash scripts/setup_ubuntu.sh                 # asks before each sudo step; add -y to accept all
```

`scripts/setup_ubuntu.sh` does the following:

1. Installs `mysql-server`, build tools, `curl` and `git` with apt.
2. Installs **Node 22** from NodeSource, if your Node is older than 22.
3. Installs **uv** (Python package manager). uv also downloads Python 3.11 for the project, so no system Python changes are needed.
4. Creates `.env` from `.env.example`.
5. Sets up MySQL:
   - copies [`config/mysql/early-signals.cnf`](config/mysql/early-signals.cnf) into `/etc/mysql/mysql.conf.d/` and restarts MySQL;
   - creates the MySQL user `es_admin`, using the password from `.env`.
6. Installs the project packages:
   - Python, with `uv sync --all-extras`;
   - frontend, with `npm ci`;
   - Chromium for the E2E tests.

> Change `MYSQL_ROOT_PASSWORD` in `.env` **before** running the script if this PC is reachable by others. Use letters and digits only. MySQL listens on 127.0.0.1 only.

Then check the machine:

```bash
make doctor
```

Every line should say PASS; a few WARNs are fine. Each FAIL line shows the command that fixes it.

## 3. Build everything (one command, about 1.5 hours)

```bash
make reproduce
```

| Step | What happens | Time (4 cores) |
|---|---|---|
| 1. generate | 1.5M-person synthetic OpenMRS EMR → `data/bulk` (Parquet), plus `data/ground_truth.json` | ~5 min |
| 2. bootstrap | DuckDB: staging, dedup, core facts, epidemiology marts → publish | ~5 min |
| 3. train | Tier 1 points, Tier 2 XGBoost, Tier 3 GRU → evaluate → score all patients → publish | ~25 min |
| 4. load | bulk-load MySQL (`LOAD DATA` + indexes) for the live loop | ~60 min |
| 5. verify | compare results with the reference build, then run the 88 Python tests | ~2 min |

`make reproduce-no-mysql` does steps 1, 2, 3 and 5. Use it if you only want the dashboard without the live loop.

Each step can be re-run on its own: `make bootstrap`, `make train`, `make load`, `make verify`.

### What "same results" means

`make verify` prints one line per headline number. For example, from the verified build:

```
  ✓  National ASR 2024 (per 100,000)               34.7      reference 34.7 ± 2.0
  ✓  Incident gastric cancer cases                 2,283     reference 2,283 ± 3%
  ✓  LISA High-High districts                      NOR-GAK, NOR-MUS, WES-NGR, WES-NYB, WES-RUT
  ✓  1-year survival, low-testing facilities       0.238     reference 0.238 ± 0.05
  ✓  H. pylori eradication HR (CI must exclude 1)  0.55 (0.41-0.75)
  ✓  Test AUROC, ensemble                          0.970     reference 0.97 ± 0.02
15/15 checks within tolerance
```

- Data and epidemiology numbers should match almost exactly.
- Model AUROCs can differ by about 0.01, because training depends a little on CPU thread counts.
- Then `pytest` should report **88 passed**.

Run `make verify` right after `make reproduce`. Once the live loop runs, new data moves the counts a little; the script warns when that has happened.

## 4. Run it

```bash
make up        # simulator + pipeline scheduler + API + dashboard (logs in logs/)
make down      # stop all of them
```

- Dashboard: http://localhost:5173. Use the header switch: **Ministry** shows aggregates; **Doctor** asks you to pick a facility, then shows patients, alerts and the 3D Case Analysis.
- API docs: http://localhost:8000/api/v1/docs
- `make serve` starts only the API and dashboard, with no simulator or MySQL needed.

**The live loop** (what `make up` adds):

- Every 5 minutes the simulator adds one simulated day of hospital activity to MySQL: about 2,750 encounters and 17,500 observations, taking 45–60 s.
- The pipeline scheduler also runs every 5 minutes. It extracts the new rows, rebuilds the analytics, re-scores patients and publishes, in about 3 minutes once warm.
- The first run after start takes about 1 minute longer, because the model code compiles.
- The dashboard header shows the new **sim date** and **run #** without a reload.

**Demo mode** (`make demo`, or `DEMO_MODE=true` in `.env`):

- It replays 7 simulated days per tick.
- `make demo` restores a snapshot first, so take one with `make snapshot` after `make reproduce`. At scale 1.0 a snapshot is about 15 GB (Parquet + DuckDB + MySQL dump).
- `DEMO_MODE=true make up` starts demo mode without a snapshot.
- At scale 1.0, inserting 7 days into the indexed MySQL tables takes a few minutes, so demo ticks run back to back instead of every 30 s.

**Check the browser journeys** (with `make up` running):

```bash
make e2e       # 7 Playwright journeys, including the 3D Case Analysis and alert acknowledgement
```

## 5. Options

| Setting (`.env`) | Default | Notes |
|---|---|---|
| `SCALE` | `1.0` | Keep 1.0: the reference numbers and insight tests are calibrated for it. The generator **refuses** a smaller scale unless you ask for it explicitly, e.g. `ALLOW_SMALL_SCALE=1 make generate SCALE=0.05` for a quick dev dataset |
| `LLM_PROVIDER` | `template` | Deterministic, with no model needed (this is what the tests use). `ollama`: install Ollama, `ollama pull qwen2.5-coder:7b`, and set `OLLAMA_BASE_URL`. `anthropic`: set `ANTHROPIC_API_KEY` |
| `TICK_SECONDS` / `SIM_DAYS_PER_TICK` | `300` / `1` | live-loop speed |
| `PIPELINE_MEMORY_LIMIT` | `6GB` | DuckDB memory cap. Lower it on 8 GB machines; it will use more disk spill |

**Offline preview without any backend:** `cd frontend && VITE_USE_MOCKS=true npm run dev`. This replays recorded API responses from `src/mocks/fixtures.json`.

**Docker:**

- `docker-compose.yml` and `docker/` describe the same services. Data generation runs with `docker compose run --rm generator`.
- This setup was **not** verified in the build environment, which had no Docker Hub access. The native path above is the verified one.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `make doctor`: MySQL not reachable / `Access denied for user 'es_admin'` | `sudo systemctl start mysql`, then re-run `bash scripts/setup_ubuntu.sh` (it re-applies the user and password from `.env`) |
| `local_infile is OFF` / `Loading local data is disabled` | the config file is not active: `sudo install -m 644 config/mysql/early-signals.cnf /etc/mysql/mysql.conf.d/` and `sudo systemctl restart mysql` |
| `No space left on device` during a pipeline run | DuckDB spills to `data/analytics/tmp`. Free disk, or lower `PIPELINE_MEMORY_LIMIT`. The failed batch never publishes, and the next run retries. Delete stale files in `data/analytics/tmp/` when nothing is running |
| MySQL keeps growing while `make up` runs | the live loop inserts about 20k rows per simulated day. `make down` stops it; `make load` restores the clean history (and resets the simulator clock) |
| `make reproduce` stopped part-way | re-run just the failed step (`make bootstrap`, `make train`, `make load`), then `make verify` |
| Dashboard panels fail to load / API returns `503 NOT_READY` ("No published analytics yet") | nothing is published yet: run `make bootstrap` (and `make train` for risk scores), or check `logs/pipeline.log` |
| Port 8000 or 5173 already in use | `make down`, or stop the other process (`ss -ltnp \| grep -E ':8000\|:5173'`) |
| E2E: browser executable not found | `cd frontend && npx playwright install --with-deps chromium` |
| `make verify` shows ✗ on model AUROCs only | check that `uv sync --all-extras` installed `jax` (Tier 3) and that `make train` finished. Small differences within tolerance are expected |
