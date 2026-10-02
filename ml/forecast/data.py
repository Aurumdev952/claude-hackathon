"""Forecast inputs: incidence history and population by district x sex x 5-year age group x year.

Source priority (docs/contracts/v3-loop.md §6):
1. `ext_registry` + `ext_population` (national synthetic cancer registry 2000-2026, NISR-style projections to 2035);
2. fallback: the EMR (`core_gc_case`, confirmed + probable) with the EMR catchment population `core_ref_population`,
   extrapolated beyond its last year with capped log-linear growth.

Only full years up to the last full sim year are used for fitting. Everything here is synthetic.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from shared.config import load_yaml
from shared.geo import DISTRICT_CODES, DISTRICTS, WHO_STD

W_STD = np.array(WHO_STD, float) / sum(WHO_STD)
PROVINCE_OF = {d: v[0] for d, v in DISTRICTS.items()}
BANDS = {"ALL": list(range(18)), "<50": list(range(10)), "50-64": [10, 11, 12], "65+": [13, 14, 15, 16, 17]}


def cfg() -> dict:
    return load_yaml("forecast.yaml")


def has_table(con, name: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]).fetchone()[0] > 0


def nonempty(con, name: str) -> bool:
    return has_table(con, name) and con.execute(f"SELECT count(*) FROM {name}").fetchone()[0] > 0


def age_index_of_band(b) -> int:
    s = str(b).strip()
    if s.endswith("+"):
        return min(int(s[:-1]) // 5, 17)
    return min(int(s.split("-")[0]) // 5, 17)


def sim_years(sim_time: dt.datetime) -> tuple[int, int]:
    """(current sim year, last full year)."""
    y = sim_time.year
    end = dt.datetime(y, 12, 31, 23, 59, 0)
    return y, (y if sim_time >= end else y - 1)


@dataclass
class History:
    source: str                      # 'registry' | 'emr'
    case_def: str                    # series_id suffix: REGISTRY | CONFIRMED_PROBABLE
    cells: pd.DataFrame              # year, district_code, province_code, sex, age_index, cases, population, completeness
    pop: pd.DataFrame                # year, district_code, province_code, sex, age_index, population (all years to horizon)
    first_year: int
    last_full: int
    sim_year: int
    stage: pd.DataFrame = field(default_factory=pd.DataFrame)   # district_code, year, cases, early_share
    notes: list = field(default_factory=list)

    @property
    def label(self) -> str:
        return ("Synthetic national cancer registry (ext_registry)" if self.source == "registry"
                else "EMR confirmed + probable cases over EMR catchment population (fallback, synthetic)")


def _registry(con, last_full: int, horizon: int) -> History | None:
    if not (nonempty(con, "ext_registry") and nonempty(con, "ext_population")):
        return None
    reg = con.execute("SELECT * FROM ext_registry").df()
    pop = con.execute("SELECT year, district_code, sex, age_band, population FROM ext_population").df()
    reg["age_index"] = reg["age_band"].map(age_index_of_band)
    pop["age_index"] = pop["age_band"].map(age_index_of_band)
    if "completeness" not in reg:
        reg["completeness"] = 1.0
    reg["completeness"] = reg["completeness"].fillna(1.0).clip(0.05, 1.0)
    reg = reg[reg["year"] <= last_full]
    cells = (reg.groupby(["year", "district_code", "sex", "age_index"], as_index=False)
             .agg(cases=("cases", "sum"), completeness=("completeness", "mean")))
    p = pop.groupby(["year", "district_code", "sex", "age_index"], as_index=False)["population"].sum()
    cells = cells.merge(p, on=["year", "district_code", "sex", "age_index"], how="inner")
    p = p[p["year"] <= horizon]
    stage_cols = {c.lower(): c for c in reg.columns if c.lower().startswith("stage_")}
    early = [stage_cols[k] for k in stage_cols if k.replace("stage_", "").split("_")[0] in ("i", "ii")]
    stage = pd.DataFrame()
    if early:
        reg["_early"] = reg[early].fillna(0).sum(axis=1)
        reg["_early"] = np.where(reg["_early"] > 1.5, reg["_early"] / 100.0, reg["_early"])  # pct or share
        g = reg.assign(w=reg["cases"] * reg["_early"]).groupby(["district_code", "year"], as_index=False)[["cases", "w"]].sum()
        cs = g["cases"].astype(float)
        g["early_share"] = np.where(cs > 0, g["w"].astype(float) / np.maximum(cs, 1e-9), np.nan)
        stage = g[["district_code", "year", "cases", "early_share"]]
    h = History("registry", "REGISTRY", _finish(cells), _finish(p), int(cells["year"].min()), last_full, last_full + 1, stage)
    return h


def _emr(con, last_full: int, horizon: int, growth_cap) -> History:
    cases = con.execute("""SELECT year(dx_date) AS year, district_code, sex, least(age_at_dx // 5, 17) AS age_index, count(*) AS cases
                           FROM core_gc_case WHERE case_status IN ('CONFIRMED', 'PROBABLE') AND district_code IS NOT NULL
                           AND year(dx_date) <= ? GROUP BY ALL""", [last_full]).df()
    pop = con.execute("SELECT year, district_code, sex, age_index, sum(population) AS population FROM core_ref_population GROUP BY ALL").df()
    pop = _extend_population(pop, horizon, growth_cap)
    hist_pop = pop[pop["year"] <= last_full]
    cells = hist_pop.merge(cases, on=["year", "district_code", "sex", "age_index"], how="left")
    cells["cases"] = cells["cases"].fillna(0.0)
    cells["completeness"] = 1.0
    stage = con.execute("""SELECT district_code, year(dx_date) AS year, count(*) AS cases,
                                  avg(CASE WHEN stage_group IN ('I', 'II', 'IA', 'IB', 'IIA', 'IIB') THEN 1.0
                                           WHEN stage_group IN ('III', 'IV', 'IIIA', 'IIIB', 'IIIC') THEN 0.0 END) AS early_share
                           FROM core_gc_case WHERE district_code IS NOT NULL AND year(dx_date) <= ? GROUP BY ALL""", [last_full]).df()
    h = History("emr", "CONFIRMED_PROBABLE", _finish(cells), _finish(pop), int(cells["year"].min()), last_full, last_full + 1, stage)
    h.notes.append("ext_registry/ext_population not available: EMR history (short, sample population) used as fallback")
    return h


def _extend_population(pop: pd.DataFrame, horizon: int, cap) -> pd.DataFrame:
    """Extrapolate each district x sex x age cell with its mean log growth over the last 4 years (capped)."""
    last = int(pop["year"].max())
    if last >= horizon:
        return pop
    w = pop.pivot_table(index=["district_code", "sex", "age_index"], columns="year", values="population", aggfunc="sum")
    yrs = [y for y in w.columns if y > last - 4]
    lg = np.log(w[yrs].clip(lower=1e-6))
    g = np.clip((lg[yrs[-1]] - lg[yrs[0]]) / max(1, len(yrs) - 1), np.log1p(cap[0]), np.log1p(cap[1]))
    out = [pop]
    base = w[last]
    for y in range(last + 1, horizon + 1):
        v = (base * np.exp(g * (y - last))).rename("population").reset_index()
        v["year"] = y
        out.append(v)
    return pd.concat(out, ignore_index=True)


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df = df[df["district_code"].isin(DISTRICT_CODES)]
    df["province_code"] = df["district_code"].map(PROVINCE_OF)
    df["sex"] = df["sex"].astype(str).str.upper().str[0]
    df["year"] = df["year"].astype(int)
    df["age_index"] = df["age_index"].astype(int)
    return df.reset_index(drop=True)


def load_history(con, sim_time: dt.datetime, c: dict | None = None) -> History:
    c = c or cfg()
    sim_year, last_full = sim_years(sim_time)
    h = _registry(con, last_full, int(c["horizon_year"]))
    if h is None:
        h = _emr(con, last_full, int(c["horizon_year"]), c["incidence"]["emr_pop_growth_cap"])
    h.sim_year = sim_year
    return h


def asr_from(cases_by_age: np.ndarray, pop_by_age: np.ndarray) -> np.ndarray:
    """WHO-standardised rate per 100k from arrays shaped (..., 18). Same standard as pipeline/metrics/asr.py."""
    rate = np.divide(cases_by_age, pop_by_age, out=np.zeros_like(np.asarray(cases_by_age, float)), where=pop_by_age > 0)
    return (rate * W_STD).sum(axis=-1) * 1e5


def asr_var(cases_by_age: np.ndarray, pop_by_age: np.ndarray) -> np.ndarray:
    v = np.divide(cases_by_age, pop_by_age**2, out=np.zeros_like(np.asarray(cases_by_age, float)), where=pop_by_age > 0)
    return (v * W_STD**2).sum(axis=-1) * 1e10
