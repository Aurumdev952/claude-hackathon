# Decisions log

One line per decision (SPEC §20.2 rule 6). `D-xx` ids are referenced from code and config.

| id | decision | why |
|---|---|---|
| D-01 | Build at repo root (not `early-signals/`); SPEC bumped to v1.1 with the 3D Case Analysis addendum. | Repo already exists; v1.1 adds `/patients/{id}/case` + `config/body_map.yaml`. |
| D-02 | Docker Compose files are provided, but this dev container verifies with native processes (apt MySQL 8, uvicorn, vite). | Docker Hub is blocked in the build container. |
| D-03 | Gastric cancer hazard is calibrated to the **case-count** targets (target ASR ≈ 32 world std), not ASR 12. | §8.8 is inconsistent: with the §8.3 pyramid, ASR 12 gives ~90 cases/yr at scale 1.0, while 2,000–3,000 confirmed cases, "1 dx every 1–2 days" (§10.1) and 402 cases/yr (§14.3) all need ASR ≈ 30–33. Case counts give planted insights statistical power. |
| D-04 | Baseline age curve flattened to `{30:2.3, 45:9.8, 60:22, 75:31}` per 100k. | SPEC anchors give median age at dx ≈ 67 and ~7% young-onset; targets are 58–62 and ~21%. |
| D-05 | Background visit rates follow the §6.5 volume table (≈6 visits/patient), realism test checks age-group ordering + broad ranges. | §19.2 visits/person-year ranges (adults 1.5–3) contradict §6.5 (9M visits for 1.5M patients). |
| D-06 | Symptomatic-phase stage durations 4/4/4.5 months (gamma), Hb decline starts 2–8 months before symptoms, survival medians 60/20/10/4.5 months (Weibull k=1.5), terminal hospital work-up. | SPEC's 5/5/6 months + survival medians cannot jointly meet the stage-IV share, diagnostic interval, 6% undiagnosed and 1-year survival targets. Outcome targets were prioritised. |
| D-07 | The generator pre-simulates to 2027-12-31; rows after `history_end` are written to `data/bulk/future/` with ids above every bulk id, and the simulator replays them in time order. | Keeps the live feed consistent with the latent trajectories and keeps ETL id watermarks valid. |
| D-08 | Recovery/realism tolerances widen by `sqrt(1/scale)` below scale 1.0. | Sampling noise at the scales that fit this container (0.2). |
| D-09 | Patients exist in the EMR only from their home facility's go-live date (incl. referral-hospital records). | Makes INS-7 a pure coverage artefact that person-time denominators remove. |
| D-10 | INS-2 trend is applied to onset with a 2-year lag (`trend_lag_years`). | Onset → diagnosis takes ~2 years, so the joinpoint appears in diagnosis years 2018–2020 as specified. |
| D-11 | Young-onset (<50) hazard uses RR_male 0.9 and RR_HP 1.3. | Gives the §9.4 young-onset profile (≈48% female, ≈30% HP-negative, diffuse-rich). |
| D-12 | INS-4 adds facility-practice effects on curative-treatment access and best-supportive-care share (low tier). | Stage mix alone cannot produce the 1-year survival gap (18–26% vs 35–45%). |
| D-13 | INS-6 triggers on a detected Hb drop (measured ≥ 1 g/dL below personal baseline, or anaemia, or visible pallor) and anchors later referral decisions. | With the §8.8 60% Hb-drop share the provincial median gap is capped; achieved ≈ +2–3 months at scale 0.2 (spec 3–5). |
| D-14 | DuckDB pinned to 1.5.5 and extensions installed from PyPI wheels (`duckdb-extension-*`). | extensions.duckdb.org is blocked; PyPI is reachable. |
| D-15 | The 3D body is the Z-Anatomy model (CC BY-SA 4.0, BodyParts3D-derived), meshopt-compressed GLB. | Realistic, open licence, offline. See `frontend/public/models/CREDITS.md`. |
| D-16 | LLM provider defaults to `template`; `ollama` and `anthropic` are implemented and switchable by `LLM_PROVIDER` but not exercised in tests. | User request: build the switch, configure later. |
| D-17 | Scale 1.0 (1.5M people) with routine acute OPD visits thinned ×0.5, `DIAGNOSIS ORDER` obs only for secondary diagnoses, InnoDB compression, TSV streamed at load time. | The full §6.5 volume at scale 1.0 does not fit this container's disk; scale 0.2 is too small for district-level insights (≈40 cases/yr). Result: ≈55M obs (G1 ≥ 50M). |
| D-18 | Tier 3 sequence model implemented in JAX (GRU default, Transformer available) instead of PyTorch. | PyTorch's PyPI wheels pull ~3 GB of CUDA libraries and the CPU wheel index is blocked. |
| D-19 | INS-5 pre-access barrier for the configured district: referral completion 20%, terminal work-up 35%, inconclusive hospital work-up 55%. | Needed for diagnoses to rise +60–100% once the endoscopy unit opens, with flat true incidence. |
| D-20 | Duplicate linking needs exact birthdate agreement or a matching phone when (estimated) birthdates differ. | Year-level blocking on estimated birthdates produced 0.7% false links; now 0.03% with 95% recall. |
| D-21 | Pipeline publishes `pt_timeline` with organ ids (from `config/body_map.yaml`) and a `pt_tumour` table for the 3D Case Analysis. | SPEC v1.1 addendum. |
