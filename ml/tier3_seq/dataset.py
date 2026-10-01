"""Builds padded sequence tensors for landmark rows (left-padded, [CLS] first, most recent max_len-1 events)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .tokenizer import CLS, EVENT_SQL, PAD, Tokenizer

STATIC_COLS = ["age", "sex_male", "district_asr_prior", "home_endoscopy_access",
               "province_code=KGL", "province_code=NOR", "province_code=SOU", "province_code=EAS", "province_code=WES",
               "home_facility_tier=low", "home_facility_tier=medium", "home_facility_tier=high", "home_facility_tier=unknown"]


def fetch_events(con, lm: pd.DataFrame, lookback_days: int, max_len: int) -> pd.DataFrame:
    con.register("_lm_seq", lm[["patient_id", "L", "row_id"]])
    ev = con.execute(EVENT_SQL.format(lm="_lm_seq", lookback=lookback_days, max_len=max_len - 1)).df()
    con.unregister("_lm_seq")
    return ev


def tensors(ev: pd.DataFrame, n_rows: int, tok: Tokenizer, max_len: int):
    ids = np.full((n_rows, max_len), PAD, dtype=np.int32)
    days = np.zeros((n_rows, max_len), dtype=np.float32)
    age = np.zeros((n_rows, max_len), dtype=np.float32)
    ids[:, -1] = CLS  # [CLS] sits at the last position (right-aligned sequences, causal order old -> new -> CLS)
    if len(ev):
        ev = ev.sort_values(["row_id", "days_before"], ascending=[True, False])
        codes = tok.encode(ev)
        rid = ev["row_id"].values
        # position from the right: newest event at max_len-2
        order = ev.groupby("row_id").cumcount(ascending=False).values
        pos = max_len - 2 - order
        ok = pos >= 0
        ids[rid[ok], pos[ok]] = codes[ok]
        days[rid[ok], pos[ok]] = ev["days_before"].values[ok]
        age[rid[ok], pos[ok]] = ev["age_at"].values[ok]
    return ids, days, age


def static_matrix(X: pd.DataFrame, mean=None, std=None):
    S = X[STATIC_COLS].fillna(0).values.astype(np.float32)
    if mean is None:
        mean, std = S.mean(axis=0), S.std(axis=0) + 1e-6
    return (S - mean) / std, mean, std
