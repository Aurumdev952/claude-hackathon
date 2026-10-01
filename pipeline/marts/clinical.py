"""mart_stage_mix, mart_characteristics, mart_survival_km/summary, mart_cox (SPEC §11.4, §12.4)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import polars as pl

from ..metrics.survival import cox, km_tables
from .common import to_table

STAGES = ["I", "II", "III", "IV", "Unknown"]


def build_stage_mix(con, sim_time, log=print):
    df = con.execute("""SELECT year(dx_date) AS year, district_code, province_code,
                               coalesce(first_gi_facility_tier, 'unknown') AS tier, stage_group FROM core_gc_case""").pl()
    rows = []
    for level, col in (("NATIONAL", None), ("PROVINCE", "province_code"), ("DISTRICT", "district_code")):
        keys = [col] if col else []
        for yr_mode in ("YEAR", "ALL"):
            for tier_mode in ("ALL", "TIER"):
                g = keys + (["year"] if yr_mode == "YEAR" else []) + (["tier"] if tier_mode == "TIER" else [])
                agg = df.group_by(g + ["stage_group"]).len() if g else df.group_by("stage_group").len()
                tot = (agg.group_by(g).agg(pl.col("len").sum().alias("tot"),
                                           pl.col("len").filter(pl.col("stage_group") != "Unknown").sum().alias("known"))
                       if g else pl.DataFrame({"tot": [agg["len"].sum()],
                                               "known": [agg.filter(pl.col("stage_group") != "Unknown")["len"].sum()]}))
                agg = agg.join(tot, on=g, how="left") if g else agg.join(tot, how="cross")
                for r in agg.iter_rows(named=True):
                    rows.append({"level": level, "geo_code": r[col] if col else "RW",
                                 "year": str(r["year"]) if yr_mode == "YEAR" else "ALL",
                                 "facility_tier": r["tier"] if tier_mode == "TIER" else "ALL",
                                 "stage_group": r["stage_group"], "n": r["len"], "pct": 100 * r["len"] / r["tot"],
                                 "pct_known": (100 * r["len"] / r["known"]) if (r["stage_group"] != "Unknown" and r["known"]) else None})
    to_table(con, "mart_stage_mix", pl.DataFrame(rows, infer_schema_length=None))
    # chi-square stage x tier (known stages, observed tiers)
    from scipy.stats import chi2_contingency
    ct = (df.filter((pl.col("stage_group") != "Unknown") & pl.col("tier").is_in(["low", "medium", "high"]))
          .group_by("tier", "stage_group").len().pivot(on="stage_group", index="tier", values="len").fill_null(0))
    if ct.height >= 2:
        chi = chi2_contingency(ct.drop("tier").to_numpy())
        con.execute("CREATE OR REPLACE TABLE mart_stage_tier_test AS SELECT ? AS chi2, ? AS dof, ? AS p",
                    [float(chi[0]), int(chi[2]), float(chi[1])])


def build_characteristics(con, sim_time, log=print):
    df = con.execute("""SELECT age_at_dx, age_band, sex, stage_group, lauren, hp_status_ever, case_status,
                               first_gi_facility_tier, n_gi_visits_24m, diag_interval_days FROM core_gc_case""").pl()
    df = df.with_columns(pl.when(pl.col("age_at_dx") < 50).then(pl.lit("<50")).otherwise(pl.lit(">=50")).alias("grp"))
    rows = []
    for grp, sub in [("all", df), ("<50", df.filter(pl.col("grp") == "<50")), (">=50", df.filter(pl.col("grp") == ">=50"))]:
        n = sub.height
        if n == 0:
            continue
        for var in ("sex", "stage_group", "lauren", "hp_status_ever", "case_status", "first_gi_facility_tier"):
            for lvl, cnt in sub.group_by(var).len().iter_rows():
                rows.append({"variable": var, "level": str(lvl), "group": grp, "n": cnt, "pct": 100 * cnt / n,
                             "median": None, "iqr": None})
        for var in ("age_at_dx", "n_gi_visits_24m", "diag_interval_days"):
            v = sub[var].drop_nulls()
            if len(v):
                rows.append({"variable": var, "level": "value", "group": grp, "n": len(v), "pct": None,
                             "median": float(v.median()), "iqr": f"{v.quantile(0.25):.0f}-{v.quantile(0.75):.0f}"})
        rows.append({"variable": "total", "level": "n", "group": grp, "n": n, "pct": 100.0, "median": None, "iqr": None})
    to_table(con, "mart_characteristics", pl.DataFrame(rows, infer_schema_length=None))


def _surv_frame(con) -> pd.DataFrame:
    d = con.execute("""SELECT stage_group AS stage, age_band, sex, province_code AS province,
                              coalesce(first_gi_facility_tier, 'unknown') AS facility_tier, hp_status_ever AS hp_status,
                              CASE WHEN year(dx_date) <= 2019 THEN '2015-2019' ELSE '2020+' END AS period,
                              surv_days, event_death, age_at_dx, case_status
                       FROM core_gc_case WHERE surv_days IS NOT NULL""").df()
    d["event_death"] = d["event_death"].astype(bool)
    return d


def build_survival(con, sim_time, log=print):
    d = _surv_frame(con)
    curves, summary = [], []
    for g in ("stage", "age_band", "sex", "province", "facility_tier", "hp_status", "period"):
        c, s = km_tables(d, g)
        curves += c
        summary += s
    allc, alls = km_tables(d.assign(all="all"), "all")
    curves += allc
    summary += alls
    to_table(con, "mart_survival_km", pl.DataFrame(curves))
    to_table(con, "mart_survival_summary", pl.DataFrame(summary, infer_schema_length=None))
    tiers = {r["group_value"]: r["surv_1y"] for r in summary if r["group_var"] == "facility_tier"}
    log(f"    1y survival by tier: { {k: round(v * 100) for k, v in tiers.items()} }")


def build_cox(con, sim_time, log=print):
    rows = []
    d = _surv_frame(con)
    d = d[d["stage"] != "Unknown"].copy()
    d["hp_tested"] = (d["hp_status"] != "Never tested").astype(float)
    d["male"] = (d["sex"] == "M").astype(float)
    d["stage"] = pd.Categorical(d["stage"], categories=["I", "II", "III", "IV"]).astype(str)
    d["facility_tier"] = d["facility_tier"].where(d["facility_tier"].isin(["low", "medium", "high"]))
    d["tier_low"] = (d["facility_tier"] == "low").astype(float)
    d["tier_medium"] = (d["facility_tier"] == "medium").astype(float)
    d["surv_days"] = d["surv_days"].clip(lower=1)
    d = d.dropna(subset=["facility_tier"])
    rows += cox(d, "surv_days", "event_death", ["stage", "age_at_dx", "male", "tier_low", "tier_medium", "hp_tested"], "stage_model")
    rows += _eradication_model(con)
    rows += _hiv_negative_control(con)
    to_table(con, "mart_cox", pl.DataFrame(rows, schema={"model_id": pl.Utf8, "term": pl.Utf8, "hr": pl.Float64,
                                                           "lci": pl.Float64, "uci": pl.Float64, "p": pl.Float64}))
    for r in rows:
        if r["term"] in ("eradicated", "hiv"):
            log(f"    cox {r['model_id']}: {r['term']} HR={r['hr']:.2f} ({r['lci']:.2f}-{r['uci']:.2f})")


def _eradication_model(con) -> list[dict]:
    """INS-4: H. pylori positive patients, landmark 12 months after the first positive test; exposure = eradication
    course in those 12 months; outcome = gastric cancer diagnosis."""
    d = con.execute("""
        WITH pos AS (SELECT patient_id, min(datetime) AS t FROM core_fact_lab
                     WHERE concept_id IN (3120, 3121, 3122, 5006, 5024) AND value_coded = 7001 GROUP BY 1),
        lm AS (SELECT p.patient_id, CAST(p.t + INTERVAL 365 DAY AS DATE) AS landmark, p.t FROM pos p),
        erad AS (SELECT l.patient_id, count(*) > 0 AS eradicated FROM lm l JOIN core_fact_drug d ON d.patient_id = l.patient_id
                 AND d.course_type = 'HP_ERADICATION' AND d.datetime BETWEEN l.t - INTERVAL 7 DAY AND l.landmark GROUP BY 1),
        im AS (SELECT DISTINCT patient_id FROM core_fact_diagnosis WHERE concept_id IN (2011, 2020)),
        hot AS (SELECT DISTINCT patient_id FROM core_dim_patient WHERE district_code IN ('WES-NYB','NOR-MUS','WES-RUT'))
        SELECT l.patient_id, coalesce(e.eradicated, FALSE)::DOUBLE AS eradicated,
               date_diff('year', p.birthdate, l.landmark) AS age, (p.sex = 'M')::DOUBLE AS male,
               (im.patient_id IS NOT NULL)::DOUBLE AS atrophy_im, (hot.patient_id IS NOT NULL)::DOUBLE AS hotspot,
               c.dx_date, p.death_date, p.last_encounter_date, l.landmark
        FROM lm l JOIN core_dim_patient p USING (patient_id)
        LEFT JOIN erad e USING (patient_id) LEFT JOIN im USING (patient_id) LEFT JOIN hot USING (patient_id)
        LEFT JOIN core_gc_case c USING (patient_id)
        WHERE (c.dx_date IS NULL OR c.dx_date > l.landmark + INTERVAL 30 DAY)
          AND (p.death_date IS NULL OR p.death_date > l.landmark) AND l.landmark < (SELECT max(dx_date) FROM core_gc_case)
    """).df()
    if d.empty:
        return []
    cutoff = pd.Timestamp(con.execute("SELECT max(dx_date) FROM core_gc_case").fetchone()[0])
    end = d["dx_date"].fillna(pd.NaT)
    censor = pd.concat([pd.to_datetime(d["death_date"]), pd.to_datetime(d["last_encounter_date"]) + pd.Timedelta(days=365)], axis=1).min(axis=1)
    censor = censor.where(censor < cutoff, cutoff)
    d["event"] = d["dx_date"].notna()
    stop = pd.to_datetime(end).where(d["event"], censor)
    d["time"] = (stop - pd.to_datetime(d["landmark"])).dt.days.clip(lower=1)
    return cox(d, "time", "event", ["eradicated", "age", "male", "atrophy_im", "hotspot"], "eradication_ins4")


def _hiv_negative_control(con) -> list[dict]:
    d = con.execute("""
        -- exposure = HIV recorded on/before cohort entry; "ever HIV" would count diagnoses made later, which only
        -- people who stay alive and cancer-free can collect (immortal-time bias -> spurious protective HR)
        WITH hivdx AS (SELECT patient_id, min(dx_datetime) AS hiv_t FROM core_fact_diagnosis WHERE concept_id = 2101 GROUP BY 1),
        hiv AS (SELECT h.patient_id FROM hivdx h JOIN core_gi_cohort g USING (patient_id) WHERE h.hiv_t <= g.entry_date)
        SELECT g.patient_id, (h.patient_id IS NOT NULL)::DOUBLE AS hiv, date_diff('year', p.birthdate, g.entry_date) AS age,
               (p.sex = 'M')::DOUBLE AS male, g.entry_date, c.dx_date, p.death_date, p.last_encounter_date
        FROM core_gi_cohort g JOIN core_dim_patient p USING (patient_id) LEFT JOIN hiv h USING (patient_id)
        LEFT JOIN core_gc_case c USING (patient_id)
        WHERE date_diff('year', p.birthdate, g.entry_date) >= 18 AND (c.dx_date IS NULL OR c.dx_date > g.entry_date + INTERVAL 30 DAY)
    """).df()
    if d.empty:
        return []
    cutoff = pd.Timestamp(con.execute("SELECT max(dx_date) FROM core_gc_case").fetchone()[0])
    d["event"] = d["dx_date"].notna()
    censor = pd.concat([pd.to_datetime(d["death_date"]), pd.to_datetime(d["last_encounter_date"]) + pd.Timedelta(days=365)], axis=1).min(axis=1)
    censor = censor.where(censor < cutoff, cutoff)
    stop = pd.to_datetime(d["dx_date"]).where(d["event"], censor)
    d["time"] = (stop - pd.to_datetime(d["entry_date"])).dt.days.clip(lower=1)
    return cox(d, "time", "event", ["hiv", "age", "male"], "hiv_negative_control")
