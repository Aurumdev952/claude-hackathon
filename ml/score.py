"""Batch scoring inside the pipeline (SPEC §10.3 step 7, §13.9-13.10) + doctor alerts (SPEC §15.4).

Scores every eligible GI-cohort patient at the current sim date (alive, no prior gastric cancer). Writes:
pt_features, pt_risk (bands, top SHAP reasons, Tier 3 attributions), ml_risk_history, pt_alerts (deduplicated).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import uuid
from pathlib import Path

import numpy as np
import pandas as pd

from . import registry, tier1_score, tier2_xgb
from .features import build_feature_table, design_matrix, prepare_sources

ACTIONS = {"RISK_BAND_HIGH": "Consider upper GI endoscopy referral",
           "ALARM_NO_SCOPE_90D": "Alarm features without endoscopy for 90+ days: refer for endoscopy",
           "HB_DROP": "Investigate falling haemoglobin: FBC, iron studies, consider GI work-up",
           "HP_POS_UNTREATED": "Start H. pylori eradication therapy per national guideline"}


def score_in_pipeline(con, sim_time: dt.datetime, log=print):
    act = registry.active(con)
    if 2 not in act:
        return
    L = sim_time.date()
    elig = con.execute(f"""
        SELECT g.patient_id FROM core_gi_cohort g JOIN core_dim_patient p USING (patient_id) LEFT JOIN core_gc_case c USING (patient_id)
        WHERE g.entry_date <= DATE '{L}' AND date_diff('year', p.birthdate, DATE '{L}') >= 18
          AND (p.death_date IS NULL OR p.death_date > DATE '{L}') AND (c.dx_date IS NULL OR c.dx_date > DATE '{L}')
          AND g.patient_id NOT IN (SELECT patient_id FROM core_gc_prevalent)""").df()
    if elig.empty:
        return
    elig["L"] = L
    prepare_sources(con)
    feats = build_feature_table(con, elig, "pt_features")
    con.execute(f"ALTER TABLE pt_features ADD COLUMN as_of DATE DEFAULT DATE '{L}'")
    X = design_matrix(feats)
    clf, iso, meta = tier2_xgb.load(Path(act[2]["path"]))
    X = X[meta["features"]]
    t1 = tier1_score.points(feats)
    t2 = tier2_xgb.predict(clf, iso, X)
    contrib = tier2_xgb.shap_values(clf, X)
    reasons = tier2_xgb.top_reasons(meta["features"], contrib, X, feats)
    t3, attn = _tier3(con, act.get(3), feats, X, log)
    ens = np.nanmean(np.vstack([t2, t3]), axis=0) if t3 is not None else t2
    params = act[2]["params"]
    hi, med = params["high_cut"], params["medium_cut"]
    band = np.where(ens >= hi, "HIGH", np.where(ens >= med, "MEDIUM", "LOW"))
    risk = pd.DataFrame({"patient_id": feats["patient_id"].values, "as_of": pd.Timestamp(sim_time), "t1_score": t1,
                         "t1_band": tier1_score.band(t1), "t2_prob": t2, "t3_prob": t3 if t3 is not None else np.nan,
                         "ensemble_prob": ens, "risk_band": band,
                         "top_reasons": [json.dumps(r) for r in reasons],
                         "t3_attention": [json.dumps(a) for a in attn] if attn is not None else None})
    con.register("_risk", risk)
    con.execute("""CREATE TABLE IF NOT EXISTS ml_risk_history (patient_id INTEGER, as_of TIMESTAMP, t1_score INTEGER, t2_prob DOUBLE,
                   t3_prob DOUBLE, ensemble_prob DOUBLE, risk_band VARCHAR)""")
    con.execute("DELETE FROM ml_risk_history WHERE CAST(as_of AS DATE) = ?", [L])
    con.execute("INSERT INTO ml_risk_history SELECT patient_id, as_of, t1_score, t2_prob, t3_prob, ensemble_prob, risk_band FROM _risk")
    con.execute(f"""
        CREATE OR REPLACE TABLE pt_risk AS
        WITH first_high AS (SELECT patient_id, min(as_of) AS t FROM ml_risk_history WHERE risk_band = 'HIGH' GROUP BY 1),
        scoped AS (SELECT f.patient_id, count(e.encounter_id) > 0 AS s FROM first_high f
                   LEFT JOIN core_fact_encounter e ON e.patient_id = f.patient_id AND e.encounter_type = 5 AND e.encounter_datetime >= f.t
                   GROUP BY 1)
        SELECT r.*, p.home_facility_id AS facility_id,
               rank() OVER (PARTITION BY p.home_facility_id ORDER BY r.ensemble_prob DESC) AS rank_in_facility,
               coalesce(s.s, FALSE) AS scoped_since_flag, f.t AS first_high_at
        FROM _risk r JOIN core_dim_patient p USING (patient_id) LEFT JOIN first_high f USING (patient_id)
        LEFT JOIN scoped s USING (patient_id)""")
    con.unregister("_risk")
    _alerts(con, sim_time, feats, risk)
    n_hi = int((band == "HIGH").sum())
    log(f"    scored {len(risk):,} patients: HIGH={n_hi:,} MEDIUM={int((band == 'MEDIUM').sum()):,}")


def _tier3(con, m, feats, X, log=print):
    if not m:
        return None, None
    from .tier3_seq import dataset as D
    from .tier3_seq import model as M3
    from .tier3_seq import train as T3
    from .tier3_seq.tokenizer import Tokenizer
    path = Path(m["path"])
    tok = Tokenizer.load(path / "tokenizer.json")
    meta = __import__("json").load(open(path / "meta.json"))
    cfg = meta["cfg"]
    max_len = int(cfg.get("max_len", 128))
    p, meta, iso = T3.load(path, len(tok.vocab), len(D.STATIC_COLS))
    lm = feats[["patient_id", "L"]].copy().reset_index(drop=True)
    lm["row_id"] = np.arange(len(lm))
    ev = D.fetch_events(con, lm, 1096, max_len)
    ids, days, age = D.tensors(ev, len(lm), tok, max_len)
    S = (X.reindex(columns=D.STATIC_COLS).fillna(0).values.astype(np.float32) - np.array(meta["static_mean"])) / np.array(meta["static_std"])
    S = S.astype(np.float32)
    z = T3.predict_logits(p, cfg, ids, days, age, S)
    prob = T3.calibrated(z, meta["temperature"], iso)
    # Integrated Gradients for the top-scoring 10% (shown in the Doctor timeline). IG is the costliest scoring step, so
    # attributions are cached per patient and recomputed only when the event history, the model, or 28 days have passed
    attn = [[] for _ in range(len(lm))]
    top = np.argsort(-prob)[: max(1, len(prob) // 10)]
    inv = {v: k for k, v in tok.vocab.items()}
    L = pd.Timestamp(lm["L"].iloc[0]).date()
    l_ord = L.toordinal()
    model_id = path.name
    con.execute("""CREATE TABLE IF NOT EXISTS cache_t3_attr (patient_id INTEGER, model_id VARCHAR, seq_hash VARCHAR,
                   computed DATE, attn VARCHAR)""")
    pids = lm["patient_id"].to_numpy()

    def seq_hash(row):
        m = ids[row] > 0  # event identity = token + absolute date, so the hash is stable as the landmark moves
        return hashlib.blake2b(ids[row][m].tobytes() + np.round(l_ord - days[row][m], 3).tobytes(), digest_size=12).hexdigest()

    hashes = {int(r): seq_hash(r) for r in top}
    cached = {int(a): (h, c, j) for a, h, c, j in con.execute(
        "SELECT patient_id, seq_hash, computed, attn FROM cache_t3_attr WHERE model_id = ?", [model_id]).fetchall()}
    todo, fresh = [], {}
    for r in top:
        c = cached.get(int(pids[r]))
        if c and c[0] == hashes[int(r)] and (L - c[1]).days < 28:
            fresh[int(r)] = json.loads(c[2])
        else:
            todo.append(int(r))
    for i in range(0, len(todo), 256):
        b = np.array(todo[i:i + 256])
        a = M3.integrated_gradients(p, ids[b], days[b], age[b], S[b], cfg)
        for j, row in enumerate(b):
            order = np.argsort(-a[j])[:5]
            fresh[int(row)] = [{"token": inv.get(int(ids[row, k]), "?"), "event_day": float(l_ord - days[row, k]),
                                "attribution": round(float(a[j, k]), 4)} for k in order if a[j, k] > 0 and ids[row, k] > 2]
    if todo:
        upd = pd.DataFrame({"patient_id": pids[todo].astype(np.int64), "model_id": model_id,
                            "seq_hash": [hashes[r] for r in todo], "computed": L,
                            "attn": [json.dumps(fresh[r]) for r in todo]})
        con.register("_attr", upd)
        con.execute("DELETE FROM cache_t3_attr WHERE patient_id IN (SELECT patient_id FROM _attr)")
        con.execute("INSERT INTO cache_t3_attr SELECT patient_id, model_id, seq_hash, computed, attn FROM _attr")
        con.unregister("_attr")
    for row, items in fresh.items():
        attn[row] = [{"token": it["token"], "days_before": round(l_ord - it["event_day"], 3), "attribution": it["attribution"]}
                     for it in items]
    log(f"    tier3 attributions: {len(todo):,} computed, {len(top) - len(todo):,} from cache")
    return prob, attn


def _alerts(con, sim_time, feats: pd.DataFrame, risk: pd.DataFrame):
    con.execute("""CREATE TABLE IF NOT EXISTS pt_alerts (alert_id VARCHAR, patient_id INTEGER, facility_id INTEGER, created_at TIMESTAMP,
                   "trigger" VARCHAR, severity VARCHAR, status VARCHAR, summary VARCHAR, reasons VARCHAR, suggested_action VARCHAR)""")
    f = feats.merge(risk[["patient_id", "risk_band", "top_reasons", "ensemble_prob"]], on="patient_id")
    L = pd.Timestamp(sim_time).date()
    con.register("_f", f[["patient_id"]])
    alarm_old = set(r[0] for r in con.execute(f"""
        WITH al AS (SELECT s.patient_id, max(s.datetime) AS t FROM core_fact_symptom s SEMI JOIN _f USING (patient_id)
                    WHERE s.concept_id IN (2203, 2205, 2213) AND s.datetime > DATE '{L}' - INTERVAL 365 DAY
                      AND s.datetime <= DATE '{L}' - INTERVAL 90 DAY GROUP BY 1)
        SELECT al.patient_id FROM al JOIN core_dim_patient p USING (patient_id)
        WHERE date_diff('year', p.birthdate, DATE '{L}') >= 45
          AND NOT EXISTS (SELECT 1 FROM core_fact_order o WHERE o.patient_id = al.patient_id AND o.concept_id = 8000
                          AND o.datetime >= al.t - INTERVAL 1 DAY)""").fetchall())
    workup = set(r[0] for r in con.execute(f"""SELECT DISTINCT patient_id FROM core_fact_order SEMI JOIN _f USING (patient_id)
                                              WHERE concept_id IN (8000, 8005) AND datetime > DATE '{L}' - INTERVAL 365 DAY""").fetchall())
    con.unregister("_f")
    existing = {(r[0], r[1]) for r in con.execute("""SELECT patient_id, "trigger" FROM pt_alerts
                                                     WHERE created_at > ? - INTERVAL 180 DAY""", [sim_time]).fetchall()}
    fac = dict(con.execute("SELECT patient_id, home_facility_id FROM core_dim_patient").fetchall()) if len(f) else {}
    new = []
    for r in f.itertuples(index=False):
        trig = []
        if r.risk_band == "HIGH":
            trig.append(("RISK_BAND_HIGH", "HIGH", f"Gastric cancer risk in the top 2% of the GI cohort (12-month probability {100 * r.ensemble_prob:.1f}%)."))
        if r.patient_id in alarm_old:
            trig.append(("ALARM_NO_SCOPE_90D", "HIGH", "Alarm features recorded 90+ days ago with no endoscopy referral."))
        if (r.hb_drop_12m or 0) >= 2.0 and r.patient_id not in workup:
            trig.append(("HB_DROP", "MEDIUM", f"Haemoglobin fell {r.hb_drop_12m:.1f} g/dL in 12 months with no GI work-up."))
        if r.hp_pos_untreated == 1:
            trig.append(("HP_POS_UNTREATED", "MEDIUM", "H. pylori positive more than 30 days ago, no eradication therapy recorded."))
        for t, sev, text in trig:
            if (r.patient_id, t) in existing:
                continue
            new.append({"alert_id": str(uuid.uuid4()), "patient_id": int(r.patient_id), "facility_id": fac.get(r.patient_id),
                        "created_at": pd.Timestamp(sim_time), "trigger": t, "severity": sev, "status": "NEW", "summary": text,
                        "reasons": r.top_reasons, "suggested_action": ACTIONS[t]})
    if new:
        con.register("_new", pd.DataFrame(new))
        con.execute("INSERT INTO pt_alerts SELECT * FROM _new")
        con.unregister("_new")
