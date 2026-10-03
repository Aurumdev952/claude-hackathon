# Tests and verified results

```bash
make test-fast       # pipeline + API, works on the dev dataset
make test            # everything
make test-insights   # ground-truth recovery only
make e2e             # Playwright journeys (API + Vite running)
make verify          # compare the build with docs/reference_results.json
```

`make verify` and `tests/insights` expect the full scale 1.0 dataset. They fail on dev data by design.

| Suite | Checks |
|---|---|
| `tests/generator/test_realism.py` | §19.2 realism: age pyramid, cohort size, calibration targets, visit rates, seasonality, no impossible dates |
| `tests/pipeline/test_methods.py` | ASR, Fay–Feuer, joinpoint recovery on known series, spatial statistics |
| `tests/insights/test_insight_recovery.py` | §19.3: every planted insight (INS-1…8, micro-cluster, dedup) is re-discovered from the published marts |
| `tests/ml/test_leakage.py` | §19.4: features unchanged when post-landmark data or the excluded diagnostic pathway is deleted; shuffled labels give AUROC ≈ 0.5 |
| `tests/api/test_contract.py` | Envelope, roles, facility scoping, no PII to ministry, alert workflow, notes, case payload, SQL guard |
| `tests/api/test_nl2sql_benchmark.py` | §19.5: 20-question benchmark in template mode (≥ 18/20) |
| `frontend/e2e/` | §19.6 journeys + the 3D case-analysis journey |
| `agent/` (`make agent-test`), `evals/agent/` (`make eval-agent`) | Agent unit tests and the DeepEval readiness gate |

## Verified results (scale 1.0: 1.5M people, history to 30 Jun 2026)

These are synthetic results that the build container measured on the final dataset.

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
- **Models** (test period, 1,023 cases; [D-32](decisions.md) explains why these exceed the spec guidance):

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
