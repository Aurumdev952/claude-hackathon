"""SPEC §10.6 data-quality checks. Critical failures abort the run (no publish)."""
from __future__ import annotations

import datetime as dt


class CriticalDQError(RuntimeError):
    pass


def _q(con, sql):
    return con.execute(sql).fetchone()[0]


def check_raw(con, sim_time: dt.datetime) -> list[dict]:
    res = []
    newest = _q(con, f"SELECT max(encounter_datetime) FROM raw_encounter WHERE encounter_datetime <= TIMESTAMP '{sim_time}' + INTERVAL 1 DAY")
    lag_days = (sim_time - newest).total_seconds() / 86400 if newest else 999
    res.append({"metric": "freshness_days", "value": round(lag_days, 2), "threshold": 2, "level": "critical",
                "status": "OK" if lag_days <= 2 else "FAIL"})
    unknown_concept = _q(con, "SELECT count(*) FROM raw_obs o ANTI JOIN raw_concept c ON c.concept_id = o.concept_id")
    unknown_person = _q(con, "SELECT count(*) FROM raw_obs o ANTI JOIN raw_person p ON p.person_id = o.person_id")
    for m, v in (("unknown_concept_obs", unknown_concept), ("unknown_person_obs", unknown_person)):
        res.append({"metric": m, "value": v, "threshold": 0, "level": "critical", "status": "OK" if v == 0 else "FAIL"})
    con.execute("CREATE OR REPLACE TABLE dq_raw_results (metric VARCHAR, value DOUBLE, threshold DOUBLE, level VARCHAR, status VARCHAR)")
    con.executemany("INSERT INTO dq_raw_results VALUES (?, ?, ?, ?, ?)",
                    [[r["metric"], r["value"], r["threshold"], r["level"], r["status"]] for r in res])
    bad = [r for r in res if r["level"] == "critical" and r["status"] == "FAIL"]
    if bad:
        raise CriticalDQError(f"critical raw DQ failures: {bad}")
    return res


def check_marts(con, sim_time: dt.datetime) -> list[dict]:
    res = []
    bad_case = _q(con, """SELECT count(*) FROM core_gc_case c JOIN core_dim_patient p USING (patient_id)
                          WHERE c.dx_date < p.first_encounter_date""")
    res.append({"metric": "case_dx_before_first_encounter", "value": bad_case, "threshold": 0, "level": "critical",
                "status": "OK" if bad_case == 0 else "FAIL"})
    hb_bad = _q(con, "SELECT count(*) FROM core_fact_lab WHERE concept_id = 3100 AND (value_numeric < 3 OR value_numeric > 22)")
    res.append({"metric": "hb_implausible", "value": hb_bad, "threshold": 0, "level": "warning", "status": "OK" if hb_bad == 0 else "WARN"})
    nat = _q(con, "SELECT count(*) FROM mart_rates WHERE level = 'NATIONAL'")
    res.append({"metric": "mart_rates_national_rows", "value": nat, "threshold": 1, "level": "critical", "status": "OK" if nat > 0 else "FAIL"})
    con.execute("CREATE OR REPLACE TABLE dq_mart_results (metric VARCHAR, value DOUBLE, threshold DOUBLE, level VARCHAR, status VARCHAR)")
    con.executemany("INSERT INTO dq_mart_results VALUES (?, ?, ?, ?, ?)",
                    [[r["metric"], r["value"], r["threshold"], r["level"], r["status"]] for r in res])
    bad = [r for r in res if r["level"] == "critical" and r["status"] == "FAIL"]
    if bad:
        raise CriticalDQError(f"critical mart DQ failures: {bad}")
    return res
