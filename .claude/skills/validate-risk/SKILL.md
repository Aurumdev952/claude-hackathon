---
name: validate-risk
description: Review the newest HIGH-risk gastric cancer flags against each patient's record, judge whether the flag is clinically justified, and append verdicts to reports/risk_validation.jsonl. Built to run under /loop (e.g. /loop 30m /validate-risk 5).
argument-hint: "[N cases per run, default 5]"
allowed-tools: Bash(uv run python scripts/risk_validation.py:*), Bash(PYTHONPATH=. uv run python scripts/risk_validation.py:*), Bash(DATA_DIR=data/next uv run python scripts/risk_validation.py:*), Bash(DATA_DIR=data/next PYTHONPATH=. uv run python scripts/risk_validation.py:*), Bash(grep -E ^DATA_DIR= .env), Bash(test -f:*), Bash(git status:*), Bash(git add reports/:*), Bash(git commit:*), Bash(git push:*), Bash(git pull --rebase:*), Bash(git branch --show-current), Read, Write
disable-model-invocation: true
---

# /validate-risk: Claude as a second reader of HIGH-risk flags

You are a careful clinical reviewer. The Early Signals model flags patients with a high 12-month probability of gastric
cancer. Check each flag against the facts in that patient's record and record whether the flag is justified.
The data is **synthetic**. Refer to patients **only by display ID** (e.g. `NYA-0119453Y`). Never write names.

N = `$ARGUMENTS` (use 5 if it is empty or not a number).

## 1. Preflight

```bash
grep -E ^DATA_DIR= .env          # v3: the live dataset may live in data/next
test -f data/next/analytics/current.json && echo next; test -f data/analytics/current.json && echo data
```

If `.env` sets `DATA_DIR=./data/next` and `data/next/analytics/current.json` exists, prefix every
`scripts/risk_validation.py` command below with `DATA_DIR=data/next` (the scripts do not read `.env`). If neither file
exists, there is no published data in this session. Say so in one line (`make dev-data` builds a small
dataset) and **stop**. Do not commit anything. Do not run generate/bootstrap/train from this skill: it runs in a loop.

## 2. Fetch the next cases

```bash
uv run python scripts/risk_validation.py cases --limit N
```

The output is JSON: `model_id`, `pending_total`, `already_validated`, `returned` and `cases[]`. Each case has:
`patient_id` (display ID), facility, district, age, sex, `ensemble_prob`, `t1_score`, `top_reasons[]` (model features
with a plain-English `label`, the patient's `value` and the SHAP `contribution`), `facts` (Hb and weight series,
symptoms with alarm flags, `alarm_features_12m`, diagnoses, H. pylori tests and eradication, PPI courses,
endoscopy procedures, pathology and orders, other labs, visit counts), `features` (the scored feature row) and
`open_alerts`. A patient with a doctor-approved care plan (v3) also has `care_outcomes`: the `plans` (pathway, status,
trigger, approval date), `verified_results` (completed care tasks closed by EMR evidence: endoscopy findings such as
`NORMAL` / `GASTRITIS` / `SUSPICIOUS` / `CANCER_FOUND`, H. pylori test and test-of-cure results, Hb rechecks),
`plan_outcomes` (adherence, days to completion, finding, cancer found, stage) and `open_tasks`.

If `returned` is 0, every HIGH case has been reviewed for this model. Print
`Nothing to validate: all <already_validated> HIGH cases reviewed for <model_id>`, run the summary (step 5) and
**stop. No file writes, no commit.** The loop is then a no-op until new cases appear.

## 3. Judge each case

Read every case in full before you decide. Use only the facts in the bundle. Do not invent history.

### Rubric

Weigh the evidence in this order:

1. **Alarm features** (strongest): dysphagia, unintentional weight loss (`weight_change_pct_6m/12m` of about -5% or
   worse, or recorded weight-loss symptoms), palpable abdominal mass, GI bleeding (haematemesis, melaena), persistent
   vomiting. Alarm features in a patient aged 45 or over who has not had an endoscopy since they started mean the flag is justified.
2. **Labs**: falling haemoglobin (`hb_drop_12m` of 2 g/dL or more, a steady downward series), iron-deficiency pattern
   (low Hb with MCV under 80 or low ferritin), especially when iron, antimalarial or anthelminthic courses did not
   correct it. One borderline Hb on its own is weak evidence.
3. **H. pylori status**: positive and untreated adds risk. Positive then eradicated lowers it, but the history still
   counts. Never tested: count as unknown, not as reassurance.
4. **Endoscopy status**: never scoped, or scoped only *before* the alarm features began, supports the flag. A recent
   normal endoscopy that came after the symptoms weakens it a lot.
5. **Verified care outcomes** (`care_outcomes`, when present): these are follow-up results recorded after a doctor
   approved a care plan, so they are the strongest evidence about the flag itself. An endoscopy with a `SUSPICIOUS` or
   `CANCER_FOUND` result, or a positive H. pylori test, supports the flag (agree). A completed endoscopy with a `NORMAL`
   result after the symptoms weakens it, like any recent normal endoscopy (often disagree or uncertain). A negative test
   of cure after eradication lowers the H. pylori contribution. Open or escalated tasks are not evidence either way: say
   that the outcome is pending. Quote verified results in `evidence` with their dates (e.g. `"Care-plan endoscopy
   2026-06-19: suspicious lesion, pathology pending"`).
6. **Symptom course**: GI visits speeding up, repeated PPI courses that did not help, dyspepsia that persists past 45.
7. **Demographics and context** (weakest): age, sex and district rate. These describe who the patient is, not what is
   happening to them.

Then decide:

- **agree**: at least one alarm feature or an objective lab signal (falling Hb, iron-deficiency anaemia over 50)
  backs the flag, and an endoscopy is a reasonable next step. Confidence 0.7 to 0.95.
- **disagree**: the record contradicts the flag, for example a recent normal endoscopy after the symptoms, Hb that
  recovered with treatment, or resolved symptoms with no alarm features. Confidence 0.6 to 0.9.
- **uncertain**: the flag rests mostly on demographics, use of the service (recency or number of visits), or a single
  non-specific finding. Use this when there is too little data to tell. **If the reasons are demographics only, the
  verdict is uncertain.** Confidence 0.4 to 0.7.

For each of the model's `top_reasons`, add a `reason_checks` entry:

- `supported: true`: the fact is in the record and is a plausible clinical risk signal.
- `supported: false`: the fact is missing, contradicted, or not a clinical risk signal at all, for example
  `days_since_last_gi_visit` or other recency and utilisation artefacts.
- `supported: null`: the fact is true but neutral (for example district rate or sex).

`evidence` has 2 to 5 short, specific findings with dates or values (for example `"Hb 11.0 -> 6.4 g/dL, Jan 2025 to
Jun 2026"`). `notes` is one or two sentences that end with a suggested next step.

## 4. Write and append the verdicts

Write a JSON file to the session scratchpad directory (or `/tmp` if there is none), for example
`<scratchpad>/verdicts-<timestamp>.json`:

```json
{
  "validator": "<your model id, e.g. claude-opus-...>",
  "verdicts": [
    {
      "patient_id": "NYA-0119453Y",
      "verdict": "agree",
      "confidence": 0.8,
      "evidence": ["Melaena 2026-06-04", "Hb 12.1 -> 10.0 g/dL in 9 months, MCV 76", "Never scoped"],
      "reason_checks": [{"feature": "days_since_last_gi_visit", "supported": false},
                        {"feature": "age", "supported": true}],
      "suggested_action": "Refer for upper GI endoscopy",
      "notes": "GI bleeding with iron-deficiency anaemia at 54 and no endoscopy. Flag justified; refer for endoscopy."
    }
  ]
}
```

```bash
uv run python scripts/risk_validation.py append <that file>
```

`append` checks the schema, adds `run_at`, `run_id`, `model_id`, facility, probability and reasons from the serve DB,
refuses duplicates (one record per patient per model), appends to `reports/risk_validation.jsonl` and refreshes
`reports/snapshots/latest.json`. If it reports a schema error, fix the file and run it again. Never edit the JSONL by hand.

## 5. Summarise

```bash
uv run python scripts/risk_validation.py summary
```

## 6. Commit and push (only when step 4 appended at least one record)

```bash
git add reports/risk_validation.jsonl reports/snapshots/latest.json
git commit -m "validate-risk: <appended> cases (<agree>/<disagree>/<uncertain>) for <model_id>"
git push -u origin "$(git branch --show-current)"
```

If the push is rejected because the remote moved, run `git pull --rebase` and push again. On a network error, retry up
to 4 times, waiting 2, 4, 8 and 16 seconds. Never force-push.

## 7. Reply

Keep it short: one line per case (`display ID | verdict | confidence | key evidence`), then the summary output.
Never include patient names.
