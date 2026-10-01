---
name: daily-report
description: Build today's one-page PDF risk brief (reports/daily/YYYY-MM-DD.pdf) from the live serve DB or the committed snapshot, add 3-4 observations versus the previous report, then commit and push. Used by the daily Routine.
argument-hint: "[YYYY-MM-DD, default today]"
allowed-tools: Bash(uv sync:*), Bash(uv run python scripts/daily_report.py:*), Bash(PYTHONPATH=. uv run python scripts/daily_report.py:*), Bash(uv run python scripts/risk_validation.py summary:*), Bash(test -f:*), Bash(ls reports/:*), Bash(git status:*), Bash(git pull --rebase:*), Bash(git add reports/:*), Bash(git commit:*), Bash(git push:*), Bash(git branch --show-current), Bash(make dev-data), Read, Write
disable-model-invocation: true
---

# /daily-report: one-page daily risk brief

Report date D = `$ARGUMENTS` if it is a `YYYY-MM-DD` date, otherwise today. The data is **synthetic**. Patients appear
**by display ID only**. Never write names.

## 1. Sync

```bash
git pull --rebase            # pick up validations and snapshots pushed by other sessions; skip if there is no upstream
uv sync --inexact --extra dev --extra report   # no-op when the SessionStart hook already ran
```

## 2. Pick the data source

```bash
test -f data/analytics/current.json && echo live || echo snapshot
```

- **live**: a published serve DB exists. The script reads it and refreshes `reports/snapshots/latest.json`.
- **snapshot**: a fresh cloud session with no generated data. Render from the committed
  `reports/snapshots/latest.json` plus `reports/risk_validation.jsonl` (add `--from-snapshot`).
- Do **not** generate data, unless the environment variable `REPORT_LIVE=1` is set. Then run `make dev-data`
  (about 15 minutes) and use live mode.

## 3. Build and check

```bash
uv run python scripts/daily_report.py --date D --check            # live
uv run python scripts/daily_report.py --date D --from-snapshot --check   # snapshot
```

`--check` fails unless the PDF is exactly one page. The script also writes `reports/daily/D.json`. That JSON holds the
KPIs, deltas against the previous report, alerts by trigger, the top cases with Claude's verdicts, the validation
summary and data quality.

## 4. Observations

Read `reports/daily/D.json`. If its `previous_report` is set, also read `reports/daily/<previous_report>.json`.
Write **3 to 4** short bullets to a scratchpad file (one per line, starting with `- `, at most about 140 characters
each). Base them only on numbers from those files:

- what changed against the previous report (HIGH count, patients awaiting endoscopy, new HIGH alerts, agreement).
  On the first report, describe the current state instead.
- where Claude's validations disagree with the model, and which reason features are disputed most
- anything that needs action, for example HIGH patients still awaiting endoscopy, or a data-quality check failing
- the national rate trend, with care: a partial year is annualised

Re-render with the observations in the Highlights strip:

```bash
uv run python scripts/daily_report.py --date D [--from-snapshot] --observations <scratchpad>/obs-D.md --check
```

## 5. Commit and push

```bash
git add reports/daily/D.pdf reports/daily/D.json reports/snapshots/latest.json
git commit -m "daily report D"
git push -u origin "$(git branch --show-current)"
```

If nothing changed (the same report was already committed), skip the commit. If the push is rejected, run
`git pull --rebase` and push again. On a network error, retry up to 4 times, waiting 2, 4, 8 and 16 seconds. Never force-push.

## 6. Reply

Give the PDF path, the source (live or snapshot), the KPI line printed by the script and the observations. Use display IDs only.
