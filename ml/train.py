"""`python -m ml.train` — trains Tier 1/2/3, evaluates on the temporal test set, writes ml_* tables (SPEC §13)."""
from __future__ import annotations

import datetime as dt
import json
import time

import numpy as np
import pandas as pd

from shared.config import models_cfg
from shared.geo import DISTRICT_CODES

from . import evaluate as E
from . import registry, tier1_score, tier2_xgb
from .features import build_feature_table, design_matrix, prepare_sources
from .labels import build_landmarks

VERSION = dt.datetime.now().strftime("%Y%m%d%H%M")


def district_prior(con, end_year: int = 2022):
    """District ASR from the training period only (no test-period leakage)."""
    from pipeline.metrics.asr import asr
    rows = []
    for d in DISTRICT_CODES:
        c = np.zeros(18)
        n = np.zeros(18)
        for a, k in con.execute(f"""SELECT least(age_at_dx // 5, 17), count(*) FROM core_gc_case WHERE district_code = '{d}'
                                    AND year(dx_date) BETWEEN 2015 AND {end_year} GROUP BY 1""").fetchall():
            c[int(a)] = k
        for a, pop in con.execute(f"""SELECT age_index, sum(population) FROM core_ref_population WHERE district_code = '{d}'
                                      AND year BETWEEN 2015 AND {end_year} GROUP BY 1""").fetchall():
            n[int(a)] = pop
        rows.append({"district_code": d, "asr": asr(c, n)["asr"]})
    con.register("_dp", pd.DataFrame(rows))
    con.execute("CREATE OR REPLACE TABLE ml_district_prior AS SELECT * FROM _dp")
    con.unregister("_dp")


def facility_tiers(con):
    try:
        con.execute("CREATE OR REPLACE TABLE ml_facility_tier AS SELECT location_id, derived_tier FROM mart_facility_quality WHERE derived_tier IS NOT NULL")
    except Exception:
        con.execute("CREATE OR REPLACE TABLE ml_facility_tier AS SELECT location_id, hp_testing_tier AS derived_tier FROM core_dim_location")


def run(log=print) -> dict:
    from pipeline.db import work_connection
    cfg = models_cfg()
    t0 = time.time()
    con = work_connection()
    district_prior(con)
    facility_tiers(con)
    prepare_sources(con)
    lm = build_landmarks(con)
    log(f"  landmarks: {len(lm):,} ({int(lm['label'].sum()):,} positive) by split {lm.groupby('split')['label'].agg(['size', 'sum']).to_dict()}")
    lm["L"] = pd.to_datetime(lm["L"]).astype("datetime64[ns]")
    feats = build_feature_table(con, lm, "ml_train_features")
    df = lm.merge(feats, on=["patient_id", "L"], how="inner")
    X = design_matrix(df)
    y = df["label"].astype(int).values
    tr, va, te = (df["split"] == s for s in ("train", "val", "test"))
    log(f"  features: {X.shape[1]} columns, {time.time() - t0:.0f}s")

    # ---------------- Tier 1
    df["t1_score"] = tier1_score.points(df)
    t1_id = f"tier1-points-{VERSION}"
    # ---------------- Tier 2
    clf, iso = tier2_xgb.train(X[tr.values], y[tr.values], X[va.values], y[va.values])
    df["t2_prob"] = tier2_xgb.predict(clf, iso, X)
    t2_id = f"tier2-xgb-{VERSION}"
    tier2_xgb.save(clf, iso, registry.model_dir(t2_id), {"features": list(X.columns), "best_iteration": clf.best_iteration})
    log(f"  tier2 trained (best_iteration={clf.best_iteration}) {time.time() - t0:.0f}s")
    # ---------------- Tier 3
    t3_id = None
    if cfg["tier3"].get("enabled", True):
        try:
            t3_id = f"tier3-{cfg['tier3']['arch']}-{VERSION}"
            df["t3_prob"] = _train_tier3(con, df, X, tr, va, cfg["tier3"], t3_id, log)
        except Exception as e:  # spec §13.9: ensemble falls back to Tier 2 when Tier 3 is unavailable
            log(f"  tier3 unavailable: {e.__class__.__name__}: {e}")
            t3_id = None
    df["ensemble_prob"] = df[["t2_prob", "t3_prob"]].mean(axis=1) if t3_id else df["t2_prob"]

    # ---------------- capacity thresholds frozen on the validation landmarks (SPEC §13.9)
    v = df.loc[va, "ensemble_prob"].values
    hi_cut = float(np.quantile(v, 1 - cfg["bands"]["high_top_pct"] / 100))
    med_cut = float(np.quantile(v, 1 - (cfg["bands"]["high_top_pct"] + cfg["bands"]["medium_next_pct"]) / 100))
    v2 = df.loc[va, "t2_prob"].values
    t2_hi = float(np.quantile(v2, 1 - cfg["bands"]["high_top_pct"] / 100))

    # ---------------- evaluation on the temporal test set
    test = df[te].copy()
    rows, curves, subgroups = [], [], []
    for mid, col, thr, tier in ((t1_id, "t1_score", 9, 1), (t2_id, "t2_prob", t2_hi, 2),
                                (t3_id, "t3_prob", None, 3), ("ensemble", "ensemble_prob", hi_cut, 0)):
        if mid is None:
            continue
        if thr is None:
            thr = float(np.quantile(df.loc[va, col].values, 1 - cfg["bands"]["high_top_pct"] / 100))
        for split, part in (("val", df[va]), ("test", test)):
            m = E.metrics(part["label"].values, part[col].values)
            lt = E.lead_time(part, col, thr, mid)[0] if split == "test" else {}
            rows.append({"model_id": mid, "tier": tier, "split": split, **m, **lt, "high_threshold": thr})
        curves += E.curves(mid, test["label"].values, test[col].values)
        curves += E.lead_time(test, col, thr, mid)[1]
        subgroups += E.subgroups(mid, test, col, thr)
    # feature importance (mean |SHAP| on a test sample)
    samp = X[te.values].sample(min(5000, int(te.sum())), random_state=1)
    sv = tier2_xgb.shap_values(clf, samp)
    imp = pd.DataFrame({"feature": samp.columns, "mean_abs_shap": np.abs(sv).mean(axis=0)}).sort_values("mean_abs_shap", ascending=False)
    imp["rank"] = np.arange(1, len(imp) + 1)
    imp["model_id"] = t2_id
    hiv_rank = int(imp.loc[imp["feature"] == "hiv", "rank"].iloc[0])

    # ---------------- persist
    params = {"tier1": cfg["tier1"], "tier2": cfg["tier2"], "tier3": cfg["tier3"], "bands": cfg["bands"],
              "high_cut": hi_cut, "medium_cut": med_cut}
    registry.register(con, t1_id, 1, VERSION, params, list(X.columns), "2016Q1-2023Q2")
    registry.register(con, t2_id, 2, VERSION, params, list(X.columns), "2016Q1-2023Q2")
    if t3_id:
        registry.register(con, t3_id, 3, VERSION, params, list(X.columns), "2016Q1-2023Q2")
    for name, frame in (("ml_eval_metrics", pd.DataFrame(rows)), ("ml_eval_curves", pd.DataFrame(curves)),
                        ("ml_feature_importance", imp[["model_id", "feature", "mean_abs_shap", "rank"]]),
                        ("ml_subgroup_metrics", pd.DataFrame(subgroups))):
        con.register("_f", frame)
        con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM _f")
        con.unregister("_f")
    con.execute("CREATE OR REPLACE TABLE ml_thresholds AS SELECT ? AS high_cut, ? AS medium_cut, ? AS version, ? AS hiv_shap_rank",
                [hi_cut, med_cut, VERSION, hiv_rank])
    con.close()
    summary = {r["model_id"]: {k: (round(r[k], 3) if isinstance(r[k], float) else r[k])
                               for k in ("auroc", "auprc", "brier", "sens_at_spec90", "nns_at_top2pct", "median_lead_time_days",
                                         "pct_flagged_ge_90d") if k in r} for r in rows if r["split"] == "test"}
    log(json.dumps(summary, indent=1))
    log(f"  HIV SHAP rank: {hiv_rank}  thresholds high={hi_cut:.4f} medium={med_cut:.4f}  total {time.time() - t0:.0f}s")
    return summary


def _train_tier3(con, df, X, tr, va, tcfg, model_id, log) -> np.ndarray:
    from .tier3_seq import dataset as D
    from .tier3_seq import train as T3
    from .tier3_seq.tokenizer import Tokenizer
    max_len = int(tcfg.get("max_len", 128))
    lookback = int(models_cfg()["task"]["lookback_months"] * 30.44)
    df = df.reset_index(drop=True).copy()
    df["row_id"] = np.arange(len(df))
    ev = D.fetch_events(con, df, lookback, max_len)
    normal = {int(c): (lo, hi) for c, lo, hi in con.execute(
        "SELECT concept_id, low_normal, hi_normal FROM core_dim_concept WHERE low_normal IS NOT NULL OR hi_normal IS NOT NULL").fetchall()}
    tr_rows = set(df.index[tr.values])
    tok = Tokenizer().fit(ev[ev["row_id"].isin(tr_rows)], normal)
    ids, days, age = D.tensors(ev, len(df), tok, max_len)
    S, smean, sstd = D.static_matrix(X.reset_index(drop=True))
    y = df["label"].astype(int).values
    rng = np.random.default_rng(3)
    tr_idx = np.where(tr.values)[0]
    pos, neg = tr_idx[y[tr_idx] == 1], tr_idx[y[tr_idx] == 0]
    k = int(tcfg.get("neg_downsample", 20))
    neg = rng.choice(neg, size=min(len(neg), k * len(pos)), replace=False)
    sel = np.concatenate([pos, neg])
    va_idx = np.where(va.values)[0]
    pick = lambda ix: {"ids": ids[ix], "days": days[ix], "age": age[ix], "static": S[ix], "y": y[ix]}  # noqa: E731
    log(f"  tier3: vocab={len(tok.vocab)} train_seqs={len(sel):,} (pos {len(pos):,}) val={len(va_idx):,} max_len={max_len}")
    p, Tm, iso, hist = T3.fit(pick(sel), pick(va_idx), len(tok.vocab), tcfg, log)
    z = T3.predict_logits(p, tcfg, ids, days, age, S)
    path = registry.model_dir(model_id)
    T3.save(path, p, Tm, iso, tcfg, smean, sstd, hist)
    tok.save(path / "tokenizer.json")
    return T3.calibrated(z, Tm, iso)


if __name__ == "__main__":
    run()
