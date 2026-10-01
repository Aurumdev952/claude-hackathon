# Early Signals — developer and demo targets (SPEC §17.3).
# Native mode (default) runs everything with uv + local MySQL; `make up-docker` uses docker-compose.yml.
# Fresh Ubuntu machine: see SETUP.md (scripts/setup_ubuntu.sh -> cp .env.example .env -> make doctor -> make reproduce).
SHELL := /bin/bash
# settings from .env (MySQL credentials, SCALE, SEED, LLM provider) reach every command below
-include .env
export
SCALE ?= 1.0
MYSQL_HOST ?= 127.0.0.1
MYSQL_PORT ?= 3306
MYSQL_USER ?= root
MYSQL_ROOT_PASSWORD ?= change_me
PY := PYTHONPATH=. uv run python
SNAP := data/snapshots/latest
MYSQL_CLI = mysql -h $(MYSQL_HOST) -P $(MYSQL_PORT) -u $(MYSQL_USER) -p$(MYSQL_ROOT_PASSWORD)
.PHONY: setup seed seed-full load snapshot restore bootstrap pipeline-once train up down up-docker down-docker demo \
        reset-demo test test-insights test-fast e2e frontend api sim lint generate doctor reproduce reproduce-no-mysql verify serve dev-data agent-setup agent-dev agent-build agent-test agent-smoke eval-agent report validate-cases

setup:                      ## toolchains + deps (run before the event, on good internet)
	uv sync --all-extras
	cd frontend && pnpm install --frozen-lockfile
	-command -v ollama >/dev/null && ollama pull qwen2.5-coder:7b && ollama pull llama3.1:8b

doctor:                     ## check this machine (tools, RAM, disk, MySQL) before a full build
	bash scripts/doctor.sh

reproduce:                  ## everything from scratch: generate (scale 1.0) -> bootstrap -> train -> MySQL load -> verify (~1.5 h)
	bash scripts/doctor.sh
	@echo "== 1/5 generate synthetic EMR, scale $(SCALE) (~5 min on 4 cores)"
	$(MAKE) generate
	@echo "== 2/5 DuckDB bootstrap: staging, core, marts, publish (~5 min)"
	$(MAKE) bootstrap
	@echo "== 3/5 train the 3 model tiers, then score + publish (~25 min)"
	$(MAKE) train
	@echo "== 4/5 load MySQL for the live loop (~60 min)"
	$(MAKE) load
	@echo "== 5/5 check results against the reference run"
	$(MAKE) verify

reproduce-no-mysql:         ## same, without MySQL (dashboard only, no live loop)
	SKIP_MYSQL=1 bash scripts/doctor.sh
	$(MAKE) generate
	$(MAKE) bootstrap
	$(MAKE) train
	$(MAKE) verify

verify:                     ## published results vs the reference run (docs/reference_results.json), then all Python tests
	$(PY) scripts/verify_results.py
	PYTHONPATH=. uv run pytest

dev-data:                   ## small MySQL-free dev dataset: generate (SCALE, default 0.1) -> bootstrap -> train (~15 min on 4 cores)
	ALLOW_SMALL_SCALE=1 $(MAKE) generate SCALE=$(or $(DEV_SCALE),0.1)
	$(MAKE) bootstrap
	$(MAKE) train

generate:                   ## synthetic EMR at SCALE -> data/bulk (Parquet) + data/ground_truth.json, no MySQL
	$(PY) -m generator --scale $(SCALE)

seed:                       ## generate + load a dataset at SCALE (default 1.0; smaller only with ALLOW_SMALL_SCALE=1)
	$(PY) -m generator --scale $(SCALE)
	$(MAKE) load

seed-full:                  ## generate + load scale 1.0 (1.5M people)
	$(PY) -m generator --scale 1.0
	$(MAKE) load

load:                       ## bulk-load data/bulk into MySQL (LOAD DATA + post-load indexes)
	$(PY) -m generator.load

bootstrap:                  ## initial DuckDB load from Parquet + watermarks, full rebuild + publish
	$(PY) -m pipeline.run --bootstrap

pipeline-once:              ## one incremental batch (extract -> marts -> score -> publish)
	$(PY) -m pipeline.run

train:                      ## train the 3 model tiers, then re-score + publish
	$(PY) -m ml.train
	$(PY) -m pipeline.run --no-extract --from score

snapshot:                   ## save Parquet + DuckDB + MySQL dump
	mkdir -p $(SNAP)
	cp -r data/bulk data/reference $(SNAP)/
	cp data/analytics/*.duckdb data/analytics/current.json $(SNAP)/
	-mysqldump -h $(MYSQL_HOST) -P $(MYSQL_PORT) -u $(MYSQL_USER) -p$(MYSQL_ROOT_PASSWORD) --single-transaction openmrs | gzip > $(SNAP)/openmrs.sql.gz

restore:                    ## restore the last snapshot
	rm -rf data/bulk && cp -r $(SNAP)/bulk data/bulk
	cp $(SNAP)/*.duckdb $(SNAP)/current.json data/analytics/
	-test -f $(SNAP)/openmrs.sql.gz && gunzip -c $(SNAP)/openmrs.sql.gz | $(MYSQL_CLI) openmrs

api:
	PYTHONPATH=. uv run uvicorn api.main:app --host 0.0.0.0 --port 8000

frontend:
	cd frontend && pnpm dev

sim:
	$(PY) -m simulator.tick $(if $(filter true,$(DEMO_MODE)),--demo,)

serve:                      ## API + dashboard only (no MySQL needed; logs in logs/)
	mkdir -p logs
	setsid nohup $(MAKE) api > logs/api.log 2>&1 & echo $$! > logs/api.pid
	setsid nohup $(MAKE) frontend > logs/frontend.log 2>&1 & echo $$! > logs/frontend.pid
	-test -d agent/node_modules && (setsid nohup $(MAKE) agent-dev > logs/agent.log 2>&1 & echo $$! > logs/agent.pid)
	@echo "dashboard: http://localhost:5173   api: http://localhost:8000/api/v1/docs   agent: http://localhost:8787/agent/health"

up:                         ## simulator + pipeline scheduler + API + frontend (native, background, logs in logs/); stop with make down
	mkdir -p logs
	setsid nohup env $(PY) -m simulator.tick $(if $(filter true,$(DEMO_MODE)),--demo,) > logs/sim.log 2>&1 & echo $$! > logs/sim.pid
	setsid nohup env $(PY) -m pipeline.scheduler > logs/pipeline.log 2>&1 & echo $$! > logs/pipeline.pid
	setsid nohup $(MAKE) api > logs/api.log 2>&1 & echo $$! > logs/api.pid
	setsid nohup $(MAKE) frontend > logs/frontend.log 2>&1 & echo $$! > logs/frontend.pid
	@echo "dashboard: http://localhost:5173   api: http://localhost:8000/api/v1/docs"

down:
	-for p in logs/*.pid; do kill -- -$$(cat $$p) 2>/dev/null || kill $$(cat $$p) 2>/dev/null; rm -f $$p; done   # whole process group (make -> uvicorn/vite)

up-docker:
	docker compose up -d --build

down-docker:
	docker compose down

demo:                       ## restore -> up in demo mode (30 s ticks, 7 sim days)
	$(MAKE) restore
	DEMO_MODE=true $(MAKE) up

reset-demo:                 ## fresh demo in < 2 min
	$(MAKE) down
	$(MAKE) restore
	rm -f data/analytics/app_state.sqlite data/sim_state/*.json

test:                       ## all Python tests (realism, methods, insight recovery, leakage, API contract, NL->SQL)
	PYTHONPATH=. uv run pytest

test-insights:              ## ground-truth recovery only
	PYTHONPATH=. uv run pytest tests/insights

test-fast:
	PYTHONPATH=. uv run pytest tests/pipeline tests/api

agent-setup:                ## install the AI agent (agent/) and its Python sandbox venv
	cd agent && pnpm install
	uv sync --project agent/sandbox

agent-dev:                  ## run the AI agent (Hono :8787) with reload
	cd agent && pnpm dev

agent-build:
	cd agent && pnpm build

agent-test:                 ## agent unit tests (guardrails, tools, repo, sandbox)
	cd agent && pnpm test

agent-smoke:                ## one doctor + one ministry question against a running agent (AGENT_URL)
	cd agent && pnpm smoke

eval-agent:                 ## DeepEval gate against a running agent (AGENT_URL=http://localhost:8787)
	EVAL_REQUIRE_AGENT=1 PYTHONPATH=. uv run --extra eval pytest evals/agent -q -p no:cacheprovider

report:                     ## today's 1-page PDF (reports/daily/<date>.pdf)
	$(PY) scripts/daily_report.py --check

validate-cases:             ## newest HIGH-risk cases not yet validated, as JSON (used by /validate-risk)
	$(PY) scripts/risk_validation.py cases --limit $(or $(N),5)

e2e:                        ## Playwright journeys (API on :8000 and Vite on :5173 must be running)
	cd frontend && npx playwright test

# ---- v3 L1: closed-loop simulation, external sources (docs/contracts/v3-loop.md §2, §3, §6) ----
.PHONY: external-data sim-local advance dev-data-next
external-data:              ## external synthetic sources -> $(DATA_DIR)/external (registry 2000-2026, surveys, population 2000-2035)
	$(PY) -m generator.external --out $(or $(DATA_DIR),data)/external

sim-local:                  ## MySQL-free auto sim clock (paced by data/sim_state/control.json); stop with Ctrl-C
	EMR_MODE=local $(PY) -m simulator.local --auto

advance:                    ## advance the MySQL-free sim clock by DAYS (default 7): replay, care world, pipeline, publish
	EMR_MODE=local $(PY) -m simulator.local --days $(or $(DAYS),7)

dev-data-next:              ## regenerate the dev dataset into data/next (generate -> bootstrap -> train -> external), data/ untouched
	rm -rf data/next/bulk data/next/analytics data/next/models data/next/sim_state data/next/external
	mkdir -p data/next && rm -rf data/next/reference && cp -r data/reference data/next/reference
	ALLOW_SMALL_SCALE=1 $(MAKE) generate SCALE=$(or $(DEV_SCALE),0.1) DATA_DIR=data/next
	$(MAKE) bootstrap DATA_DIR=data/next
	$(MAKE) train DATA_DIR=data/next
	$(MAKE) external-data DATA_DIR=data/next
