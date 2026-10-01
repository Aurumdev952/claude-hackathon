# Early Signals — developer and demo targets (SPEC §17.3).
# Native mode (default) runs everything with uv + local MySQL; `make up-docker` uses docker-compose.yml.
SHELL := /bin/bash
SCALE ?= 0.05
PY := PYTHONPATH=. uv run python
SNAP := data/snapshots/latest
.PHONY: setup seed seed-full load snapshot restore bootstrap pipeline-once train up down up-docker down-docker demo \
        reset-demo test test-insights test-fast e2e frontend api sim lint

setup:                      ## toolchains + deps (run before the event, on good internet)
	uv sync --all-extras
	cd frontend && npm ci
	-command -v ollama >/dev/null && ollama pull qwen2.5-coder:7b && ollama pull llama3.1:8b

seed:                       ## generate + load a small dataset (dev)
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
	-mysqldump --single-transaction openmrs | gzip > $(SNAP)/openmrs.sql.gz

restore:                    ## restore the last snapshot
	rm -rf data/bulk && cp -r $(SNAP)/bulk data/bulk
	cp $(SNAP)/*.duckdb $(SNAP)/current.json data/analytics/
	-test -f $(SNAP)/openmrs.sql.gz && gunzip -c $(SNAP)/openmrs.sql.gz | mysql openmrs

api:
	PYTHONPATH=. uv run uvicorn api.main:app --host 0.0.0.0 --port 8000

frontend:
	cd frontend && npm run dev

sim:
	$(PY) -m simulator.tick $(if $(filter true,$(DEMO_MODE)),--demo,)

up:                         ## simulator + pipeline scheduler + API + frontend (native, background, logs in logs/)
	mkdir -p logs
	nohup $(PY) -m simulator.tick $(if $(filter true,$(DEMO_MODE)),--demo,) > logs/sim.log 2>&1 & echo $$! > logs/sim.pid
	nohup $(PY) -m pipeline.scheduler > logs/pipeline.log 2>&1 & echo $$! > logs/pipeline.pid
	nohup $(MAKE) api > logs/api.log 2>&1 & echo $$! > logs/api.pid
	nohup $(MAKE) frontend > logs/frontend.log 2>&1 & echo $$! > logs/frontend.pid
	@echo "dashboard: http://localhost:5173   api: http://localhost:8000/api/v1/docs"

down:
	-for p in logs/*.pid; do kill $$(cat $$p) 2>/dev/null; rm -f $$p; done

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
	PYTHONPATH=. uv run pytest -q

test-insights:              ## ground-truth recovery only
	PYTHONPATH=. uv run pytest -q tests/insights

test-fast:
	PYTHONPATH=. uv run pytest -q tests/pipeline tests/api

e2e:                        ## Playwright journeys (API on :8000 and Vite on :5173 must be running)
	cd frontend && npx playwright test
