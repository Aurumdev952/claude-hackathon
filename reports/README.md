# reports/

Outputs of the Claude Code automations. Everything here is **synthetic** and identifies patients by **display ID only**.

| File | Written by | Committed |
|---|---|---|
| `risk_validation.jsonl` | `/validate-risk` via `scripts/risk_validation.py append` | yes |
| `daily/<YYYY-MM-DD>.pdf` | `/daily-report` / daily Routine via `scripts/daily_report.py` | yes |
| `daily/<YYYY-MM-DD>.json` | same (companion data for day-over-day diffs) | yes |
| `snapshots/latest.json` | `risk_validation.py append`, `daily_report.py` (live mode), `daily_report.py --snapshot-only` | yes |
| `snapshots/<YYYY-MM-DD>.json` | same, dated copies | no (gitignored) |

## risk_validation.jsonl

One JSON object per line, one record per **(patient display ID, risk model)**. A case is reviewed again only when a new
model is registered. Fields:

`run_at`, `run_id` (validation run), `pipeline_run_id`, `as_of` (scoring date), `model_id` (active Tier 2 model),
`validator` (Claude model id), `patient_id` (display ID), `facility`, `facility_id`, `district_code`, `risk_band`,
`ensemble_prob`, `t1_score`, `top_reasons[]` (`feature`, `label`), `verdict` (`agree|disagree|uncertain`),
`confidence` (0-1), `evidence[]`, `reason_checks[]` (`feature`, `supported` true/false/null), `suggested_action`, `notes`.

```bash
uv run python scripts/risk_validation.py cases --limit 5   # next unvalidated HIGH cases with fact bundles
uv run python scripts/risk_validation.py append verdicts.json
uv run python scripts/risk_validation.py summary           # add --json for machine-readable output
```

## Daily PDF

A4, fixed grid, always one page (`--check` asserts this with pypdf). It contains:

- a header with the run and model, and a synthetic-data badge
- 5 KPI tiles: HIGH patients, awaiting endoscopy, new HIGH alerts, Claude agreement, national ASR
- a trend chart and an alerts-by-trigger chart
- a Highlights strip (Claude's observations, or the computed defaults)
- the top 10 high-risk patients with Claude's verdicts
- a footer with the validation summary, data quality and provenance

```bash
uv run python scripts/daily_report.py --check                  # live serve DB when present, else snapshot
uv run python scripts/daily_report.py --from-snapshot --check  # committed snapshot only (fresh cloud session)
uv run python scripts/daily_report.py --snapshot-only          # refresh snapshots/latest.json, no PDF
uv run python scripts/daily_report.py --date 2026-10-01 --observations obs.md --check
```
