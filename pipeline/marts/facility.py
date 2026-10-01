"""mart_facility_quality: H. pylori testing funnel plot + outcomes by first-GI facility (SPEC §12.7, INS-4)."""
from __future__ import annotations

import numpy as np
import polars as pl

from ..metrics.funnel import limits
from .common import to_table


def build_facility_quality(con, sim_time, log=print):
    # dyspepsia-type patients per facility (first such encounter there, 2019+), tested if an HP test/order follows in 90 days
    d = con.execute("""
        WITH dysp AS (SELECT patient_id, location_id, min(dx_datetime) AS t FROM core_fact_diagnosis
                      WHERE concept_id IN (2010, 2012, 2013, 2014, 2015) AND dx_datetime >= TIMESTAMP '2019-01-01'
                      GROUP BY 1, 2),
        hp AS (SELECT patient_id, datetime, location_id FROM core_fact_lab WHERE concept_id IN (3120, 3121, 3122)
               UNION ALL SELECT patient_id, datetime, location_id FROM core_fact_order WHERE concept_id = 8001)
        -- a facility's practice indicator: tested AT that facility within 90 days (tests done elsewhere, e.g. at the
        -- district hospital, say nothing about this facility's practice)
        SELECT d.location_id, count(DISTINCT d.patient_id) AS n_dyspepsia,
               count(DISTINCT d.patient_id) FILTER (WHERE EXISTS (SELECT 1 FROM hp WHERE hp.patient_id = d.patient_id
                         AND hp.location_id = d.location_id
                         AND hp.datetime BETWEEN d.t - INTERVAL 1 DAY AND d.t + INTERVAL 90 DAY)) AS n_hp_tested
        FROM dysp d GROUP BY 1""").pl()
    out = con.execute("""
        SELECT first_gi_facility_id AS location_id, count(*) AS n_cases,
               100.0 * count(*) FILTER (WHERE stage_group = 'IV') / nullif(count(*) FILTER (WHERE stage_group <> 'Unknown'), 0) AS pct_stage4,
               median(diag_interval_days) AS median_diag_interval
        FROM core_gc_case WHERE first_gi_facility_id IS NOT NULL GROUP BY 1""").pl()
    loc = con.execute("SELECT location_id, name, district_code, province_code, facility_type, hp_testing_tier AS tier, lat, lon FROM core_dim_location").pl()
    df = loc.join(d, on="location_id", how="left").join(out, on="location_id", how="left").with_columns(
        pl.col("n_dyspepsia").fill_null(0), pl.col("n_hp_tested").fill_null(0), pl.col("n_cases").fill_null(0))
    tot_n, tot_t = df["n_dyspepsia"].sum(), df["n_hp_tested"].sum()
    p0 = tot_t / tot_n if tot_n else 0.0
    n = df["n_dyspepsia"].to_numpy()
    rate = np.where(n > 0, df["n_hp_tested"].to_numpy() / np.maximum(n, 1), np.nan)
    l95, u95 = limits(n, p0, 0.95)
    l998, u998 = limits(n, p0, 0.998)
    flag = np.where(n < 10, "LOW_VOLUME", np.where(rate > u998, "HIGH_OUTLIER", np.where(rate < l998, "LOW_OUTLIER",
                    np.where(rate > u95, "high", np.where(rate < l95, "low", "within")))))
    # derived tier from observed testing-rate tertiles (so the dashboard also works on real data)
    valid = (n >= 10) & ~np.isnan(rate)
    t1, t2 = (np.nanpercentile(rate[valid], [100 / 3, 200 / 3]) if valid.sum() >= 3 else (np.nan, np.nan))
    derived = np.where(~valid, None, np.where(rate <= t1, "low", np.where(rate <= t2, "medium", "high")))
    df = df.with_columns(pl.Series("hp_test_rate", rate), pl.Series("funnel_lower95", l95), pl.Series("funnel_upper95", u95),
                         pl.Series("funnel_lower998", l998), pl.Series("funnel_upper998", u998), pl.Series("outlier_flag", flag),
                         pl.Series("derived_tier", derived.tolist(), dtype=pl.Utf8), pl.lit(p0).alias("target_rate"))
    to_table(con, "mart_facility_quality", df)
    by_tier = df.filter(pl.col("n_dyspepsia") >= 10).group_by("tier").agg(
        (pl.col("n_hp_tested").sum() / pl.col("n_dyspepsia").sum() * 100).round(1).alias("rate"))
    log(f"    HP testing rate by tier: {dict(by_tier.iter_rows())} (overall {100 * p0:.1f}%)")
