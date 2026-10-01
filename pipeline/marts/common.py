"""Shared helpers for mart builders."""
from __future__ import annotations

import datetime as dt

import polars as pl

from shared.geo import DISTRICT_CODES, DISTRICTS, PROVINCES

PROVINCE_CODES = list(PROVINCES)
CASE_DEFS = {"CONFIRMED": ["CONFIRMED"], "CONFIRMED_PROBABLE": ["CONFIRMED", "PROBABLE"]}
FIRST_YEAR = 2015


def to_table(con, name: str, df: pl.DataFrame):
    con.register("_tmp_df", df.to_arrow())
    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM _tmp_df")
    con.unregister("_tmp_df")


def sim_years(sim_time: dt.datetime) -> tuple[int, int, float]:
    """(current sim year, last full year, elapsed fraction of the current year)."""
    y = sim_time.year
    start = dt.datetime(y, 1, 1)
    frac = min(1.0, max(1 / 365, (sim_time - start).total_seconds() / (365.25 * 86400)))
    last_full = y if frac >= 0.999 else y - 1
    return y, last_full, frac


def geo_levels():
    """(level, geo_code, list of district codes)"""
    out = [("NATIONAL", "RW", DISTRICT_CODES)]
    for p in PROVINCE_CODES:
        out.append(("PROVINCE", p, [d for d in DISTRICT_CODES if DISTRICTS[d][0] == p]))
    for d in DISTRICT_CODES:
        out.append(("DISTRICT", d, [d]))
    return out
