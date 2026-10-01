"""Landmark dataset construction (SPEC §13.1-13.2).

For a GI-cohort patient alive with no prior gastric cancer at landmark L, label = diagnosis (confirmed or probable) in
(L + 30d, L + 365d]. Only data recorded on or before L may be used for features (enforced in features.py).
"""
from __future__ import annotations

import datetime as dt
import hashlib

import pandas as pd

from shared.config import models_cfg


def _dates(start: str, end: str, freq: str) -> list[dt.date]:
    rule = {"quarterly": "QE", "monthly": "ME"}[freq]
    return [d.date() for d in pd.date_range(start, end, freq=rule)]


def patient_split(pid: int, val_frac: float) -> str:
    h = int(hashlib.sha1(f"es-{pid}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "test" if h < 0.25 else ("val" if h < 0.25 + 0.75 * val_frac else "train")


def build_landmarks(con, seed: int = 42) -> pd.DataFrame:
    cfg = models_cfg()
    w0, w1 = cfg["task"]["window_start_days"], cfg["task"]["window_end_days"]
    sp = cfg["splits"]
    max_neg = int(sp.get("max_neg_landmarks_per_patient", 4))
    train_l = _dates(str(sp["train_landmarks"]["start"]), str(sp["train_landmarks"]["end"]), sp["train_landmarks"]["freq"])
    test_l = _dates(str(sp["test_landmarks"]["start"]), str(sp["test_landmarks"]["end"]), sp["test_landmarks"]["freq"])
    rows = []
    for split_set, dates in (("trainval", train_l), ("test", test_l)):
        con.register("_lm_dates", pd.DataFrame({"L": pd.to_datetime(dates)}))
        df = con.execute(f"""
            SELECT g.patient_id, CAST(d.L AS DATE) AS L,
                   (c.dx_date > CAST(d.L AS DATE) + INTERVAL {w0} DAY AND c.dx_date <= CAST(d.L AS DATE) + INTERVAL {w1} DAY) AS label,
                   c.dx_date
            FROM core_gi_cohort g CROSS JOIN _lm_dates d
            JOIN core_dim_patient p USING (patient_id)
            LEFT JOIN core_gc_case c USING (patient_id)
            WHERE g.entry_date <= CAST(d.L AS DATE)
              AND date_diff('year', p.birthdate, CAST(d.L AS DATE)) >= 18
              AND (p.death_date IS NULL OR p.death_date > CAST(d.L AS DATE))
              AND (c.dx_date IS NULL OR c.dx_date > CAST(d.L AS DATE))
              AND g.patient_id NOT IN (SELECT patient_id FROM core_gc_prevalent)   -- known (prevalent) cancer: neither a negative nor a target
        """).df()
        con.unregister("_lm_dates")
        df["label"] = df["label"].fillna(False).astype(bool)
        df["split"] = [patient_split(int(p), sp["val_patient_frac"]) for p in df["patient_id"]]
        df = df[df["split"] == "test"] if split_set == "test" else df[df["split"] != "test"]
        # all positive landmarks; up to max_neg random negative landmarks per patient (no positive window for them)
        pos = df[df["label"]]
        neg = df[~df["label"]].sample(frac=1.0, random_state=seed).groupby("patient_id").head(max_neg)
        if split_set == "test":
            # temporal test: keep every monthly landmark of future cases (lead-time analysis), negatives sampled as above
            case_ids = set(df.loc[df["dx_date"].notna(), "patient_id"])
            pos = df[df["patient_id"].isin(case_ids)]
            neg = neg[~neg["patient_id"].isin(case_ids)]
        rows.append(pd.concat([pos, neg]))
    out = pd.concat(rows, ignore_index=True).drop_duplicates(["patient_id", "L"])
    out["L"] = pd.to_datetime(out["L"]).dt.date
    return out.sort_values(["split", "patient_id", "L"]).reset_index(drop=True)
