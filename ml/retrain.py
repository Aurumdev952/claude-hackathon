"""Learning loop: train a Tier 2 challenger on feedback labels, gate it against the champion, register it inactive.

`python -m ml.retrain` (`make retrain`), `POST /models/retrain`, or `maybe_retrain(sim_time)` from the sim clock every
30 sim days (docs/contracts/v3-loop.md §5, §7). Steps:
1. rebuild landmarks to the current sim time (training landmarks up to sim time - 365 d, so every label window is
   complete; the temporal test landmarks and test-split patients are exactly the champion's untouched holdout);
2. add the loop features (prior_negative_endoscopy_months, care_plan_open, missed_followups_12m; hp_eradicated is
   already a v1 feature). They are appended to the design matrix, so older models keep scoring unchanged;
3. feedback labels: ml_feedback_labels (care outcomes, flags followed by endoscopy) plus champion "virtual flags" on
   past quarterly landmarks (stored in ml_feedback_backfill). Selective labels are corrected with stabilised
   inverse-propensity weights w = P(verified) / P(verified | x), clipped to [0.1, 10] (`ipw_weight`, ml/feedback.py;
   P(verified | x) comes from a propensity model, never from the risk score); test-split patients' feedback rows form
   the "verified" slice;
4. train XGBoost with those sample weights (same hyper-parameters as v1), isotonic calibration on validation;
5. evaluate champion and challenger on the same holdout + verified slice; gates: no metric worse than
   champion - 0.01 (AUROC, AUPRC, Brier, calibration slope distance from 1, PPV at HIGH), largest subgroup AUROC drop
   <= 0.05 (sex, age band, province), HIGH volume change within +/-25% (or small in absolute terms) on the currently
   scored population. HIGH is decided on the quantity production bands use (score.py): the Tier 2 + Tier 3 ensemble
   when a Tier 3 model is active, else Tier 2. The challenger's high/medium cuts are frozen on that quantity on the
   validation landmarks, as in ml/train.py;
6. register the challenger (status='challenger', is_active=false, parent_model_id, n_feedback_labels), write its
   evaluation rows and ml_retrain_runs; retrain the adherence model. A person promotes it (POST /models/{id}/promote).
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

from shared.config import load_yaml, models_cfg

from . import evaluate as E
from . import registry, tier2_xgb
from .feedback import LOOP_FEATURES, add_loop_features, build_feedback_labels, propensity_model, stabilised_weight
from .features import build_feature_table, design_matrix, prepare_sources
from .labels import patient_split

RUNS_DDL = """CREATE TABLE IF NOT EXISTS ml_retrain_runs (run_id VARCHAR, sim_time TIMESTAMP, champion_id VARCHAR, challenger_id VARCHAR,
              metrics JSON, gates JSON, decision VARCHAR, decided_by VARCHAR, decided_at TIMESTAMP, n_feedback_labels INTEGER,
              train_window VARCHAR, runtime_s DOUBLE, started_at TIMESTAMP)"""


def loop_cfg() -> dict:
    return load_yaml("forecast.yaml")


# ----------------------------------------------------------------------------------------------- landmarks
def landmarks_to(con, sim_time: dt.datetime) -> pd.DataFrame:
    """v1 landmark builder with the training window extended to the current sim time (complete label windows)."""
    from . import labels as L
    cfg = copy.deepcopy(models_cfg())
    end = (pd.Timestamp(sim_time) - pd.Timedelta(days=int(cfg["task"]["window_end_days"]))).date()
    cfg["splits"]["train_landmarks"]["end"] = str(max(end, pd.Timestamp(str(cfg["splits"]["train_landmarks"]["end"])).date()))
    orig = L.models_cfg
    L.models_cfg = lambda: cfg
    try:
        lm = L.build_landmarks(con)
    finally:
        L.models_cfg = orig
    lm["L"] = pd.to_datetime(lm["L"]).astype("datetime64[ns]")
    return lm, cfg["splits"]["train_landmarks"]["end"]


def eligible_at(con, dates: list) -> pd.DataFrame:
    """Every eligible GI-cohort patient at each landmark date (no negative sampling): for the champion backfill."""
    con.register("_bf_dates", pd.DataFrame({"L": pd.to_datetime(dates)}))
    try:
        df = con.execute("""
            SELECT g.patient_id, CAST(d.L AS DATE) AS L, c.dx_date
            FROM core_gi_cohort g CROSS JOIN _bf_dates d JOIN core_dim_patient p USING (patient_id)
            LEFT JOIN core_gc_case c USING (patient_id)
            WHERE g.entry_date <= CAST(d.L AS DATE) AND date_diff('year', p.birthdate, CAST(d.L AS DATE)) >= 18
              AND (p.death_date IS NULL OR p.death_date > CAST(d.L AS DATE)) AND (c.dx_date IS NULL OR c.dx_date > CAST(d.L AS DATE))
              AND g.patient_id NOT IN (SELECT patient_id FROM core_gc_prevalent)
            ORDER BY g.patient_id, L""").df()   # deterministic row order: it feeds the challenger's training rows
    finally:
        con.unregister("_bf_dates")
    df["L"] = pd.to_datetime(df["L"]).astype("datetime64[ns]")
    return df


def design(con, frame: pd.DataFrame, out: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    feats = build_feature_table(con, frame[["patient_id", "L"]], out)
    df = frame.merge(feats, on=["patient_id", "L"], how="inner")
    X = add_loop_features(con, df, design_matrix(df))
    return df, X


# ----------------------------------------------------------------------------------------------- feedback
def backfill(con, sim_time: dt.datetime, champion: dict, lc: dict, log=print) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Champion virtual flags on quarterly landmarks after its training window; verified by a later endoscopy."""
    fu = int(lc["backfill_landmarks"]["followup_days"])
    start = pd.Timestamp(str(models_cfg()["splits"]["train_landmarks"]["end"])) + pd.offsets.QuarterEnd(1)
    end = pd.Timestamp(sim_time) - pd.Timedelta(days=30)
    dates = list(pd.date_range(start, end, freq="QE"))
    if not dates:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
    base = eligible_at(con, dates)
    df, X = design(con, base, "ml_retrain_bf_features")
    clf, iso, meta = tier2_xgb.load(Path(champion["path"]))
    df["risk"] = tier2_xgb.predict(clf, iso, X[meta["features"]])
    endo = con.execute("SELECT patient_id, CAST(encounter_datetime AS DATE) AS t FROM core_fact_encounter WHERE encounter_type = 5").df()
    endo["t"] = pd.to_datetime(endo["t"])
    m = df[["patient_id", "L"]].reset_index().merge(endo, on="patient_id")
    m = m[(m["t"] > m["L"]) & (m["t"] <= m["L"] + pd.Timedelta(days=fu))].groupby("index")["t"].min()
    df["endo_t"] = m.reindex(df.index)
    T = pd.Timestamp(sim_time)
    complete = df["L"] + pd.Timedelta(days=fu) <= T
    prop = propensity_model(df[complete].assign(scoped=df.loc[complete, "endo_t"].notna()))
    marginal = float(df.loc[complete, "endo_t"].notna().mean()) if complete.any() else None
    hc = float(champion["params"].get("high_cut", np.quantile(df["risk"], 0.98)))
    flagged = df[df["risk"] >= hc].copy()
    flagged["propensity"] = prop(flagged["risk"].values)
    dx = pd.to_datetime(flagged["dx_date"])
    et = pd.to_datetime(flagged["endo_t"])
    pos = flagged["endo_t"].notna() & dx.notna() & (dx > flagged["L"]) & (dx <= et + pd.Timedelta(days=60))
    neg = flagged["endo_t"].notna() & ~pos & (et + pd.Timedelta(days=60) <= T)
    v = flagged[pos | neg].copy()
    v["label"] = pos[pos | neg].astype(int).values
    out = pd.DataFrame({"patient_id": v["patient_id"].astype("int64"), "landmark_date": v["L"].dt.date, "label": v["label"],
                        "label_kind": "cancer", "source": "flag_backfill", "verified": True, "propensity": v["propensity"],
                        "risk_at_landmark": v["risk"], "outcome_date": np.where(v["label"] == 1, dx[v.index].dt.date, et[v.index].dt.date),
                        "model_id": champion["model_id"], "plan_id": None,
                        "ipw_weight": stabilised_weight(v["propensity"].values, marginal)})
    log(f"  backfill: {len(dates)} quarterly landmarks, {len(df):,} patient-landmarks, {len(flagged):,} virtual flags, "
        f"{len(out):,} verified ({int(out['label'].sum()) if len(out) else 0} cancers); scoped share "
        f"{df.loc[complete, 'endo_t'].notna().mean():.3f}")
    return out, df, X


# ----------------------------------------------------------------------------------------------- training + gates
def train_weighted(Xtr: pd.DataFrame, ytr, wtr, Xva: pd.DataFrame, yva, seed: int = 42):
    import xgboost as xgb
    from .calibration import fit_calibrator
    p = models_cfg()["tier2"]["params"]
    spw = float((len(ytr) - ytr.sum()) / max(1, ytr.sum()))
    clf = xgb.XGBClassifier(objective="binary:logistic", n_estimators=p["n_estimators"], max_depth=p["max_depth"],
                            learning_rate=p["learning_rate"], subsample=p["subsample"], colsample_bytree=p["colsample_bytree"],
                            min_child_weight=p["min_child_weight"], scale_pos_weight=spw, eval_metric="aucpr",
                            early_stopping_rounds=p["early_stopping_rounds"], tree_method="hist", random_state=seed,
                            n_jobs=os.cpu_count(), device=os.environ.get("XGB_DEVICE", "cpu"))
    clf.fit(Xtr, ytr, sample_weight=wtr, eval_set=[(Xva, yva)], verbose=False)
    clf.set_params(device="cpu")  # same as the champion: CPU-only saved model (D-35)
    iso = fit_calibrator(clf.predict_proba(Xva)[:, 1], yva)  # same calibrator as the champion (D-58)
    return clf, iso


def calib_slope(y, p) -> float | None:
    from .monitoring import calibration_slope
    return calibration_slope(np.asarray(y), np.asarray(p))


def model_metrics(y, p, hi_cut: float, p_band=None) -> dict:
    """Discrimination and calibration of `p`; PPV and count at HIGH on `p_band` (the production ensemble; default p)."""
    m = E.metrics(y, p)
    flagged = np.asarray(p if p_band is None else p_band) >= hi_cut
    y = np.asarray(y).astype(int)
    m["calib_slope"] = calib_slope(y, p)
    m["ppv_at_high"] = float(y[flagged].mean()) if flagged.any() else None
    m["n_high"] = int(flagged.sum())
    m["high_cut"] = float(hi_cut)
    return m


def subgroup_aurocs(df: pd.DataFrame, y: np.ndarray, p_ch: np.ndarray, p_ca: np.ndarray, min_pos: int = 3) -> list[dict]:
    from sklearn.metrics import roc_auc_score
    groups = {"sex": df["sex_male"].map({1: "M", 0: "F"}).astype(str).values,
              "age_band": pd.cut(df["age"], [0, 50, 65, 200], right=False, labels=["<50", "50-64", "65+"]).astype(str).values,
              "province": df["province_code"].fillna("unknown").astype(str).values}
    out = []
    for var, vals in groups.items():
        for v in sorted(set(vals)):
            m = vals == v
            yy = y[m]
            if yy.sum() >= min_pos and yy.sum() < len(yy):
                a_ca, a_ch = float(roc_auc_score(yy, p_ca[m])), float(roc_auc_score(yy, p_ch[m]))
                out.append({"var": var, "value": v, "n": int(m.sum()), "n_pos": int(yy.sum()), "champion": a_ca, "challenger": a_ch,
                            "drop": a_ca - a_ch})
    return out


def gates(champ: dict, chall: dict, subgroups: list[dict], volume: dict, gc: dict) -> list[dict]:
    tol = float(gc["tolerance"])
    out = []

    def add(name, value, threshold, ok, ca=None, ch=None, note=""):
        out.append({"name": name, "value": value, "threshold": threshold, "pass": bool(ok), "champion": ca, "challenger": ch, "note": note})

    for k in ("auroc", "auprc", "ppv_at_high"):
        ca, ch = champ.get(k), chall.get(k)
        ok = ca is None or (ch is not None and ch >= ca - tol)
        add(k, None if ca is None or ch is None else ch - ca, -tol, ok, ca, ch, "challenger - champion >= -0.01")
    ca, ch = champ.get("brier"), chall.get("brier")
    add("brier", None if ca is None or ch is None else ch - ca, tol, ca is None or (ch is not None and ch <= ca + tol), ca, ch,
        "challenger - champion <= +0.01 (lower is better)")
    ca, ch = champ.get("calib_slope"), chall.get("calib_slope")
    if ca is None or ch is None:
        add("calibration_slope", None, tol, ca is None, ca, ch, "not estimable on this holdout")
    else:
        d = abs(ch - 1) - abs(ca - 1)
        add("calibration_slope", d, tol, d <= tol, ca, ch, "|slope - 1| may not grow by more than 0.01")
    drop = max([s["drop"] for s in subgroups], default=0.0)
    add("subgroup_auroc_drop", drop, float(gc["subgroup_auroc_drop_max"]), drop <= float(gc["subgroup_auroc_drop_max"]),
        note="largest AUROC drop vs champion across sex, age band and province")
    add("high_volume_change", volume["change"], float(gc["high_volume_change_max"]), volume_ok(volume, gc),
        volume["champion"], volume["challenger"], volume_note(volume, gc))
    return out


def volume_abs_max(volume: dict, gc: dict) -> float:
    """Absolute HIGH-count slack: max(10, 0.5% of the scored population) by default (config gates.high_volume_abs_*)."""
    return max(float(gc.get("high_volume_abs_min", 10)), float(gc.get("high_volume_abs_pct", 0.005)) * float(volume.get("population") or 0))


def volume_ok(volume: dict, gc: dict) -> bool:
    """HIGH volume gate: the relative change is within +/-25% OR the absolute change is small. A relative band alone is
    meaningless when the champion flags only a handful of patients (dev data: ~20 HIGH, so 6 extra flags would fail)."""
    if volume.get("champion") is None or volume.get("challenger") is None:
        return abs(float(volume.get("change") or 0.0)) <= float(gc["high_volume_change_max"])
    rel_ok = abs(float(volume["change"])) <= float(gc["high_volume_change_max"])
    return rel_ok or abs(int(volume["challenger"]) - int(volume["champion"])) <= volume_abs_max(volume, gc)


def volume_note(volume: dict, gc: dict) -> str:
    return (f"HIGH flags on the current population: relative change within +/-{float(gc['high_volume_change_max']):.0%} "
            f"or absolute change <= {volume_abs_max(volume, gc):.0f} patients")


def ensemble(t2, t3):
    from .score import ensemble as _e
    return _e(np.asarray(t2, float), None if t3 is None else np.asarray(t3, float))


def _tier3_landmarks(con, t3_model: dict | None, frame: pd.DataFrame, X: pd.DataFrame, log=print) -> np.ndarray | None:
    """Tier 3 probabilities for landmark rows, or None (no active Tier 3, or it cannot be run: Tier 2 alone, as in
    production's fallback)."""
    if not t3_model:
        return None
    try:
        from .score import tier3_probs
        return np.asarray(tier3_probs(con, t3_model, frame.reset_index(drop=True), X.reset_index(drop=True)), float)
    except Exception as e:  # noqa: BLE001
        log(f"  tier3 unavailable for the retrain ensemble ({e.__class__.__name__}: {e}); Tier 2 only")
        return None


def _current_tier3(con, cf: pd.DataFrame) -> np.ndarray | None:
    """t3_prob of the current scoring run (pt_risk), aligned to the rows of pt_features."""
    try:
        r = con.execute("SELECT patient_id, t3_prob FROM pt_risk").df()
    except Exception:  # noqa: BLE001
        return None
    v = cf[["patient_id"]].merge(r, on="patient_id", how="left")["t3_prob"].astype(float).values
    return v if np.isfinite(v).any() else None


def high_volume(pc_ca, pc_ch, pc3, champion_cut: float, challenger_cut: float) -> dict:
    """HIGH counts on the current population, each model on its own cut, on the production quantity (the ensemble
    with Tier 3 when `pc3` is given, as ml/score.py bands patients)."""
    n_ca = int((ensemble(pc_ca, pc3) >= champion_cut).sum())
    n_ch = int((ensemble(pc_ch, pc3) >= challenger_cut).sum())
    return {"champion": n_ca, "challenger": n_ch, "change": (n_ch - n_ca) / max(n_ca, 1), "population": int(len(pc_ca))}


def _current_population(con) -> tuple[pd.DataFrame, pd.DataFrame] | None:
    if not con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = 'pt_features'").fetchone()[0]:
        return None
    feats = con.execute("SELECT * FROM pt_features").df()
    feats["L"] = pd.to_datetime(feats["as_of"] if "as_of" in feats else feats["L"]).astype("datetime64[ns]")
    return feats, add_loop_features(con, feats, design_matrix(feats))


def _write_eval(con, model_id: str, rows: list[dict], curves: list[dict], subgroups: list[dict], imp: pd.DataFrame):
    for name, frame in (("ml_eval_metrics", pd.DataFrame(rows)), ("ml_eval_curves", pd.DataFrame(curves)),
                        ("ml_subgroup_metrics", pd.DataFrame(subgroups)), ("ml_feature_importance", imp)):
        if frame.empty:
            continue
        have = con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]).fetchone()[0]
        con.register("_ev", frame)
        if not have:
            con.execute(f"CREATE TABLE {name} AS SELECT * FROM _ev")
        else:
            cols = [c for c in con.execute(f"SELECT * FROM {name} LIMIT 0").df().columns if c in frame.columns]
            con.execute(f"DELETE FROM {name} WHERE model_id = ?", [model_id])
            con.execute(f"INSERT INTO {name} ({', '.join(cols)}) SELECT {', '.join(cols)} FROM _ev")
        con.unregister("_ev")


# ----------------------------------------------------------------------------------------------- main
def run(con=None, sim_time: dt.datetime | None = None, log=print) -> dict:
    from pipeline.run import sim_time_of
    own = con is None
    if own:
        from pipeline.db import work_connection
        con = work_connection()
    t0 = time.time()
    started = dt.datetime.now()
    try:
        sim_time = sim_time or sim_time_of(con)
        lc = loop_cfg()["learning_loop"]
        registry.ensure_columns(con)
        con.execute(RUNS_DDL)
        champion = registry.active(con).get(2)
        if champion is None:
            raise RuntimeError("no active Tier 2 champion (run make train first)")
        version = dt.datetime.now().strftime("%Y%m%d%H%M%S")
        chall_id = f"tier2-xgb-ch-{version}"
        prepare_sources(con)
        lm, train_end = landmarks_to(con, sim_time)
        df, X = design(con, lm, "ml_retrain_features")
        log(f"  landmarks to {train_end}: {len(df):,} ({int(df['label'].sum())} positive), features {X.shape[1]}  {time.time() - t0:.0f}s")

        # ---- feedback labels: cheap sources (mart step) + champion backfill
        bf, _, Xbf_all = backfill(con, sim_time, champion, lc, log)
        if len(bf):
            con.register("_bf", bf)
            con.execute("CREATE OR REPLACE TABLE ml_feedback_backfill AS SELECT * FROM _bf")
            con.unregister("_bf")
        fb = build_feedback_labels(con, sim_time, log)
        fb = fb[(fb["label_kind"] == "cancer") & fb["verified"].astype(bool)].copy() if len(fb) else fb
        if len(fb):
            fb["L"] = pd.to_datetime(fb["landmark_date"]).astype("datetime64[ns]")
            # stabilised weights from ml/feedback.py; a row without one (no propensity) keeps weight 1
            fb["w"] = pd.to_numeric(fb.get("ipw_weight"), errors="coerce").fillna(1.0).astype(float) \
                if "ipw_weight" in fb else 1.0
            fb["split"] = [patient_split(int(x), models_cfg()["splits"]["val_patient_frac"]) for x in fb["patient_id"]]
            # stable, total order: which duplicate survives and the order of appended training rows must not depend on
            # the (thread-dependent) order DuckDB returned the feedback rows in
            fb = (fb.sort_values(["source", "patient_id", "L"], kind="mergesort").drop_duplicates(["patient_id", "L"])
                  .reset_index(drop=True))
        n_fb_train = int((fb["split"] == "train").sum()) if len(fb) else 0

        # ---- training set: base landmarks (w=1), verified feedback rows re-weighted by IPW / appended
        df["w"] = 1.0
        if len(fb):
            key = df[["patient_id", "L"]].reset_index().merge(fb[fb["split"] != "test"][["patient_id", "L", "w"]], on=["patient_id", "L"])
            df.loc[key["index"].values, "w"] = key["w"].values
            extra = fb[(fb["split"] == "train")].merge(df[["patient_id", "L"]], on=["patient_id", "L"], how="left", indicator=True)
            extra = extra[extra["_merge"] == "left_only"].drop(columns="_merge")
            if len(extra):
                edf, eX = design(con, extra[["patient_id", "L"]].assign(), "ml_retrain_fb_features")
                edf = edf.merge(extra[["patient_id", "L", "label", "w"]], on=["patient_id", "L"])
                edf["split"] = "train"
                edf["dx_date"] = None
                df = pd.concat([df, edf[df.columns.intersection(edf.columns)]], ignore_index=True)
                X = pd.concat([X, eX.reset_index(drop=True)], ignore_index=True)
                log(f"  appended {len(edf):,} feedback rows not in the landmark set")
        y = df["label"].astype(int).values
        tr, va, te = (df["split"] == s for s in ("train", "val", "test"))
        w = df["w"].values.astype(float)
        w_tr = w[tr.values] / w[tr.values].mean()
        from .feedback import IPW_CLIP
        ipw = {"n_feedback_train": n_fb_train, "n_weighted_rows": int((w[tr.values] != 1).sum()),
               "weight_min": float(w_tr.min()), "weight_max": float(w_tr.max()), "weight_mean": float(w[tr.values].mean()),
               "finite": bool(np.isfinite(w_tr).all()), "clip": list(IPW_CLIP), "kind": "stabilised"}
        log(f"  IPW: {ipw}")

        clf, iso = train_weighted(X[tr.values], y[tr.values], w_tr, X[va.values], y[va.values])
        feats_ch = list(X.columns)
        p_ch = tier2_xgb.predict(clf, iso, X)
        c_clf, c_iso, c_meta = tier2_xgb.load(Path(champion["path"]))
        p_ca = tier2_xgb.predict(c_clf, c_iso, X[c_meta["features"]])
        bands = models_cfg()["bands"]
        q_hi = 1 - bands["high_top_pct"] / 100
        q_med = 1 - (bands["high_top_pct"] + bands["medium_next_pct"]) / 100
        # bands are cut on what production scores (ml/score.py): the Tier 2 + Tier 3 ensemble when Tier 3 is active
        t3_model = registry.active(con).get(3)
        p3 = None
        ev_rows = (va | te).values   # Tier 3 only where the ensemble is needed (validation cuts, holdout metrics)
        sub3 = _tier3_landmarks(con, t3_model, df[ev_rows], X[ev_rows], log) if ev_rows.any() else None
        if sub3 is not None:
            p3 = np.full(len(df), np.nan)
            p3[ev_rows] = sub3
        e_ch, e_ca = ensemble(p_ch, p3), ensemble(p_ca, p3)
        ch_hi, ch_med = float(np.quantile(e_ch[va.values], q_hi)), float(np.quantile(e_ch[va.values], q_med))
        ca_hi = float(np.quantile(e_ca[va.values], q_hi))
        t2_hi = float(np.quantile(p_ch[va.values], q_hi))   # the Tier 2 model's own evaluation rows (as ml/train.py)
        log(f"  challenger trained (best_iteration={clf.best_iteration})  {time.time() - t0:.0f}s")

        # ---- evaluation on the untouched holdout + verified slice
        yt = y[te.values]
        m_ca = model_metrics(yt, p_ca[te.values], ca_hi, e_ca[te.values])
        m_ch = model_metrics(yt, p_ch[te.values], ch_hi, e_ch[te.values])
        sub = subgroup_aurocs(df[te], yt, p_ch[te.values], p_ca[te.values])
        verified = {"n": 0}
        if len(fb) and (fb["split"] == "test").any():
            vt = fb[fb["split"] == "test"]
            vdf, vX = design(con, vt[["patient_id", "L"]], "ml_retrain_verified_features")
            vdf = vdf.merge(vt[["patient_id", "L", "label"]].rename(columns={"label": "vlabel"}), on=["patient_id", "L"])
            vy = vdf["vlabel"].astype(int).values
            vp_ca = tier2_xgb.predict(c_clf, c_iso, vX[c_meta["features"]])
            vp_ch = tier2_xgb.predict(clf, iso, vX[feats_ch])
            vp3 = _tier3_landmarks(con, t3_model, vdf, vX, log)
            verified = {"n": int(len(vy)), "n_pos": int(vy.sum()),
                        "champion": model_metrics(vy, vp_ca, ca_hi, ensemble(vp_ca, vp3)) if 0 < vy.sum() < len(vy) else {"ppv": float(vy.mean()) if len(vy) else None},
                        "challenger": model_metrics(vy, vp_ch, ch_hi, ensemble(vp_ch, vp3)) if 0 < vy.sum() < len(vy) else {"ppv": float(vy.mean()) if len(vy) else None}}
        cur = _current_population(con)
        volume = {"champion": None, "challenger": None, "change": 0.0}
        if cur is not None:
            cf, cX = cur
            pc_ca = tier2_xgb.predict(c_clf, c_iso, cX[c_meta["features"]])
            pc_ch = tier2_xgb.predict(clf, iso, cX[feats_ch])
            pc3 = _current_tier3(con, cf) if t3_model else None   # Tier 3 of the current scoring run (pt_risk)
            volume = high_volume(pc_ca, pc_ch, pc3, float(champion["params"].get("high_cut", ca_hi)), ch_hi)
        g = gates(m_ca, m_ch, sub, volume, lc["gates"])
        decision = "pending" if all(x["pass"] for x in g) else "gates_failed"
        log("  gates: " + ", ".join(f"{x['name']}={'PASS' if x['pass'] else 'FAIL'}" for x in g) + f" -> {decision}")

        # ---- persist the challenger
        version_s = version[:12]
        params = {**champion["params"], "high_cut": ch_hi, "medium_cut": ch_med, "ipw": ipw, "loop_features": LOOP_FEATURES,
                  "retrain_sim_time": str(sim_time)}
        tier2_xgb.save(clf, iso, registry.model_dir(chall_id), {"features": feats_ch, "best_iteration": clf.best_iteration,
                                                                "parent_model_id": champion["model_id"]})
        window = f"2016Q1-{pd.Timestamp(train_end).year}Q{pd.Timestamp(train_end).quarter}"
        registry.register(con, chall_id, 2, version_s, params, feats_ch, window, active=False, status="challenger",
                          parent_model_id=champion["model_id"], n_feedback_labels=int(len(fb)))
        test = df[te].copy()
        test["p"] = p_ch[te.values]
        rows = []
        for split, part, pp in (("val", df[va], p_ch[va.values]), ("test", test, test["p"].values)):
            mm = E.metrics(part["label"].values, pp)
            lt = E.lead_time(part.assign(p=pp), "p", t2_hi, chall_id)[0] if split == "test" else {}
            rows.append({"model_id": chall_id, "tier": 2, "split": split, **mm, **lt, "high_threshold": t2_hi})
        curves = E.curves(chall_id, test["label"].values, test["p"].values) + E.lead_time(test, "p", t2_hi, chall_id)[1]
        sg = E.subgroups(chall_id, test, "p", t2_hi)
        samp = X[te.values].sample(min(3000, int(te.sum())), random_state=1)
        sv = tier2_xgb.shap_values(clf, samp)
        imp = pd.DataFrame({"feature": samp.columns, "mean_abs_shap": np.abs(sv).mean(axis=0)}).sort_values("mean_abs_shap", ascending=False)
        imp["rank"] = np.arange(1, len(imp) + 1)
        imp["model_id"] = chall_id
        _write_eval(con, chall_id, rows, curves, sg, imp[["model_id", "feature", "mean_abs_shap", "rank"]])

        try:
            from .adherence import train as train_adherence
            adh = train_adherence(con, log)
        except Exception as e:  # noqa: BLE001
            adh = {"status": "failed", "error": f"{e.__class__.__name__}: {e}"}
        runtime = time.time() - t0
        run_id = f"rt-{version}"
        metrics = {"champion": m_ca, "challenger": m_ch, "subgroups": sub, "verified_slice": verified, "volume": volume, "ipw": ipw,
                   "holdout": {"n": int(te.sum()), "n_pos": int(yt.sum())}, "adherence": adh,
                   "feedback": fb.groupby("source").size().to_dict() if len(fb) else {}}
        con.execute("INSERT INTO ml_retrain_runs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
                    [run_id, sim_time, champion["model_id"], chall_id, json.dumps(metrics, default=_js), json.dumps(g, default=_js),
                     decision, int(len(fb)), window, runtime, started])
        log(f"  registered {chall_id} ({decision}) in {runtime:.0f}s")
        return {"run_id": run_id, "champion_id": champion["model_id"], "challenger_id": chall_id, "decision": decision,
                "gates": g, "champion": _round(m_ca), "challenger": _round(m_ch), "volume": volume, "verified_slice": verified,
                "ipw": ipw, "n_feedback_labels": int(len(fb)), "runtime_s": round(runtime, 1)}
    finally:
        if own:
            con.close()


def _js(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (dt.date, dt.datetime, pd.Timestamp)):
        return str(o)
    return str(o)


def _round(m: dict) -> dict:
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}


# ----------------------------------------------------------------------------------------------- schedule
def _last_sim(con, table: str):
    try:
        return con.execute(f"SELECT max(sim_time) FROM {table}").fetchone()[0]
    except Exception:
        return None


def maybe_retrain(sim_time: dt.datetime, con=None, log=print, publish: bool | None = None, force: bool = False) -> dict | None:
    """Called by the sim clock (simulator/local.py) after each advance. Every `retrain_every_days` sim days it retrains
    the challenger (+ adherence model) and refits the forecasts. With `con` given (inside a pipeline run) the caller
    publishes; without it this function opens the work DB and republishes itself. Returns None when nothing was due."""
    every = int(loop_cfg()["learning_loop"]["retrain_every_days"])
    own = con is None
    if own:
        from pipeline.db import work_connection
        con = work_connection()
    out = {}
    try:
        last_rt, last_fc = _last_sim(con, "ml_retrain_runs"), _last_sim(con, "ml_forecast_runs")
        due = lambda last: force or last is None or (pd.Timestamp(sim_time) - pd.Timestamp(last)).days >= every  # noqa: E731
        if due(last_rt):
            try:
                out["retrain"] = run(con, sim_time, log)
            except Exception as e:  # noqa: BLE001
                out["retrain"] = {"status": "failed", "error": f"{e.__class__.__name__}: {e}"}
                log(f"  retrain failed: {out['retrain']['error']}")
        if due(last_fc):
            from pipeline.marts.forecast import build_forecast

            from .forecast.run import run as forecast_run
            out["forecast"] = forecast_run(con, sim_time, log)
            build_forecast(con, sim_time, log)
    finally:
        if own:
            con.close()
    if not out:
        return None
    if (publish if publish is not None else own):
        from pipeline.run import run as pipeline_run
        pipeline_run(do_extract=False, start_at="publish", log=log)
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--maybe", action="store_true", help="only when 30 sim days have passed since the last retrain")
    a = ap.parse_args()
    from simulator import local as _clock
    _lock = _clock.acquire("retrain (CLI)")   # never next to a sim advance or an API model job (BusyError otherwise)
    if a.maybe:
        from pipeline.db import work_connection
        from pipeline.run import sim_time_of
        c = work_connection()
        st = sim_time_of(c)
        c.close()
        try:
            print(json.dumps(maybe_retrain(st, publish=False), default=_js, indent=1))
        finally:
            _lock.release()
    else:
        try:
            print(json.dumps(run(), default=_js, indent=1))
        finally:
            _lock.release()
