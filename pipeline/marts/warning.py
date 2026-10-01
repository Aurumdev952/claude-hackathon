"""Pre-diagnostic signals (SPEC §12.6, INS-3/INS-6): nested case-control with incidence-density sampling,
aligned monthly curves (-24..0) with bootstrap CIs, conditional-logistic signal ORs, diagnostic intervals."""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
import polars as pl
from scipy.stats import mannwhitneyu

from .common import to_table

MONTHS = list(range(-24, 1))


def _matched_sets(con, n_controls: int, seed: int = 42) -> pd.DataFrame:
    cases = con.execute("""SELECT c.patient_id, c.dx_date AS idx, c.sex, p.birthdate, c.province_code, year(g.entry_date) AS ey
                           FROM core_gc_case c JOIN core_dim_patient p USING (patient_id) JOIN core_gi_cohort g USING (patient_id)
                           WHERE c.dx_date >= DATE '2016-06-01'""").df()
    pool = con.execute("""SELECT g.patient_id, g.entry_date, year(g.entry_date) AS ey, p.sex, p.birthdate, p.province_code,
                                 p.death_date, c.dx_date
                          FROM core_gi_cohort g JOIN core_dim_patient p USING (patient_id)
                          LEFT JOIN core_gc_case c USING (patient_id)""").df()
    rng = np.random.default_rng(seed)
    pool["bd"] = pd.to_datetime(pool["birthdate"])
    pool["entry_date"] = pd.to_datetime(pool["entry_date"])
    pool["death_date"] = pd.to_datetime(pool["death_date"])
    pool["dx_date"] = pd.to_datetime(pool["dx_date"])
    groups = {k: g for k, g in pool.groupby(["sex", "province_code"])}
    out = []
    for i, c in enumerate(cases.itertuples(index=False)):
        idx = pd.Timestamp(c.idx)
        out.append((i, c.patient_id, idx, 1))
        g = groups.get((c.sex, c.province_code))
        if g is None:
            continue
        cbd = pd.Timestamp(c.birthdate)
        m = g[(g["patient_id"] != c.patient_id) & ((g["bd"] - cbd).abs() <= pd.Timedelta(days=int(5 * 365.25)))
              & (g["ey"] == c.ey) & (g["entry_date"] <= idx)
              & (g["dx_date"].isna() | (g["dx_date"] > idx)) & (g["death_date"].isna() | (g["death_date"] > idx))]
        if len(m) < n_controls:  # relax the entry-year match when the risk set is small
            m = g[(g["patient_id"] != c.patient_id) & ((g["bd"] - cbd).abs() <= pd.Timedelta(days=int(5 * 365.25)))
                  & (g["entry_date"] <= idx) & (g["dx_date"].isna() | (g["dx_date"] > idx))
                  & (g["death_date"].isna() | (g["death_date"] > idx))]
        if len(m) == 0:
            continue
        pick = m.iloc[rng.choice(len(m), size=min(n_controls, len(m)), replace=False)]
        for pid in pick["patient_id"]:
            out.append((i, int(pid), idx, 0))
    return pd.DataFrame(out, columns=["set_id", "patient_id", "idx", "is_case"])


def _subject_months(con, sets: pd.DataFrame) -> pd.DataFrame:
    con.register("_sets", sets)
    q = """
    WITH s AS (SELECT DISTINCT set_id, patient_id, CAST(idx AS DATE) AS idx, is_case FROM _sets),
    gi AS (SELECT s.set_id, s.patient_id, s.is_case, CAST(floor(date_diff('day', s.idx, g.datetime) / 30.44) AS INTEGER) AS m
           FROM s JOIN core_gi_encounter g ON g.patient_id = s.patient_id
           AND g.datetime >= s.idx - INTERVAL 760 DAY AND g.datetime < s.idx),
    hb AS (SELECT s.set_id, s.patient_id, CAST(floor(date_diff('day', s.idx, l.datetime) / 30.44) AS INTEGER) AS m, l.value_numeric AS hb
           FROM s JOIN core_fact_lab l ON l.patient_id = s.patient_id AND l.concept_id = 3100
           AND l.datetime >= s.idx - INTERVAL 760 DAY AND l.datetime < s.idx),
    ppi AS (SELECT s.set_id, s.patient_id, CAST(floor(date_diff('day', s.idx, d.datetime) / 30.44) AS INTEGER) AS m
            FROM s JOIN core_fact_drug d ON d.patient_id = s.patient_id AND d.course_type IN ('PPI_COURSE', 'PPI_SHORT', 'ANTACID')
            AND d.datetime >= s.idx - INTERVAL 760 DAY AND d.datetime < s.idx),
    wt AS (SELECT s.set_id, s.patient_id, CAST(floor(date_diff('day', s.idx, v.datetime) / 30.44) AS INTEGER) AS m, v.value_numeric AS w
           FROM s JOIN core_fact_vital v ON v.patient_id = s.patient_id AND v.concept_id = 3000
           AND v.datetime >= s.idx - INTERVAL 760 DAY AND v.datetime < s.idx)
    SELECT 'gi' AS k, set_id, patient_id, m, 1.0 AS v FROM gi
    UNION ALL SELECT 'hb', set_id, patient_id, m, hb FROM hb
    UNION ALL SELECT 'ppi', set_id, patient_id, m, 1.0 FROM ppi
    UNION ALL SELECT 'wt', set_id, patient_id, m, w FROM wt
    """
    ev = con.execute(q).df()
    con.unregister("_sets")
    ev = ev[(ev["m"] >= -24) & (ev["m"] <= 0)]
    return ev


def _curves(sets, ev, n_boot: int, seed: int = 7) -> list[dict]:
    subj = sets[["set_id", "patient_id", "is_case"]].drop_duplicates()
    subj["key"] = subj["set_id"].astype(str) + ":" + subj["patient_id"].astype(str)
    ev = ev.assign(key=ev["set_id"].astype(str) + ":" + ev["patient_id"].astype(str))
    keys = {k: i for i, k in enumerate(subj["key"])}
    n, nm = len(subj), len(MONTHS)
    gi = np.zeros((n, nm))
    hbm = np.zeros((n, nm))
    hbsum = np.zeros((n, nm))
    hbn = np.zeros((n, nm))
    ppi = np.zeros((n, nm))
    w = np.full((n, nm), np.nan)
    for k, grp in ev.groupby("k"):
        r = grp["key"].map(keys).values
        c = grp["m"].values + 24
        if k == "gi":
            np.add.at(gi, (r, c), 1)
        elif k == "hb":
            np.add.at(hbsum, (r, c), grp["v"].values)
            np.add.at(hbn, (r, c), 1)
        elif k == "ppi":
            ppi[r, c] = 1
        elif k == "wt":
            w[r, c] = grp["v"].values
    hbm = (hbn > 0).astype(float)
    base_w = np.nanmean(w[:, :6], axis=1) if w.shape[1] else np.nan
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        first = np.array([row[~np.isnan(row)][0] if (~np.isnan(row)).any() else np.nan for row in w])
        base_w = np.where(np.isnan(base_w), first, base_w)
        wchg = 100 * (w - base_w[:, None]) / base_w[:, None]
    is_case = subj["is_case"].values == 1
    rng = np.random.default_rng(seed)
    out = []

    def stat(metric, rows):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if metric == "gi_visits":
                return 100 * gi[rows].mean(axis=0)
            if metric == "pct_hb_measured":
                return 100 * hbm[rows].mean(axis=0)
            if metric == "mean_hb":
                return np.nansum(hbsum[rows], axis=0) / np.maximum(hbn[rows].sum(axis=0), 1e-9)
            if metric == "ppi_rx":
                return 100 * ppi[rows].mean(axis=0)
            if metric == "weight":
                return np.nanmean(wchg[rows], axis=0)

    for grp_name, mask in (("case", is_case), ("control", ~is_case)):
        rows = np.where(mask)[0]
        for metric in ("gi_visits", "pct_hb_measured", "mean_hb", "ppi_rx", "weight"):
            est = stat(metric, rows)
            boots = np.array([stat(metric, rng.choice(rows, size=len(rows), replace=True)) for _ in range(n_boot)])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                lo, hi = np.nanpercentile(boots, 2.5, axis=0), np.nanpercentile(boots, 97.5, axis=0)
            for j, mth in enumerate(MONTHS):
                val = est[j]
                if metric == "mean_hb" and hbn[rows, j].sum() < 3:
                    val = np.nan
                out.append({"month_before": mth, "metric": metric, "group": grp_name,
                            "value": None if np.isnan(val) else float(val),
                            "lci": None if np.isnan(lo[j]) else float(lo[j]), "uci": None if np.isnan(hi[j]) else float(hi[j]),
                            "n": int(len(rows))})
    return out, subj, gi, hbsum, hbn, ppi, wchg


def _signal_or(subj, gi, hbsum, hbn, ppi, wchg, alarm) -> list[dict]:
    from statsmodels.discrete.conditional_models import ConditionalLogit
    last12 = slice(12, 25)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hbv = np.where(hbn > 0, hbsum / np.maximum(hbn, 1), np.nan)
        hb_drop = np.nanmax(hbv[:, :25], axis=1) - np.nanmin(hbv[:, last12], axis=1)
        wl = -np.nanmin(wchg[:, 18:25], axis=1)
    sig = {
        "gi_visits_ge3_12m": (gi[:, last12].sum(axis=1) >= 3).astype(float),
        "hb_drop_ge1_5": np.nan_to_num((hb_drop >= 1.5).astype(float)),
        "ppi_courses_ge2_12m": (ppi[:, last12].sum(axis=1) >= 2).astype(float),
        "weight_loss_ge5pct_6m": np.nan_to_num((wl >= 5).astype(float)),
        "alarm_symptom_12m": alarm.astype(float),
    }
    y = subj["is_case"].values.astype(float)
    groups = subj["set_id"].values
    out = []
    for name, x in sig.items():
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                res = ConditionalLogit(y, x[:, None], groups=groups).fit(disp=0)
            b, se = float(res.params[0]), float(res.bse[0])
            out.append({"signal": name, "or": float(np.exp(b)), "lci": float(np.exp(b - 1.96 * se)),
                        "uci": float(np.exp(b + 1.96 * se)), "p": float(res.pvalues[0]),
                        "pct_cases": float(100 * x[y == 1].mean()), "pct_controls": float(100 * x[y == 0].mean())})
        except Exception:
            out.append({"signal": name, "or": None, "lci": None, "uci": None, "p": None,
                        "pct_cases": float(100 * x[y == 1].mean()), "pct_controls": float(100 * x[y == 0].mean())})
    return out


def build_warning(con, sim_time, log=print):
    from shared.config import pipeline_cfg
    cfg = pipeline_cfg()["metrics"]
    sets = _matched_sets(con, int(cfg.get("controls_per_case", 5)))
    ev = _subject_months(con, sets)
    curves, subj, gi, hbsum, hbn, ppi, wchg = _curves(sets, ev, int(cfg.get("bootstrap_resamples", 200)))
    to_table(con, "mart_prediag_signals", pl.DataFrame(curves, infer_schema_length=None))
    # alarm symptoms in the 12 months before index
    con.register("_subj", subj[["set_id", "patient_id"]].merge(sets[["set_id", "idx"]].drop_duplicates(), on="set_id"))
    al = con.execute("""SELECT DISTINCT s.set_id, s.patient_id FROM _subj s JOIN core_fact_symptom y ON y.patient_id = s.patient_id
                        AND y.concept_id IN (2203, 2205, 2213) AND y.datetime >= CAST(s.idx AS DATE) - INTERVAL 365 DAY
                        AND y.datetime < CAST(s.idx AS DATE)
                        UNION SELECT DISTINCT s.set_id, s.patient_id FROM _subj s JOIN core_fact_diagnosis d ON d.patient_id = s.patient_id
                        AND d.concept_id IN (2016, 2017, 2018) AND d.dx_datetime >= CAST(s.idx AS DATE) - INTERVAL 365 DAY
                        AND d.dx_datetime < CAST(s.idx AS DATE)""").df()
    con.unregister("_subj")
    keyset = set(zip(al["set_id"], al["patient_id"]))
    alarm = np.array([(a, b) in keyset for a, b in zip(subj["set_id"], subj["patient_id"])])
    ors = _signal_or(subj, gi, hbsum, hbn, ppi, wchg, alarm)
    to_table(con, "mart_signal_or", pl.DataFrame(ors, infer_schema_length=None))
    _diag_interval(con)
    _warning_summary(con, sets, subj, gi, hbsum, hbn)
    log(f"    nested case-control: {int(subj['is_case'].sum())} cases, {int((subj['is_case'] == 0).sum())} controls")


def _diag_interval(con):
    d = con.execute("""SELECT diag_interval_days AS days, province_code, coalesce(first_gi_facility_tier, 'unknown') AS tier,
                              age_band, CASE WHEN province_code IN ('EAS', 'SOU') THEN 'malaria_endemic' ELSE 'other' END AS malaria_region,
                              malaria_or_worm_attrib_12m
                       FROM core_gc_case WHERE diag_interval_days IS NOT NULL""").df()
    rows = []
    for gv, col in (("province", "province_code"), ("tier", "tier"), ("age_band", "age_band"), ("malaria_region", "malaria_region")):
        groups = list(d.groupby(col))
        p = None
        if gv == "malaria_region" and len(groups) == 2:
            p = float(mannwhitneyu(groups[0][1]["days"], groups[1][1]["days"]).pvalue)
        for g, s in groups:
            rows.append({"group_var": gv, "group": str(g), "median_days": float(s["days"].median()),
                         "q1": float(s["days"].quantile(0.25)), "q3": float(s["days"].quantile(0.75)), "n": int(len(s)), "p_value": p})
    to_table(con, "mart_diag_interval", pl.DataFrame(rows, infer_schema_length=None))


def _warning_summary(con, sets, subj, gi, hbsum, hbn):
    """Headline INS-3 numbers (cases vs matched controls, 24 months before index)."""
    case = subj["is_case"].values == 1
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hbv = np.where(hbn > 0, hbsum / np.maximum(hbn, 1), np.nan)
        n_hb = (hbn[:, 12:25] > 0).sum(axis=1)
        # decline = largest fall from an earlier value to a later one in the last 12 months (a rise is not a decline)
        win = np.where(np.isnan(hbv[:, 12:25]), -np.inf, hbv[:, 12:25])
        run_max = np.maximum.accumulate(win, axis=1)
        later = np.where(np.isnan(hbv[:, 13:25]), np.inf, hbv[:, 13:25])
        drop = np.max(run_max[:, :-1] - later, axis=1)
        drop = np.where(np.isfinite(drop), drop, np.nan)
    ge3 = gi.sum(axis=1) >= 3
    hb_ok = n_hb >= 2
    missed = con.execute("""
        WITH c AS (SELECT patient_id, dx_date FROM core_gc_case),
        alarm AS (SELECT DISTINCT y.patient_id, y.encounter_id, y.datetime FROM core_fact_symptom y JOIN c USING (patient_id)
                  JOIN core_dim_patient p USING (patient_id)
                  WHERE y.concept_id IN (2203, 2205, 2213) AND y.datetime < c.dx_date AND y.datetime >= c.dx_date - INTERVAL 730 DAY
                    AND date_diff('year', p.birthdate, y.datetime) >= 45),
        scoped AS (SELECT a.patient_id, a.encounter_id FROM alarm a JOIN core_fact_order o ON o.patient_id = a.patient_id
                   AND o.concept_id = 8000 AND o.datetime BETWEEN a.datetime AND a.datetime + INTERVAL 90 DAY)
        SELECT count(DISTINCT a.patient_id) FILTER (WHERE s.encounter_id IS NULL) AS missed,
               count(DISTINCT a.patient_id) AS with_alarm, (SELECT count(*) FROM c) AS n_cases,
               (SELECT count(*) FROM core_gc_case WHERE n_ppi_courses_no_scope >= 2) AS ppi2,
               (SELECT median(diag_interval_days) FROM core_gc_case) AS med_interval
        FROM alarm a LEFT JOIN scoped s USING (patient_id, encounter_id)""").fetchone()
    rows = [
        {"metric": "pct_ge3_gi_visits_24m", "case": 100 * ge3[case].mean(), "control": 100 * ge3[~case].mean()},
        {"metric": "pct_hb_drop_ge1_5_12m", "case": 100 * np.nanmean(drop[case & hb_ok] >= 1.5) if (case & hb_ok).any() else None,
         "control": 100 * np.nanmean(drop[~case & hb_ok] >= 1.5) if (~case & hb_ok).any() else None},
        {"metric": "pct_ge2_ppi_no_scope", "case": 100 * missed[3] / max(1, missed[2]), "control": None},
        {"metric": "median_diag_interval_months", "case": (missed[4] or 0) / 30.44, "control": None},
        {"metric": "pct_alarm45_no_scope_90d", "case": 100 * missed[0] / max(1, missed[2]), "control": None},
        {"metric": "pct_alarm45_no_scope_90d_among_alarm", "case": 100 * missed[0] / max(1, missed[1]), "control": None},
    ]
    to_table(con, "mart_warning_summary", pl.DataFrame(rows, schema={"metric": pl.Utf8, "case": pl.Float64, "control": pl.Float64}))
