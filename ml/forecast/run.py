"""`python -m ml.forecast`: fit every forecast model and persist the ml_forecast_* tables, then rebuild the forecast marts.

Heavy fitting lives here (`make forecast`, also at the end of `make train` and every 30 sim days through
`ml.retrain.maybe_retrain`); `pipeline/marts/forecast.py` only copies these tables and adds the cheap monthly parts.
"""
from __future__ import annotations

import datetime as dt
import json
import time

import numpy as np
import pandas as pd

from shared.geo import DISTRICT_CODES, PROVINCES

from . import backtest as BT
from . import risk_factors as RF
from . import scenario as SC
from .apc import sample_counts
from .data import PROVINCE_OF, History, cfg, has_table, load_history
from .drivers import das_gupta
from .incidence import GeoFit, SeriesFC, eb_district_factors, quantiles

NAT_SERIES = [("ALL", "ALL"), ("M", "ALL"), ("F", "ALL"), ("ALL", "<50"), ("ALL", "50-64"), ("ALL", "65+")]


def _sid(level: str, code: str, sex: str, band: str, case_def: str) -> str:
    return f"{'NATIONAL' if level == 'NATIONAL' else code}|{sex}|{band}|{case_def}"


def _rows(level, code, sex, band, h: History, hist: pd.DataFrame, fc: SeriesFC, run_id: str) -> list[dict]:
    sid = _sid(level, code, sex, band, h.case_def)
    base = {"series_id": sid, "geo_level": level, "geo_code": code, "sex": sex, "age_band": band, "freq": "Y", "run_id": run_id}
    out = []
    for r in hist.itertuples():
        p = dt.date(int(r.year), 1, 1)
        out.append({**base, "period": p, "kind": "history", "metric": "cases", "mean": r.cases, "lo80": None, "hi80": None,
                    "lo95": None, "hi95": None, "model": "observed", "cases_obs": r.cases})
        out.append({**base, "period": p, "kind": "history", "metric": "asr", "mean": r.asr, "lo80": None, "hi80": None,
                    "lo95": r.asr_lci, "hi95": r.asr_uci, "model": "observed", "cases_obs": r.cases})
    qc, qa = quantiles(fc.cases_draws), quantiles(fc.asr_draws)
    for j, y in enumerate(fc.years):
        p = dt.date(int(y), 1, 1)
        for metric, m, q in (("cases", fc.cases_mean[j], qc), ("asr", fc.asr_mean[j], qa)):
            lo95, lo80, hi80, hi95 = (float(v) for v in q[:, j])
            m = float(m)
            out.append({**base, "period": p, "kind": "forecast", "metric": metric, "mean": m, "lo80": min(lo80, m), "hi80": max(hi80, m),
                        "lo95": min(lo95, lo80, m), "hi95": max(hi95, hi80, m), "model": fc.model, "cases_obs": None})
    return out


def _district_hist(h: History, d: str) -> pd.DataFrame:
    from pipeline.metrics.asr import asr as asr_ci
    rows = []
    for y, g in h.cells[h.cells["district_code"] == d].groupby("year"):
        c, n = np.zeros(18), np.zeros(18)
        np.add.at(c, g["age_index"].values, g["cases"].values)
        np.add.at(n, g["age_index"].values, g["population"].values)
        r = asr_ci(c, n)
        rows.append({"year": int(y), "cases": float(c.sum()), "asr": r["asr"], "asr_lci": r["asr_lci"], "asr_uci": r["asr_uci"]})
    return pd.DataFrame(rows)


def _districts(h: History, provs: dict[str, GeoFit], eb: pd.DataFrame, rng, n: int):
    """District forecasts = province rates x district population x EB SIR (gamma posterior draws), normalised so the
    districts of a province add up to the province mean."""
    out = {}
    ebi = eb.set_index("district_code")
    for p, g in provs.items():
        rm, rd = g.rates_draws()
        fut = g.fut[["year", "sex", "age_index"]]
        apc_p = g.apc_series("ALL", "ALL")
        dists = [d for d in DISTRICT_CODES if PROVINCE_OF[d] == p and d in ebi.index]
        exp_mean, exp_draws, pops = {}, {}, {}
        for d in dists:
            pd_ = h.pop[(h.pop["district_code"] == d)].groupby(["year", "sex", "age_index"], as_index=False)["population"].sum()
            P = fut.merge(pd_, on=["year", "sex", "age_index"], how="left")["population"].fillna(0).values
            pops[d] = P
            exp_mean[d] = np.array([np.sum((rm * P)[fut["year"].values == y]) for y in g.years_fc])
            exp_draws[d] = np.column_stack([(rd * P[None, :])[:, fut["year"].values == y].sum(axis=1) for y in g.years_fc])
        prov_total = np.array([np.sum(g.mu_mean[fut["year"].values == y] * g.factor[j]) for j, y in enumerate(g.years_fc)])
        denom = sum(exp_mean[d] * ebi.loc[d, "sir_eb"] for d in dists)
        k = np.divide(prov_total, denom, out=np.ones_like(prov_total), where=denom > 0)
        for d in dists:
            sir_d = rng.gamma(ebi.loc[d, "shape"], 1.0 / ebi.loc[d, "rate"], size=n)
            mu_d = exp_draws[d] * sir_d[:, None] * k[None, :]
            counts = sample_counts(mu_d, g.fit.scale, rng)
            mean = exp_mean[d] * ebi.loc[d, "sir_eb"] * k
            asr_d = apc_p.asr_draws * (sir_d[:, None] * k[None, :]) * np.divide(counts, mu_d, out=np.ones_like(counts), where=mu_d > 0)
            asr_m = apc_p.asr_mean * ebi.loc[d, "sir_eb"] * k
            out[d] = (SeriesFC(g.years_fc, mean, counts, asr_m, asr_d, "eb(province apc)"), pops[d])
    return out


def _driver_rows(geo_level, code, pop1, rate1, pop2, rate2, y1, y2, target_to: float | None = None) -> list[dict]:
    """target_to: the published (ensemble / EB) forecast mean for y2; the target-year rates are scaled to it so the
    decomposition ends exactly at the number shown on the forecast chart (the scaling falls in the risk component)."""
    tot = float(np.sum(pop2 * rate2))
    if target_to is not None and np.isfinite(target_to) and tot > 0:
        rate2 = rate2 * (target_to / tot)
    r = das_gupta(pop1, rate1, pop2, rate2)
    base = r["cases_from"]
    return [{"geo_level": geo_level, "geo_code": code, "from_year": y1, "to_year": y2, "component": comp, "cases": r[comp],
             "pct": 100 * r[comp] / base if base > 0 else None, "cases_from": r["cases_from"], "cases_to": r["cases_to"],
             "total_change": r["total"]} for comp in ("population", "ageing", "risk")]


def _geo_driver_arrays(g: GeoFit, y1: int, y2: int):
    hm = g.hist["year"].values == y1
    fm = g.fut["year"].values == y2
    j = g.years_fc.index(y2)
    pop1 = g.hist["population"].values[hm]
    rate1 = np.divide(g.fitted_hist[hm], pop1, out=np.zeros(hm.sum()), where=pop1 > 0)
    key1 = list(zip(g.hist["sex"].values[hm], g.hist["age_index"].values[hm]))
    pop2 = g.fut["population"].values[fm]
    rate2 = np.divide(g.mu_mean[fm] * g.factor[j], pop2, out=np.zeros(fm.sum()), where=pop2 > 0)
    key2 = list(zip(g.fut["sex"].values[fm], g.fut["age_index"].values[fm]))
    keys = sorted(set(key1) | set(key2))
    a = {k: (0.0, 0.0) for k in keys}
    b = dict(a)
    for k, p, r in zip(key1, pop1, rate1):
        a[k] = (p, r)
    for k, p, r in zip(key2, pop2, rate2):
        b[k] = (p, r)
    return (np.array([a[k][0] for k in keys]), np.array([a[k][1] for k in keys]),
            np.array([b[k][0] for k in keys]), np.array([b[k][1] for k in keys]), keys)


def _access(con) -> callable:
    rows = con.execute("""SELECT district_code, min(endoscopy_from_date) FROM core_dim_location
                          WHERE endoscopy_from_date IS NOT NULL AND facility_type IN ('DISTRICT', 'PROVINCIAL', 'REFERRAL')
                          GROUP BY 1""").fetchall() if has_table(con, "core_dim_location") else []
    first = {d: pd.Timestamp(t) for d, t in rows if t is not None}

    def f(d: str, year: int) -> int:
        t = first.get(d)
        return int(t is not None and t <= pd.Timestamp(f"{int(year)}-07-01"))
    return f


def run(con, sim_time: dt.datetime, log=print, c: dict | None = None, backtests: bool = True) -> dict:
    t0 = time.time()
    c = c or cfg()
    rng = np.random.default_rng(int(c["seed"]))
    run_id = f"fc-{sim_time:%Y%m%d}-{dt.datetime.now():%H%M%S}"
    h = load_history(con, sim_time, c)
    horizon = int(c["horizon_year"])
    years_fc = list(range(h.last_full + 1, horizon + 1))
    n = int(c["draws"])
    log(f"  forecast source: {h.source} ({h.first_year}-{h.last_full}, {int(h.cells['cases'].sum()):,} cases), horizon {years_fc[0]}-{horizon}")

    nat = GeoFit(h.cells, h.pop, years_fc, c, rng, n)
    provs = {p: GeoFit(h.cells[h.cells["province_code"] == p], h.pop[h.pop["province_code"] == p], years_fc, c, rng, n)
             for p in PROVINCES if (h.cells["province_code"] == p).any()}
    nat_tot = np.array([nat.mu_mean[nat.fut["year"].values == y].sum() for y in years_fc])
    prov_tot = sum(np.array([g.mu_mean[g.fut["year"].values == y].sum() for y in years_fc]) for g in provs.values())
    fac = np.divide(nat_tot, prov_tot, out=np.ones_like(nat_tot), where=prov_tot > 0)
    for g in provs.values():
        g.factor = fac.copy()
    log(f"  APC national: drift {nat.fit.drift_pct:+.2f}%/yr, dispersion {nat.fit.scale:.2f}; reconciliation x{fac.mean():.3f}  {time.time() - t0:.1f}s")

    rows = []
    for sex, band in NAT_SERIES:
        rows += _rows("NATIONAL", "RW", sex, band, h, nat.history(sex, band), nat.series(sex, band), run_id)
    for p, g in provs.items():
        rows += _rows("PROVINCE", p, "ALL", "ALL", h, g.history(), g.series(), run_id)
    eb = eb_district_factors(h)
    dfc = _districts(h, provs, eb, rng, n)
    for d, (fc, _) in dfc.items():
        rows += _rows("DISTRICT", d, "ALL", "ALL", h, _district_hist(h, d), fc, run_id)
    series = pd.DataFrame(rows)
    series["period"] = pd.to_datetime(series["period"])
    log(f"  series: {series['series_id'].nunique()} ({len(series):,} rows)  {time.time() - t0:.1f}s")

    # ---- drivers (Das Gupta) from the fitted base year to the horizon
    y1 = min(int(c["drivers"]["from_year"]), h.last_full)
    y2 = min(int(c["drivers"]["to_year"]), horizon)
    drv = []
    fc_to = series[(series["kind"] == "forecast") & (series["metric"] == "cases") & (series["period"].dt.year == y2)
                   & (series["sex"] == "ALL") & (series["age_band"] == "ALL")].set_index("geo_code")["mean"].to_dict()
    p1, r1, p2, r2, _ = _geo_driver_arrays(nat, y1, y2)
    drv += _driver_rows("NATIONAL", "RW", p1, r1, p2, r2, y1, y2, fc_to.get("RW"))
    prov_arr = {}
    for p, g in provs.items():
        prov_arr[p] = _geo_driver_arrays(g, y1, y2)
        p1, r1, p2, r2, _ = prov_arr[p]
        drv += _driver_rows("PROVINCE", p, p1, r1, p2, r2, y1, y2, fc_to.get(p))
    ebi = eb.set_index("district_code")
    for d in dfc:
        p = PROVINCE_OF[d]
        _, r1, _, r2, keys = prov_arr[p]
        dp = h.pop[h.pop["district_code"] == d].groupby(["year", "sex", "age_index"])["population"].sum()
        pop1 = np.array([dp.get((y1, s, a), 0.0) for s, a in keys])
        pop2 = np.array([dp.get((y2, s, a), 0.0) for s, a in keys])
        sir = float(ebi.loc[d, "sir_eb"])
        drv += _driver_rows("DISTRICT", d, pop1, r1 * sir, pop2, r2 * sir, y1, y2, fc_to.get(d))
    drivers = pd.DataFrame(drv)

    # ---- risk factors (yearly survey trends)
    rf, rf_source, pts = RF.build(con, sim_time, h.last_full, int(c["risk_factors"]["horizon_year"]))
    log(f"  risk factors: {rf['indicator'].nunique() if len(rf) else 0} indicators from {rf_source}  {time.time() - t0:.1f}s")

    # ---- covariate model + scenario base
    coef, base = _scenario_tables(con, h, nat, pts, dfc, c, sim_time)
    log("  scenario coefficients: " + ", ".join(f"{r['term']}={r['value']:.3f} ({r['method']})" for r in coef.to_dict("records")
                                                if r["value"] is not None))

    # ---- backtests
    bt = BT.run(h, c, np.random.default_rng(int(c["seed"]) + 1), log) if backtests else pd.DataFrame()
    bts = BT.summary(bt)
    log(f"  backtest: {bts}  {time.time() - t0:.1f}s")

    runtime = time.time() - t0
    meta = {"run_id": run_id, "sim_time": sim_time, "created_at": dt.datetime.now(), "source": h.source, "source_label": h.label,
            "case_def": h.case_def, "first_year": h.first_year, "last_full_year": h.last_full, "horizon_year": horizon,
            "n_draws": n, "runtime_s": runtime, "notes": json.dumps(h.notes + [f"risk factors: {rf_source}"]),
            "apc": json.dumps({"NATIONAL": {"drift_pct": nat.fit.drift_pct, "dispersion": nat.fit.scale, "n": nat.fit.n_obs},
                               **{p: {"drift_pct": g.fit.drift_pct, "dispersion": g.fit.scale} for p, g in provs.items()}}),
            "backtest": json.dumps(bts), "reconciliation": json.dumps([float(x) for x in fac])}
    persist(con, run_id, series, drivers, rf, bt, coef, base, eb, meta)
    log(f"  forecast persisted ({run_id}) in {runtime:.1f}s")
    return {"run_id": run_id, "runtime_s": round(runtime, 1), "source": h.source, "backtest": bts,
            "national_2031": _nat_point(series, h.case_def, horizon)}


def _nat_point(series: pd.DataFrame, case_def: str, year: int) -> dict:
    s = series[(series["series_id"] == f"NATIONAL|ALL|ALL|{case_def}") & (series["metric"] == "cases")
               & (series["period"].dt.year == year)]
    return s[["mean", "lo80", "hi80", "lo95", "hi95"]].iloc[0].round(1).to_dict() if len(s) else {}


def _scenario_tables(con, h: History, nat: GeoFit, pts: pd.DataFrame, dfc: dict, c: dict, sim_time):
    sc = c["scenario"]
    lag = int(sc["lag_years"])
    access_of = _access(con)
    years_h = sorted(h.cells["year"].unique())
    # prevalence trends per province (sex ALL), any year
    prev = {}
    for term, ind in SC.INDICATOR.items():
        p = pts[(pts["indicator"] == ind) & (pts["sex"] == "ALL")] if len(pts) else pts
        for geo in list(PROVINCES) + ["RW"]:
            g = p[p["geo_code"] == geo] if len(p) else p
            if len(g) == 0:
                continue
            t = RF.trend(g, list(range(min(years_h) - lag, h.sim_year + 1)))
            if t is None:
                t = pd.DataFrame({"year": list(range(min(years_h) - lag, h.sim_year + 1)), "value": float(g["value"].mean())})
            prev[(term, geo)] = dict(zip(t["year"].astype(int), t["value"].astype(float)))

    def pv(term, d, y):
        for geo in (PROVINCE_OF[d], "RW"):
            if (term, geo) in prev:
                return prev[(term, geo)].get(int(y))
        return None

    # expected cases from national year x sex x age rates (indirect standardisation)
    nr = h.cells.groupby(["year", "sex", "age_index"], as_index=False)[["cases", "population"]].sum()
    nr["rate"] = np.where(nr["population"] > 0, nr["cases"] / nr["population"].clip(lower=1e-12), 0)
    d = h.cells.merge(nr[["year", "sex", "age_index", "rate"]], on=["year", "sex", "age_index"])
    d["E"] = d["rate"] * d["population"]
    dy = d.groupby(["district_code", "year"], as_index=False).agg(cases=("cases", "sum"), E=("E", "sum"))
    for term in SC.TERMS:
        dy[term] = [pv(term, a, y - lag) for a, y in zip(dy["district_code"], dy["year"])]
    dy["access"] = [access_of(a, y) for a, y in zip(dy["district_code"], dy["year"])]
    coef_rows = SC.fit_covariates(dy, c)
    coef_rows.append(SC.fit_stage_access(h.stage, access_of, c))
    coef = pd.DataFrame(coef_rows)
    # base: district baseline forecasts + current covariates
    st = h.stage[h.stage["year"] > h.last_full - 5] if len(h.stage) else h.stage
    early_nat = float(np.average(st["early_share"].dropna(), weights=st.loc[st["early_share"].notna(), "cases"])) \
        if len(st) and st["early_share"].notna().any() and st.loc[st["early_share"].notna(), "cases"].sum() > 0 else 0.3
    early = {}
    for dc, g in (st.groupby("district_code") if len(st) else []):
        g = g.dropna(subset=["early_share"])
        early[dc] = float(np.average(g["early_share"], weights=g["cases"])) if len(g) and g["cases"].sum() > 0 else early_nat
    rows = []
    for dc, (fc, _) in dfc.items():
        q = quantiles(fc.cases_draws)
        for j, y in enumerate(fc.years):
            rows.append({"district_code": dc, "year": int(y), "mean": float(fc.cases_mean[j]), "lo95": float(q[0, j]), "hi95": float(q[3, j]),
                         "hp": pv("hp", dc, h.sim_year) or 0.0, "smoking": pv("smoking", dc, h.sim_year) or 0.0,
                         "salt": pv("salt", dc, h.sim_year) or 0.0, "early_share": early.get(dc, early_nat),
                         "has_access": access_of(dc, h.sim_year), "sim_year": h.sim_year})
    return coef, pd.DataFrame(rows)


def _replace(con, name: str, df: pd.DataFrame):
    con.register("_fc_df", df)
    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM _fc_df")
    con.unregister("_fc_df")


def persist(con, run_id, series, drivers, rf, bt, coef, base, eb, meta):
    _replace(con, "ml_forecast_series", series)
    _replace(con, "ml_forecast_drivers", drivers)
    if len(rf):
        _replace(con, "ml_forecast_risk_factors", rf)
    if bt is not None and len(bt):
        _replace(con, "ml_forecast_backtest", bt)
    _replace(con, "ml_forecast_coef", coef)
    _replace(con, "ml_forecast_scenario_base", base)
    _replace(con, "ml_forecast_district_eb", eb)
    m = pd.DataFrame([meta])
    con.register("_fc_meta", m)
    con.execute("CREATE TABLE IF NOT EXISTS ml_forecast_runs AS SELECT * FROM _fc_meta WHERE FALSE")
    con.execute("INSERT INTO ml_forecast_runs BY NAME SELECT * FROM _fc_meta")
    con.unregister("_fc_meta")
    # forecast history for mart_forecast_tracking (national + province cases)
    hist = series[(series["kind"] == "forecast") & (series["metric"] == "cases") & series["geo_level"].isin(["NATIONAL", "PROVINCE"])
                  & (series["age_band"] == "ALL")][["series_id", "period", "mean", "lo80", "hi80", "lo95", "hi95"]].copy()
    hist["forecast_run_id"] = run_id
    hist["sim_time"] = meta["sim_time"]
    con.register("_fc_hist", hist)
    con.execute("CREATE TABLE IF NOT EXISTS ml_forecast_hist AS SELECT * FROM _fc_hist WHERE FALSE")
    con.execute("DELETE FROM ml_forecast_hist WHERE forecast_run_id = ?", [run_id])
    con.execute("INSERT INTO ml_forecast_hist BY NAME SELECT * FROM _fc_hist")
    con.unregister("_fc_hist")


def main(log=print) -> dict:
    from pipeline.db import work_connection
    from pipeline.marts.forecast import build_forecast
    from pipeline.run import sim_time_of
    con = work_connection()
    try:
        try:   # external synthetic sources (L1, data/external) are normally loaded by the pipeline refs step
            from pipeline.refs import load_external
            loaded = load_external(con)
            if loaded:
                log(f"  loaded {', '.join(loaded)}")
        except Exception as e:  # noqa: BLE001
            log(f"  external sources not loaded: {e.__class__.__name__}: {e}")
        st = sim_time_of(con)
        out = run(con, st, log)
        build_forecast(con, st, log)
    finally:
        con.close()
    log(json.dumps(out, default=str, indent=1))
    return out
