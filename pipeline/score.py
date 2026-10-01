"""Pipeline step 7: score GI-cohort patients with the active models (SPEC §10.3, §13.10). No-op until `make train`."""
from __future__ import annotations


def score_patients(con, sim_time, log=print):
    try:
        from ml.score import score_in_pipeline
    except ImportError:
        return
    score_in_pipeline(con, sim_time, log)
