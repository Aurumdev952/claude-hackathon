"""mart_rates, mart_joinpoint, mart_spatial (SPEC §11.4, §12.1-12.3, §12.5)."""
from __future__ import annotations

import json

import numpy as np
import polars as pl

from shared.config import pipeline_cfg
from shared.geo import DISTRICT_CODES, DISTRICTS

from ..metrics.asr import asr
from ..metrics.joinpoint import fit_joinpoint
from ..metrics.spatial import analyse, eb_smooth, sir_ci
from .common import CASE_DEFS, FIRST_YEAR, geo_levels, sim_years, to_table

SEXES = {"ALL": [0, 1], "M": [1], "F": [0]}
BANDS = ["ALL", "<50", "50-64", "65+"]


def _arrays(con, sim_time):
    y_cur, last_full, frac = sim_years(sim_time)
    years = list(range(FIRST_YEAR, y_cur + 1))
    di = {d: i for i, d in enumerate(DISTRICT_CODES)}
    yi = {y: i for i, y in enumerate(years)}
    N = np.zeros((30, 2, 18, len(years)))
    pop = con.execute("SELECT district_code, sex, age_index, year, population FROM core_ref_population WHERE year BETWEEN ? AND ?",
                      [FIRST_YEAR, y_cur]).fetchall()
    for d, s, a, y, n in pop:
        N[di[d], 1 if s == "M" else 0, a, yi[y]] = n * (frac if y == y_cur else 1.0)
    C = {k: np.zeros_like(N) for k in CASE_DEFS}
    rows = con.execute("""SELECT district_code, sex, least(age_at_dx // 5, 17), year(dx_date), case_status FROM core_gc_case
                          WHERE year(dx_date) BETWEEN ? AND ? AND district_code IS NOT NULL""", [FIRST_YEAR, y_cur]).fetchall()
    for d, s, a, y, st in rows:
        for k, sts in CASE_DEFS.items():
            if st in sts:
                C[k][di[d], 1 if s == "M" else 0, int(a), yi[y]] += 1
    return years, y_cur, last_full, N, C


def _coverage(con, years) -> dict:
    """share of a district's facilities live at mid-year"""
    fac = con.execute("SELECT district_code, go_live_date FROM core_dim_location").fetchall()
    out = {}
    for y in years:
        mid = f"{y}-07-01"
        for d in DISTRICT_CODES:
            fs = [g for dc, g in fac if dc == d]
            out[(d, y)] = sum(1 for g in fs if g is not None and str(g) <= mid) / max(1, len(fs))
    return out


def build_rates(con, sim_time, log=print):
    years, y_cur, last_full, N, C = _arrays(con, sim_time)
    cov = _coverage(con, years)
    periods = [(str(y), "YEAR", [y]) for y in years]
    periods += [(f"{y - 2}-{y}", "POOLED3", [y - 2, y - 1, y]) for y in range(FIRST_YEAR + 2, last_full + 1)]
    periods += [(f"2019-{last_full}", "POOLED_ALL", list(range(2019, last_full + 1))),
                (f"{FIRST_YEAR}-{last_full}", "POOLED_ALL", list(range(FIRST_YEAR, last_full + 1)))]
    yidx = {y: i for i, y in enumerate(years)}
    rows = []
    for level, geo, dists in geo_levels():
        d_idx = [DISTRICT_CODES.index(d) for d in dists]
        for label, ptype, ys in periods:
            y_i = [yidx[y] for y in ys]
            cvals = [cov[(d, y)] for d in dists for y in ys]
            coverage = float(np.mean(cvals))
            for sex, s_idx in SEXES.items():
                n_age = N[np.ix_(d_idx, s_idx, range(18), y_i)].sum(axis=(0, 1, 3))
                for cd, arr in C.items():
                    c_age = arr[np.ix_(d_idx, s_idx, range(18), y_i)].sum(axis=(0, 1, 3))
                    for band in BANDS:
                        r = asr(c_age, n_age, band)
                        rows.append({"level": level, "geo_code": geo, "period": label, "period_type": ptype, "sex": sex,
                                     "age_band": band, "case_def": cd, "cases": int(r["cases"]), "population": r["population"],
                                     "crude_rate": r["crude_rate"], "asr": r["asr"], "asr_lci": r["asr_lci"], "asr_uci": r["asr_uci"],
                                     "asr_var": r.get("asr_var"), "suppressed": r["cases"] < 5,
                                     "coverage_flag": "LOW_EMR_COVERAGE" if coverage < 0.5 else None,
                                     "partial_year": ptype == "YEAR" and ys[0] == y_cur and last_full < y_cur})
    df = pl.DataFrame(rows, infer_schema_length=None)
    to_table(con, "mart_rates", df)
    log(f"    mart_rates: {df.height:,} rows")
    return df


def build_joinpoint(con, sim_time, log=print):
    _, y_cur, last_full, _, _ = _arrays(con, sim_time)
    series = [("NATIONAL", "RW", s, b, cd) for cd in ("CONFIRMED_PROBABLE", "CONFIRMED") for s, b in
              (("ALL", "ALL"), ("M", "ALL"), ("F", "ALL"), ("ALL", "<50"), ("ALL", "50-64"), ("ALL", "65+"))]
    series += [("PROVINCE", p, "ALL", "ALL", "CONFIRMED_PROBABLE") for p in ("KGL", "NOR", "SOU", "EAS", "WES")]
    series += [("DISTRICT", d, "ALL", "ALL", "CONFIRMED_PROBABLE") for d in DISTRICT_CODES]
    ev = con.execute("""SELECT CAST(e.event_date AS VARCHAR), e.description, l.district_code FROM core_facility_events e
                        JOIN core_dim_location l USING (location_id) WHERE e.event_type = 'ENDOSCOPY_OPENED'""").fetchall()
    rows = []
    for level, geo, sex, band, cd in series:
        r = con.execute("""SELECT CAST(period AS INTEGER) y, asr, asr_var, asr_lci, asr_uci, cases, coverage_flag FROM mart_rates
                           WHERE level = ? AND geo_code = ? AND sex = ? AND age_band = ? AND case_def = ? AND period_type = 'YEAR'
                           AND CAST(period AS INTEGER) <= ? ORDER BY 1""", [level, geo, sex, band, cd, last_full]).fetchall()
        years = [x[0] for x in r]
        # zero-count years cannot enter a log-linear fit; they are dropped (shown in observed_json)
        a = np.array([x[1] if x[1] and x[1] > 0 else np.nan for x in r], float)
        v = np.array([x[2] if x[2] and x[2] > 0 else np.nan for x in r], float)
        sid = f"{'NATIONAL' if level == 'NATIONAL' else geo}|{sex}|{band}|{cd}"
        # years with < 50% of facilities live (LOW_EMR_COVERAGE) rest on tiny person-time: they are shown (dashed)
        # but not fitted, unless that would leave too few points for a trend
        ok = np.array([x[6] is None for x in r])
        if ok.sum() >= 6:
            a, v = np.where(ok, a, np.nan), np.where(ok, v, np.nan)
        fit = fit_joinpoint(years, a, v, selection=pipeline_cfg().get("metrics", {}).get("joinpoint_selection", "permutation"))
        observed = [{"year": x[0], "asr": x[1], "lci": x[3], "uci": x[4], "cases": x[5], "coverage_flag": x[6]} for x in r]
        cur = con.execute("""SELECT asr, asr_lci, asr_uci, cases FROM mart_rates WHERE level = ? AND geo_code = ? AND sex = ?
                             AND age_band = ? AND case_def = ? AND period_type = 'YEAR' AND period = ?""",
                          [level, geo, sex, band, cd, str(y_cur)]).fetchone()
        if cur and last_full < y_cur:
            observed.append({"year": y_cur, "asr": cur[0], "lci": cur[1], "uci": cur[2], "cases": cur[3], "partial_year": True})
        events = [{"date": e[0], "label": e[1].replace(" (Synthetic)", ""), "geo_code": e[2]} for e in ev
                  if level == "NATIONAL" or e[2] == geo or (level == "PROVINCE" and DISTRICTS[e[2]][0] == geo)]
        if fit is None:
            rows.append({"series_id": sid, "level": level, "geo_code": geo, "sex": sex, "age_band": band, "case_def": cd,
                         "segment_no": 0, "start_year": None, "end_year": None, "apc": None, "apc_lci": None, "apc_uci": None,
                         "significant": False, "aapc_last10": None, "aapc_lci": None, "aapc_uci": None, "n_joinpoints": None,
                         "fitted_json": "[]", "observed_json": json.dumps(observed), "events_json": json.dumps(events)})
            continue
        for sgm in fit["segments"]:
            rows.append({"series_id": sid, "level": level, "geo_code": geo, "sex": sex, "age_band": band, "case_def": cd,
                         **sgm, "aapc_last10": fit["aapc_last10"]["value"], "aapc_lci": fit["aapc_last10"]["lci"],
                         "aapc_uci": fit["aapc_last10"]["uci"], "n_joinpoints": fit["n_joinpoints"],
                         "fitted_json": json.dumps(fit["fitted"]), "observed_json": json.dumps(observed),
                         "events_json": json.dumps(events)})
    df = pl.DataFrame(rows, infer_schema_length=None)
    to_table(con, "mart_joinpoint", df)
    log(f"    mart_joinpoint: {df['series_id'].n_unique()} series")


def build_spatial(con, sim_time, log=print):
    _, _, last_full, N, C = _arrays(con, sim_time)
    period = f"2019-{last_full}"
    r = con.execute("""SELECT geo_code, asr, cases, population, crude_rate FROM mart_rates WHERE level = 'DISTRICT' AND period = ?
                       AND sex = 'ALL' AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE'""", [period]).fetchall()
    by = {x[0]: x for x in r}
    codes = DISTRICT_CODES
    val = np.array([by[c][1] or 0.0 for c in codes])
    cases = np.array([by[c][2] for c in codes], float)
    popn = np.array([by[c][3] for c in codes], float)
    eb = eb_smooth(cases, popn) * 1e5
    # SIR: expected from national age-sex-specific rates over the pooled period
    years = list(range(FIRST_YEAR, N.shape[3] + FIRST_YEAR))
    yi = [years.index(y) for y in range(2019, last_full + 1)]
    Cn = C["CONFIRMED_PROBABLE"][:, :, :, yi]
    Nn = N[:, :, :, yi]
    nat_rate = np.divide(Cn.sum(axis=(0, 3)), Nn.sum(axis=(0, 3)), out=np.zeros((2, 18)), where=Nn.sum(axis=(0, 3)) > 0)
    expd = np.array([float((nat_rate * Nn[i].sum(axis=2)).sum()) for i in range(len(codes))])
    obsd = np.array([float(Cn[i].sum()) for i in range(len(codes))])
    # SPEC §12.5: clustering runs on age-adjusted, empirical-Bayes-smoothed rates (EB-smoothed SIR, exposure = expected),
    # so small districts' Poisson noise does not mask or fake clusters
    eb_sir = eb_smooth(obsd, np.maximum(expd, 1e-9))
    sp = analyse(codes, eb_sir)
    rows = []
    for i, c in enumerate(codes):
        exp, obs = float(expd[i]), float(obsd[i])
        sir, lo, hi = sir_ci(obs, exp)
        rows.append({"district_code": c, "period": period, "asr": float(val[i]), "crude_rate": by[c][4], "cases": int(obs),
                     "eb_smoothed_rate": float(eb[i]), "eb_sir": float(eb_sir[i]), "expected": exp, "sir": sir, "sir_lci": lo, "sir_uci": hi,
                     "lisa_quadrant": sp["lisa_quadrant"][i], "lisa_quadrant_fdr": sp["lisa_quadrant_fdr"][i],
                     "lisa_p": sp["lisa_p"][i], "lisa_q_fdr": sp["lisa_q_fdr"][i], "gi_star_z": sp["gi_star_z"][i],
                     "global_morans_i": sp["global_morans_i"], "global_p": sp["global_p"]})
    rows.append({"district_code": "RW", "period": period, "asr": None, "crude_rate": None, "cases": int(cases.sum()),
                 "eb_smoothed_rate": None, "eb_sir": 1.0, "expected": None, "sir": 1.0, "sir_lci": None, "sir_uci": None, "lisa_quadrant": None,
                 "lisa_quadrant_fdr": None, "lisa_p": None, "lisa_q_fdr": None, "gi_star_z": None,
                 "global_morans_i": sp["global_morans_i"], "global_p": sp["global_p"]})
    df = pl.DataFrame(rows, infer_schema_length=None)
    to_table(con, "mart_spatial", df)
    hh = [r["district_code"] for r in rows if r["lisa_quadrant"] == "HH"]
    log(f"    mart_spatial: Moran's I={sp['global_morans_i']:.3f} (p={sp['global_p']:.3f}); HH={hh}")
