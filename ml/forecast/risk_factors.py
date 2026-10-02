"""Risk-factor trends: logit-linear projection of survey indicators with CIs, plus monthly EMR nowcasts.

- Survey rounds (`ext_surveys`, DHS/STEPS-style, synthetic) are pooled per survey year to province/national x sex
  (n-weighted), then logit(p) ~ a + b * year is fitted by weighted least squares (weights 1/se^2 on the logit scale,
  taken from the survey CIs, which already carry the design effect). The covariance is inflated by the residual
  between-survey dispersion (floored at 1). Projection to the horizon gives the 95% CI.
- Fallback without surveys: yearly EMR proxies (H. pylori positivity among the tested, current smoking and high salt
  among the recorded) are trended the same way and labelled as EMR proxies.
- Monthly nowcasts (`emr_nowcasts`, built in the pipeline mart step): H. pylori positivity among the tested, anaemia
  prevalence among Hb tests of the GI cohort, PPI use per GI visit; national and province, with Wilson 95% CIs.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import statsmodels.api as sm

from .data import PROVINCE_OF, nonempty

EPS = 1e-4


def logit(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def expit(x):
    return 1 / (1 + np.exp(-np.asarray(x, float)))


def wilson(k, n, z: float = 1.96):
    k, n = np.asarray(k, float), np.asarray(n, float)
    p = np.divide(k, n, out=np.zeros_like(k), where=n > 0)
    den = 1 + z**2 / np.maximum(n, 1)
    centre = (p + z**2 / (2 * np.maximum(n, 1))) / den
    half = z * np.sqrt(p * (1 - p) / np.maximum(n, 1) + z**2 / (4 * np.maximum(n, 1) ** 2)) / den
    return p, np.clip(centre - half, 0, 1), np.clip(centre + half, 0, 1)


def _pool(g: pd.DataFrame) -> dict:
    """n-weighted pooled proportion and its logit-scale SE from per-row CIs (or binomial SE when CIs are missing)."""
    p = g["value"].values.astype(float)
    n = g["n"].fillna(100).clip(lower=1).values.astype(float)
    se_l = np.where(g["lo95"].notna() & g["hi95"].notna(),
                    (logit(g["hi95"].fillna(0.5)) - logit(g["lo95"].fillna(0.5))) / (2 * 1.96),
                    1 / np.sqrt(n * np.clip(p * (1 - p), EPS, None)))
    var_p = (se_l * np.clip(p * (1 - p), EPS, None)) ** 2
    w = n / n.sum()
    pm = float((w * p).sum())
    vp = float((w**2 * var_p).sum())
    se = np.sqrt(vp) / max(pm * (1 - pm), EPS)
    lo, hi = expit(logit(pm) - 1.96 * se), expit(logit(pm) + 1.96 * se)
    return {"value": pm, "lo95": float(lo), "hi95": float(hi), "se_logit": float(se), "n": float(n.sum())}


def survey_points(surveys: pd.DataFrame) -> pd.DataFrame:
    s = surveys.copy()
    for col in ("value", "lo95", "hi95"):
        if col in s and s[col].max() > 1.5:   # percentages
            s[col] = s[col] / 100.0
    if "n" not in s:
        s["n"] = 100.0
    rows = []
    for (ind, yr), g in s.groupby(["indicator", "year"]):
        for geo, gg in [("RW", g)] + [(p, g[g["province_code"] == p]) for p in sorted(g["province_code"].dropna().unique())]:
            for sex in ("ALL", "M", "F"):
                part = gg if sex == "ALL" else gg[gg["sex"].astype(str).str.upper().str[0] == sex]
                if part.empty:
                    continue
                rows.append({"indicator": ind, "geo_code": geo, "sex": sex, "year": int(yr), **_pool(part)})
    return pd.DataFrame(rows)


def trend(points: pd.DataFrame, years: list[int]) -> pd.DataFrame | None:
    """Logit-linear WLS trend through survey points; returns year, value, lo95, hi95 for `years`."""
    pts = points.dropna(subset=["value"])
    if len(pts) < 2:
        return None
    x = pts["year"].values - 2015.0
    y = logit(pts["value"].values)
    w = 1 / np.maximum(pts["se_logit"].values, 0.02) ** 2
    X = sm.add_constant(x, has_constant="add")
    if len(pts) == 2 or np.ptp(x) == 0:
        b = np.polyfit(x, y, 1) if np.ptp(x) > 0 else np.array([0.0, y.mean()])
        beta = np.array([b[1], b[0]])
        cov = np.diag([float(np.mean(1 / w)), float(np.mean(1 / w)) / max(np.ptp(x), 1) ** 2])
    else:
        r = sm.WLS(y, X, weights=w).fit()
        beta = r.params
        resid_scale = max(1.0, float(np.sum(w * r.resid**2) / max(1, len(y) - 2)))
        cov = np.asarray(r.normalized_cov_params) * resid_scale
    Xf = sm.add_constant(np.asarray(years, float) - 2015.0, has_constant="add")
    m = Xf @ beta
    se = np.sqrt(np.einsum("ij,jk,ik->i", Xf, cov, Xf))
    return pd.DataFrame({"year": years, "value": expit(m), "lo95": expit(m - 1.96 * se), "hi95": expit(m + 1.96 * se),
                         "slope_logit": float(beta[1])})


def emr_proxy_points(con, last_full: int) -> pd.DataFrame:
    """Yearly EMR proxies used when ext_surveys is absent (labelled as such)."""
    hp = con.execute(f"""
        SELECT 'hp_seroprev' AS indicator, year(l.datetime) AS year, p.province_code, p.sex,
               count(*) FILTER (WHERE l.value_coded = 7001) AS k, count(*) AS n
        FROM core_fact_lab l JOIN core_dim_patient p USING (patient_id)
        WHERE l.concept_id IN (3120, 3121, 3122) AND year(l.datetime) <= {last_full} GROUP BY ALL""").df()
    smk = con.execute(f"""
        SELECT 'smoking_current' AS indicator, year(f.tobacco_recorded_at) AS year, p.province_code, p.sex,
               count(*) FILTER (WHERE f.tobacco = 7032) AS k, count(*) AS n
        FROM core_fact_lifestyle f JOIN core_dim_patient p USING (patient_id)
        WHERE f.tobacco IS NOT NULL AND f.tobacco_recorded_at IS NOT NULL AND year(f.tobacco_recorded_at) <= {last_full}
        GROUP BY ALL""").df()
    salt = con.execute(f"""
        SELECT 'high_salt' AS indicator, {last_full} AS year, p.province_code, p.sex,
               count(*) FILTER (WHERE f.high_salt = 7000) AS k, count(*) AS n
        FROM core_fact_lifestyle f JOIN core_dim_patient p USING (patient_id) WHERE f.high_salt IS NOT NULL GROUP BY ALL""").df()
    d = pd.concat([hp, smk, salt], ignore_index=True)
    d = d[d["n"] > 0]
    p, lo, hi = wilson(d["k"].values, d["n"].values)
    d["value"], d["lo95"], d["hi95"] = p, lo, hi
    return d.drop(columns="k")


def build(con, sim_time: dt.datetime, last_full: int, horizon: int) -> tuple[pd.DataFrame, str, pd.DataFrame]:
    """Yearly rows for mart_risk_factor_forecast: survey points + logit-linear trend (fitted + forecast).
    Returns (rows, source label, pooled survey points)."""
    if nonempty(con, "ext_surveys"):
        surveys = con.execute("SELECT * FROM ext_surveys").df()
        source = "Synthetic DHS/STEPS-style surveys (ext_surveys)"
    else:
        surveys = emr_proxy_points(con, last_full)
        source = "EMR proxy among patients with a record (fallback, synthetic)"
    pts = survey_points(surveys)
    rows = []
    for (ind, geo, sex), g in pts.groupby(["indicator", "geo_code", "sex"]):
        g = g.sort_values("year")
        for r in g.itertuples():
            rows.append({"indicator": ind, "geo_code": geo, "sex": sex, "year": int(r.year), "kind": "survey", "value": r.value,
                         "lo95": r.lo95, "hi95": r.hi95, "n": r.n, "source": source})
        first, last = int(g["year"].min()), int(g["year"].max())
        yrs = list(range(first, horizon + 1))
        t = trend(g, yrs)
        if t is None:
            continue
        for r in t.itertuples():
            rows.append({"indicator": ind, "geo_code": geo, "sex": sex, "year": int(r.year),
                         "kind": "forecast" if r.year > last else "fitted", "value": r.value, "lo95": r.lo95, "hi95": r.hi95,
                         "n": None, "source": source})
    out = pd.DataFrame(rows)
    if not out.empty:
        out["period"] = pd.to_datetime(out["year"].astype(str) + "-07-01")
        out["freq"] = "Y"
    return out, source, pts


def prevalence_by_district_year(rf: pd.DataFrame, years: list[int]) -> dict[str, pd.DataFrame]:
    """indicator -> DataFrame(district_code, year, value) from the province trend (sex ALL); national when missing."""
    from shared.geo import DISTRICT_CODES
    out = {}
    tr = rf[(rf["sex"] == "ALL") & rf["kind"].isin(["fitted", "forecast"])] if not rf.empty else rf
    for ind in (tr["indicator"].unique() if not tr.empty else []):
        t = tr[tr["indicator"] == ind]
        piv = t.pivot_table(index="year", columns="geo_code", values="value")
        piv = piv.reindex(sorted(set(piv.index) | set(years))).interpolate(limit_direction="both")
        rows = []
        for d in DISTRICT_CODES:
            col = PROVINCE_OF[d] if PROVINCE_OF[d] in piv.columns else ("RW" if "RW" in piv.columns else None)
            if col is None:
                continue
            for y in years:
                rows.append({"district_code": d, "year": y, "value": float(piv.loc[y, col])})
        out[ind] = pd.DataFrame(rows)
    return out


def emr_nowcasts(con, sim_time: dt.datetime, months: int) -> pd.DataFrame:
    """Monthly EMR proxies for the last `months` complete-or-current months, national + province (sex ALL)."""
    start = (pd.Timestamp(sim_time).to_period("M") - months + 1).to_timestamp()
    q = f"""
    WITH hp AS (
      SELECT date_trunc('month', l.datetime) AS m, p.province_code, (l.value_coded = 7001)::INT AS k
      FROM core_fact_lab l JOIN core_dim_patient p USING (patient_id)
      WHERE l.concept_id IN (3120, 3121, 3122) AND l.datetime >= TIMESTAMP '{start}' AND l.datetime <= TIMESTAMP '{sim_time}'),
    an AS (
      SELECT date_trunc('month', l.datetime) AS m, p.province_code,
             (l.value_numeric < CASE WHEN p.sex = 'M' THEN 13 ELSE 12 END)::INT AS k
      FROM core_fact_lab l JOIN core_dim_patient p USING (patient_id) SEMI JOIN core_gi_cohort g USING (patient_id)
      WHERE l.concept_id = 3100 AND l.datetime >= TIMESTAMP '{start}' AND l.datetime <= TIMESTAMP '{sim_time}'),
    ppi AS (
      SELECT date_trunc('month', g.datetime) AS m, p.province_code,
             (EXISTS (SELECT 1 FROM core_fact_drug d WHERE d.encounter_id = g.encounter_id
                      AND d.course_type IN ('PPI_COURSE', 'PPI_SHORT')))::INT AS k
      FROM core_gi_encounter g JOIN core_dim_patient p USING (patient_id)
      WHERE g.datetime >= TIMESTAMP '{start}' AND g.datetime <= TIMESTAMP '{sim_time}')
    SELECT 'hp_pos_tested' AS indicator, * FROM (SELECT m, province_code, sum(k) AS k, count(*) AS n FROM hp GROUP BY ALL)
    UNION ALL SELECT 'anaemia_gi', * FROM (SELECT m, province_code, sum(k), count(*) FROM an GROUP BY ALL)
    UNION ALL SELECT 'ppi_use', * FROM (SELECT m, province_code, sum(k), count(*) FROM ppi GROUP BY ALL)"""
    d = con.execute(q).df()
    if d.empty:
        return pd.DataFrame()
    nat = d.groupby(["indicator", "m"], as_index=False)[["k", "n"]].sum().assign(province_code="RW")
    d = pd.concat([nat, d], ignore_index=True)
    p, lo, hi = wilson(d["k"].values, d["n"].values)
    out = pd.DataFrame({"indicator": d["indicator"], "geo_code": d["province_code"], "sex": "ALL",
                        "year": pd.to_datetime(d["m"]).dt.year.astype(int), "kind": "nowcast", "value": p, "lo95": lo, "hi95": hi,
                        "n": d["n"].astype(float), "source": "EMR (synthetic)", "period": pd.to_datetime(d["m"]), "freq": "M"})
    return out.sort_values(["indicator", "geo_code", "period"]).reset_index(drop=True)
