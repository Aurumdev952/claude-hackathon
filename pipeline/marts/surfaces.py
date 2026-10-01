"""Marts for the Three.js scenes (SPEC §16.3): the year x age 'rate landscape' (V3) and the pre-diagnostic journey
helix (V4). Only aggregates / anonymous sampled events - no patient ids."""
from __future__ import annotations

import secrets

import numpy as np
import polars as pl

from shared.geo import AGE_GROUPS

from .common import CASE_DEFS, FIRST_YEAR, sim_years, to_table


def build_rate_surface(con, sim_time, log=print):
    y_cur, last_full, _ = sim_years(sim_time)
    pop = con.execute(f"""SELECT year, age_index, sum(population) AS py FROM core_ref_population
                          WHERE year BETWEEN {FIRST_YEAR} AND {last_full} GROUP BY 1, 2""").pl()
    rows = []
    for cd, sts in CASE_DEFS.items():
        lst = ",".join(f"'{s}'" for s in sts)
        c = con.execute(f"""SELECT year(dx_date) AS year, least(age_at_dx // 5, 17) AS age_index, count(*) AS cases FROM core_gc_case
                            WHERE case_status IN ({lst}) AND year(dx_date) BETWEEN {FIRST_YEAR} AND {last_full} GROUP BY 1, 2""").pl()
        df = pop.join(c, on=["year", "age_index"], how="left").with_columns(pl.col("cases").fill_null(0))
        # 3-year centred smoothing per age group keeps the surface readable without hiding the trend
        df = df.sort(["age_index", "year"]).with_columns(
            pl.col("cases").rolling_sum(3, center=True, min_samples=1).over("age_index").alias("c3"),
            pl.col("py").rolling_sum(3, center=True, min_samples=1).over("age_index").alias("p3"))
        for r in df.iter_rows(named=True):
            rows.append({"case_def": cd, "year": r["year"], "age_index": r["age_index"], "age_group": AGE_GROUPS[r["age_index"]],
                         "cases": r["cases"], "population": r["py"], "rate": 1e5 * r["cases"] / r["py"] if r["py"] else None,
                         "rate_smoothed": 1e5 * r["c3"] / r["p3"] if r["p3"] else None})
    to_table(con, "mart_rate_surface", pl.DataFrame(rows, infer_schema_length=None))


def build_journey(con, sim_time, log=print, n_cases: int = 200):
    ev = con.execute(f"""
        WITH c AS (SELECT patient_id, dx_date, stage_group FROM core_gc_case WHERE dx_date >= DATE '2017-01-01'
                   AND n_gi_visits_24m >= 1 USING SAMPLE {n_cases} ROWS (reservoir, 42))
        SELECT c.patient_id, c.stage_group,
               CAST(floor(date_diff('day', c.dx_date, t.ts) / 30.44) AS INTEGER) AS month_before, t.event_type,
               CASE WHEN t.event_type = 'LAB' AND t.concept_id = 3100 THEN 'HB' ELSE t.event_type END AS kind,
               t.is_abnormal, t.concept_id
        FROM c JOIN pt_timeline t ON t.patient_id = c.patient_id
        WHERE t.ts >= c.dx_date - INTERVAL 730 DAY AND t.ts < c.dx_date
          AND t.event_type IN ('VISIT', 'SYMPTOM', 'LAB', 'DRUG', 'DIAGNOSIS', 'ORDER')""").pl()
    ids = {p: i for i, p in enumerate(ev["patient_id"].unique().sort().to_list())}
    salt = secrets.token_hex(3)
    ev = ev.with_columns(pl.col("patient_id").replace_strict(ids).alias("case_index"),
                         pl.col("patient_id").replace_strict({p: f"{salt}-{i}" for p, i in ids.items()}).alias("case_id")).drop("patient_id")
    ev = ev.filter(pl.col("month_before").is_between(-24, -1))
    to_table(con, "mart_journey_events", ev)
