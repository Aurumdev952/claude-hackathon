# Getting started

There are two ways to run Early Signals:

- **Quick (no MySQL):** a small synthetic dataset built in about 15 minutes. This is the path for development and demos.
- **Full (scale 1.0):** 1.5M people, the MySQL live loop and the verified results. Follow [`setup.md`](setup.md).

## Requirements

- Linux or macOS, 8 GB RAM (16 GB for scale 1.0)
- Python 3.11 with [uv](https://docs.astral.sh/uv/)
- Node 22 with npm and pnpm
- MySQL 8 only for the full live loop

## Quick start (no MySQL)

```bash
git clone https://github.com/Aurumdev952/claude-hackathon.git early-signals && cd early-signals
cp .env.example .env
uv sync --extra dev --extra report
make dev-data          # small dataset: generate (SCALE 0.1) -> bootstrap -> train, about 15 min
make agent-setup       # optional: AI agent (pnpm install + sandbox venv)
make serve             # API :8000 + dashboard :5173 (+ agent :8787 when agent/node_modules exists)
```

Open http://localhost:5173. Use the header switch for **Ministry**, **Doctor** (pick a facility) or **Patient**. API docs
are at http://localhost:8000/api/v1/docs. Stop everything with `make down`.

For the care loop, forecasts and videos (the v3 dataset in `data/v3`), see [care-loop.md](care-loop.md):

```bash
make dev-data-next     # v3 dev dataset into data/v3
make care-seed         # ~8 demo care plans (Musanze 1207, Kayonza 1219)
make advance DAYS=7    # move the simulation clock forward one week
```

Re-run marts and scoring without regenerating: `uv run python -m pipeline.run --no-extract`.

## Full build (scale 1.0, MySQL)

**New machine (Ubuntu): follow [`setup.md`](setup.md).** It covers requirements, a one-time setup script, one command that
rebuilds data, models and MySQL, and a results check against the verified build.

```bash
bash scripts/setup_ubuntu.sh    # one time: MySQL 8 + config, Node 22, uv, project packages, .env
make doctor                     # check tools, RAM, disk, MySQL
make reproduce                  # generate 1.5M people -> analytics -> 3 model tiers -> MySQL -> verify (~1.5 h)
make up                         # simulator + pipeline scheduler + API (:8000) + dashboard (:5173)
```

Docker: `docker-compose.yml` describes the same services (spec §17.2). The development container had no Docker Hub
access, so only the native path is verified (D-02).

## Demo mode

`make demo` restores the last snapshot (`make snapshot`) and starts in demo mode: 30-second ticks, 7 simulated days each.
`make reset-demo` gives a fresh demo in under 2 minutes.

## Offline demo (no backend)

`VITE_USE_MOCKS=true npm run dev` (in `frontend/`) replays API responses recorded from a full walk-through
(`src/mocks/fixtures.json`). Re-record them with `npm run mocks:record` while the API and Vite are running.

## AI provider (dashboard features)

`LLM_PROVIDER=template | ollama | anthropic` (default `template`). Template mode is deterministic and rule-based, and is
what the tests exercise:

- NL→SQL uses the semantic layer;
- insight cards use fact templates.

Ollama and Anthropic are implemented behind the same interface. Set the provider plus `OLLAMA_BASE_URL` /
`ANTHROPIC_API_KEY` to switch (D-16). Every generated SQL statement passes the guard rails:

- single SELECT only, allow-listed tables, no table functions or file access;
- row limit and timeout;
- numbers in the answer are checked against the result.

The chat agent has its own provider settings; see [agent-and-mcp.md](agent-and-mcp.md).

## Useful commands

| Command | What it does |
|---|---|
| `make test-fast` | Pipeline + API tests |
| `make test` | Everything (some suites need the scale 1.0 dataset, see [testing.md](testing.md)) |
| `make e2e` | Playwright journeys (API + Vite running) |
| `make report` | Today's one-page PDF brief |
| `make forecast` / `make retrain` | Forecasts and backtests / challenger model with gates |
| `make video-serve` | Video render server on :8790 |
