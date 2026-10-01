"""Tier 3 tokenisation (SPEC §13.7): (event_type, concept_id, value_bin[, ABN]) -> vocab id.

Numeric labs/vitals: 5 quantile bins per concept (fitted on training events) + an ABN flag outside normal range.
Coded values use the answer concept. Rare tokens (< min_count) map to [UNK].
"""
from __future__ import annotations

import json
from collections import Counter

import numpy as np
import pandas as pd

PAD, UNK, CLS = 0, 1, 2
SPECIAL = ["[PAD]", "[UNK]", "[CLS]"]

EVENT_SQL = """
WITH lm AS (SELECT patient_id, CAST(L AS DATE) AS L, row_id FROM {lm}),
ev AS (
  SELECT patient_id, t, 'V' AS et, encounter_type AS c, NULL::DOUBLE AS v, NULL::INTEGER AS a FROM ml_ok_enc
  UNION ALL SELECT patient_id, dx_datetime, 'D', concept_id, NULL, NULL FROM ml_dx
  UNION ALL SELECT patient_id, datetime, 'S', concept_id, NULL, NULL FROM ml_sym
  UNION ALL SELECT patient_id, datetime, 'L', concept_id, value_numeric, value_coded FROM ml_lab
  UNION ALL SELECT patient_id, datetime, 'W', concept_id, value_numeric, NULL FROM ml_vit WHERE concept_id IN (3000, 3002, 3005, 3003)
  UNION ALL SELECT patient_id, datetime, 'R', drug_concept_id, duration_days, NULL FROM ml_drug
)
SELECT lm.row_id, ev.et, ev.c, ev.v, ev.a, date_diff('day', ev.t, lm.L) AS days_before,
       date_diff('day', p.birthdate, ev.t) / 365.25 AS age_at
FROM lm JOIN ev ON ev.patient_id = lm.patient_id AND ev.t < lm.L + INTERVAL 1 DAY AND ev.t > lm.L - INTERVAL {lookback} DAY
JOIN core_dim_patient p ON p.patient_id = lm.patient_id
QUALIFY row_number() OVER (PARTITION BY lm.row_id ORDER BY ev.t DESC) <= {max_len}
"""


class Tokenizer:
    def __init__(self, vocab: dict[str, int] | None = None, bins: dict | None = None, normal: dict | None = None):
        self.vocab = vocab or {s: i for i, s in enumerate(SPECIAL)}
        self.bins = bins or {}
        self.normal = normal or {}

    def _strings(self, ev: pd.DataFrame) -> np.ndarray:
        et, c, v, a = ev["et"].values, ev["c"].values.astype(int), ev["v"].values.astype(float), ev["a"].values
        out = np.empty(len(ev), dtype=object)
        for i in range(len(ev)):
            key = f"{et[i]}:{c[i]}"
            if et[i] in ("L", "W") and not np.isnan(v[i]) and key in self.bins:
                b = int(np.searchsorted(self.bins[key], v[i]))
                lo, hi = self.normal.get(c[i], (None, None))
                abn = (lo is not None and v[i] < lo) or (hi is not None and v[i] > hi)
                out[i] = f"{key}:b{b}{':ABN' if abn else ''}"
            elif et[i] == "L" and a[i] is not None and not pd.isna(a[i]):
                out[i] = f"{key}:a{int(a[i])}"
            else:
                out[i] = key
        return out

    def fit(self, ev: pd.DataFrame, normal_ranges: dict, min_count: int = 20) -> "Tokenizer":
        self.normal = {int(k): v for k, v in normal_ranges.items()}
        num = ev[ev["et"].isin(["L", "W"]) & ev["v"].notna()]
        for (et, c), g in num.groupby(["et", "c"]):
            if len(g) >= 50:
                self.bins[f"{et}:{int(c)}"] = np.unique(np.quantile(g["v"].values, [0.2, 0.4, 0.6, 0.8])).tolist()
        counts = Counter(self._strings(ev))
        for s, n in counts.most_common():
            if n >= min_count and s not in self.vocab:
                self.vocab[s] = len(self.vocab)
        return self

    def encode(self, ev: pd.DataFrame) -> np.ndarray:
        s = self._strings(ev)
        return np.array([self.vocab.get(x, UNK) for x in s], dtype=np.int32)

    def save(self, path):
        json.dump({"vocab": self.vocab, "bins": self.bins, "normal": {str(k): v for k, v in self.normal.items()}}, open(path, "w"))

    @classmethod
    def load(cls, path):
        d = json.load(open(path))
        return cls(d["vocab"], d["bins"], {int(k): tuple(v) for k, v in d["normal"].items()})
