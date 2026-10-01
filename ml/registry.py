"""Local model registry (SPEC §11.6): ml_model_registry + artefact folders under data/models/<model_id>/."""
from __future__ import annotations

import datetime as dt
import hashlib
import json

from shared.config import MODELS_DIR


def model_dir(model_id: str):
    p = MODELS_DIR / model_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def register(con, model_id: str, tier: int, version: str, params: dict, features: list[str], train_window: str):
    con.execute("""CREATE TABLE IF NOT EXISTS ml_model_registry (model_id VARCHAR, tier INTEGER, version VARCHAR, trained_at TIMESTAMP,
                   train_window VARCHAR, features_hash VARCHAR, params_json VARCHAR, artefact_path VARCHAR, is_active BOOLEAN)""")
    con.execute("UPDATE ml_model_registry SET is_active = FALSE WHERE tier = ?", [tier])
    fh = hashlib.sha1(json.dumps(sorted(features)).encode()).hexdigest()[:12]
    con.execute("INSERT INTO ml_model_registry VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)",
                [model_id, tier, version, dt.datetime.now(), train_window, fh, json.dumps(params, default=str),
                 str(model_dir(model_id))])


def active(con) -> dict[int, dict]:
    try:
        rows = con.execute("SELECT tier, model_id, artefact_path, params_json FROM ml_model_registry WHERE is_active").fetchall()
    except Exception:
        return {}
    return {r[0]: {"model_id": r[1], "path": r[2], "params": json.loads(r[3])} for r in rows}
