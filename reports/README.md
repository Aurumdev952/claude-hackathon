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
- a trend chart and an alerts-by-trigger chart (including `CARE_OVERDUE`, raised by the care escalation ladder)
- **care coordination** (v3): new care plans in the last 7 sim days, overdue tasks (and CHW escalations), the task
  completion rate (completed / tasks completed or past due, cancelled excluded) and the median days from plan approval
  to a completed endoscopy
- **Outlook 2031** (v3): the national forecast mean with its 95% interval, the change against the last observed year
  and a mini fan chart (synthetic registry, APC + ETS ensemble)
- a Highlights strip (Claude's observations, or the computed defaults)
- the top 8 high-risk patients with Claude's verdicts
- a footer with the validation summary, data quality and provenance

Design v3 (D-44): flat grey tiles on a white page, signal orange only for attention (awaiting, overdue, new alerts),
sky blue for data.

## Snapshot schema

`snapshots/latest.json` is schema 2 since v3. Besides the v1 keys (`kpis`, `bands`, `high_history`, `cases_by_year`,
`alerts_by_trigger`, `top_cases`, `data_quality`) it carries `care` (`plans_total`, `plans_active`, `new_plans_7d`,
`facilities`, `open_tasks`, `overdue_tasks`, `chw_escalations`, `completed_tasks`, `due_or_done_tasks`,
`completion_rate_pct`, `endoscopies_completed`, `median_days_to_endoscopy`, `by_pathway`) and `forecast`
(`horizon_year`, `mean`, `lo80`, `hi80`, `lo95`, `hi95`, `base_year`, `base_cases`, `change_pct`, `model`, `run_id`,
`series`). Both are counts and aggregates only. A schema-1 snapshot still renders (the two cards show placeholders), so
the daily Routine keeps working in a fresh session. Regenerate it only through the scripts, against the live dataset:

```bash
DATA_DIR=data/v3 PYTHONPATH=. uv run python scripts/daily_report.py --snapshot-only
```

## Verified care outcomes in /validate-risk

When a HIGH case has a doctor-approved care plan, `risk_validation.py cases` adds `care_outcomes` to its bundle:
completed care tasks closed by EMR evidence (endoscopy findings, H. pylori test and test-of-cure results, Hb
rechecks), the plan outcome (adherence, days to completion, finding) and open tasks. The skill treats a verified
endoscopy or H. pylori result as the strongest evidence about the flag.

```bash
uv run python scripts/daily_report.py --check                  # live serve DB when present, else snapshot
DATA_DIR=data/v3 uv run python scripts/daily_report.py --check   # v3 dataset (make report exports DATA_DIR from .env)
uv run python scripts/daily_report.py --from-snapshot --check  # committed snapshot only (fresh cloud session)
uv run python scripts/daily_report.py --snapshot-only          # refresh snapshots/latest.json, no PDF
uv run python scripts/daily_report.py --date 2026-10-01 --observations obs.md --check
```
