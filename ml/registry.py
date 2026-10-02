"""Local model registry (SPEC §11.6): ml_model_registry + artefact folders under data/models/<model_id>/.

v3 learning loop (docs/contracts/v3-loop.md §5, §7): additive columns `status` (champion/challenger/retired),
`parent_model_id`, `n_feedback_labels`, `promoted_at`, `promoted_by`, `promote_reason`; challengers are registered
inactive; `promote` / `rollback` flip the active model of a tier and write `ml_model_audit`.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json

from shared.config import MODELS_DIR

BASE_DDL = """CREATE TABLE IF NOT EXISTS ml_model_registry (model_id VARCHAR, tier INTEGER, version VARCHAR, trained_at TIMESTAMP,
              train_window VARCHAR, features_hash VARCHAR, params_json VARCHAR, artefact_path VARCHAR, is_active BOOLEAN)"""
EXTRA_COLS = {"status": "VARCHAR", "parent_model_id": "VARCHAR", "n_feedback_labels": "INTEGER", "promoted_at": "TIMESTAMP",
              "promoted_by": "VARCHAR", "promote_reason": "VARCHAR"}
AUDIT_DDL = """CREATE TABLE IF NOT EXISTS ml_model_audit (audit_at TIMESTAMP, sim_time TIMESTAMP, action VARCHAR, model_id VARCHAR,
               previous_model_id VARCHAR, tier INTEGER, actor VARCHAR, reason VARCHAR)"""


def model_dir(model_id: str):
    p = MODELS_DIR / model_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def ensure_columns(con):
    con.execute(BASE_DDL)
    for col, typ in EXTRA_COLS.items():
        con.execute(f"ALTER TABLE ml_model_registry ADD COLUMN IF NOT EXISTS {col} {typ}")
    con.execute("UPDATE ml_model_registry SET status = CASE WHEN is_active THEN 'champion' ELSE 'retired' END WHERE status IS NULL")
    con.execute(AUDIT_DDL)


def register(con, model_id: str, tier: int, version: str, params: dict, features: list[str], train_window: str, *,
             active: bool = True, status: str | None = None, parent_model_id: str | None = None,
             n_feedback_labels: int | None = None):
    """Register a model. By default it becomes the active champion of its tier (the v1 behaviour); a challenger is
    registered with active=False, status='challenger' and leaves the champion untouched."""
    ensure_columns(con)
    if active:
        con.execute("UPDATE ml_model_registry SET is_active = FALSE, status = 'retired' WHERE tier = ? AND is_active", [tier])
    fh = hashlib.sha1(json.dumps(sorted(features)).encode()).hexdigest()[:12]
    con.execute("DELETE FROM ml_model_registry WHERE model_id = ?", [model_id])
    con.execute("""INSERT INTO ml_model_registry (model_id, tier, version, trained_at, train_window, features_hash, params_json,
                   artefact_path, is_active, status, parent_model_id, n_feedback_labels)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [model_id, tier, version, dt.datetime.now(), train_window, fh, json.dumps(params, default=str),
                 str(model_dir(model_id)), bool(active), status or ("champion" if active else "challenger"), parent_model_id,
                 n_feedback_labels])


def active(con) -> dict[int, dict]:
    try:
        rows = con.execute("SELECT tier, model_id, artefact_path, params_json FROM ml_model_registry WHERE is_active").fetchall()
    except Exception:
        return {}
    return {r[0]: {"model_id": r[1], "path": r[2], "params": json.loads(r[3])} for r in rows}


def _row(con, model_id: str) -> dict | None:
    r = con.execute("SELECT model_id, tier, is_active, status, params_json FROM ml_model_registry WHERE model_id = ?", [model_id]).fetchone()
    return None if r is None else {"model_id": r[0], "tier": r[1], "is_active": bool(r[2]), "status": r[3], "params": json.loads(r[4])}


def _has_table(con, name: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]).fetchone()[0] > 0


def _activate(con, target: dict, actor: str, reason: str, action: str, sim_time=None) -> dict:
    """Flip the active model of the tier, write the audit row and keep ml_thresholds / ml_retrain_runs in step, all in
    one transaction (a failure leaves the registry as it was; no statement inside may fail on a missing table)."""
    tier = target["tier"]
    has_thr, has_runs = _has_table(con, "ml_thresholds"), _has_table(con, "ml_retrain_runs")
    own = True
    try:
        con.begin()
    except Exception:  # the caller already holds a transaction: it commits
        own = False
    try:
        prev = con.execute("SELECT model_id FROM ml_model_registry WHERE tier = ? AND is_active", [tier]).fetchone()
        prev_id = prev[0] if prev else None
        now = dt.datetime.now()
        con.execute("UPDATE ml_model_registry SET is_active = FALSE, status = 'retired' WHERE tier = ? AND is_active AND model_id <> ?",
                    [tier, target["model_id"]])
        con.execute("""UPDATE ml_model_registry SET is_active = TRUE, status = 'champion', promoted_at = ?, promoted_by = ?, promote_reason = ?
                       WHERE model_id = ?""", [now, actor, reason, target["model_id"]])
        con.execute("INSERT INTO ml_model_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [now, sim_time, action, target["model_id"], prev_id, tier, actor, reason])
        # the scoring step reads the bands from the champion's params; keep ml_thresholds in step for the API
        p = target["params"]
        if has_thr and "high_cut" in p:
            con.execute("UPDATE ml_thresholds SET high_cut = ?, medium_cut = ?", [p["high_cut"], p.get("medium_cut")])
        if has_runs:
            decision = "promoted" if action == "promote" else "rolled_back_to"
            con.execute("UPDATE ml_retrain_runs SET decision = ?, decided_by = ?, decided_at = ? WHERE challenger_id = ?",
                        [decision, actor, now, target["model_id"]])
            if action == "rollback" and prev_id:
                con.execute("UPDATE ml_retrain_runs SET decision = 'rolled_back', decided_by = ?, decided_at = ? WHERE challenger_id = ?",
                            [actor, now, prev_id])
        if own:
            con.commit()
    except BaseException:
        if own:
            con.rollback()
        raise
    return {"action": action, "model_id": target["model_id"], "previous_model_id": prev_id, "tier": tier, "actor": actor,
            "reason": reason, "at": now.isoformat()}


def promote(con, model_id: str, actor: str, reason: str, sim_time=None) -> dict:
    """Make `model_id` the active champion of its tier; the previous champion is retired."""
    ensure_columns(con)
    t = _row(con, model_id)
    if t is None:
        raise KeyError(f"unknown model {model_id}")
    if t["is_active"]:
        return {"action": "promote", "model_id": model_id, "previous_model_id": model_id, "tier": t["tier"], "noop": True}
    return _activate(con, t, actor, reason, "promote", sim_time)


def predecessor(con, model_id: str) -> str | None:
    """The champion `model_id` replaced when it was last *promoted* (audit log). A rollback that restored `model_id` is
    not a promotion, so rolling the restored model back goes further back in the promotion history instead of undoing
    the rollback (A -> promote C -> roll back to A -> roll back A restores what A replaced, never C again)."""
    r = con.execute("""SELECT previous_model_id FROM ml_model_audit WHERE model_id = ? AND action = 'promote'
                       AND previous_model_id IS NOT NULL AND previous_model_id <> model_id
                       ORDER BY audit_at DESC LIMIT 1""", [model_id]).fetchone()
    return r[0] if r else None


def rollback(con, model_id: str, actor: str, reason: str, sim_time=None) -> dict:
    """Restore a previous champion. `model_id` is the model to restore; if it is the current champion, the champion it
    replaced when it was promoted (`predecessor`, from the audit log) is restored instead."""
    ensure_columns(con)
    t = _row(con, model_id)
    if t is None:
        raise KeyError(f"unknown model {model_id}")
    if t["is_active"]:
        prev = predecessor(con, model_id)
        if not prev:
            raise ValueError(f"{model_id} is the champion and was not promoted over another model: nothing to roll back to")
        t = _row(con, prev)
        if t is None:
            raise KeyError(f"previous model {prev} is no longer registered")
    return _activate(con, t, actor, reason, "rollback", sim_time)
