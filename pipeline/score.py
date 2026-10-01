"""Pipeline step 7: score GI-cohort patients with the active models (SPEC §10.3, §13.10). No-op until `make train`."""
from __future__ import annotations


def score_patients(con, sim_time, log=print):
    try:
        from ml.score import score_in_pipeline
    except ImportError:
        return
    score_in_pipeline(con, sim_time, log)
    # the KPI mart is built before scoring, so its risk-based tile is filled in here (latest year only)
    if con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = 'pt_risk'").fetchone()[0]:
        con.execute("""UPDATE mart_kpis SET high_risk_awaiting_endoscopy =
                         (SELECT count(*) FROM pt_risk WHERE risk_band = 'HIGH' AND NOT coalesce(scoped_since_flag, FALSE))
                       WHERE year = (SELECT max(year) FROM mart_kpis)""")
