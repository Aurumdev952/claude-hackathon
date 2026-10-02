"""Model registry and evaluation (SPEC §14.2, §13.8)."""
from __future__ import annotations

import json as _json

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from .. import jobs
from ..deps import SERVE, APIError, Role, envelope, ministry, parse_json, role

router = APIRouter()


def _need():
    if not SERVE.has_table("ml_model_registry"):
        raise APIError(404, "NO_MODELS", "Models are not trained yet (make train)")


@router.get("/models")
def models(r: Role = Depends(role)):
    _need()
    reg = SERVE.rows("SELECT * FROM ml_model_registry WHERE is_active ORDER BY tier")
    met = SERVE.rows("SELECT * FROM ml_eval_metrics")
    thr = SERVE.one("SELECT * FROM ml_thresholds") if SERVE.has_table("ml_thresholds") else None
    out = []
    for m in reg:
        m["params_json"] = parse_json(m["params_json"])
        m["metrics"] = {x["split"]: x for x in met if x["model_id"] == m["model_id"]}
        out.append(m)
    ens = {x["split"]: x for x in met if x["model_id"] == "ensemble"}
    return envelope(out, ensemble=ens, thresholds=thr)


@router.get("/models/subgroups")
def subgroups(model_id: str | None = None, r: Role = Depends(role)):
    _need()
    q, p = "SELECT * FROM ml_subgroup_metrics", []
    if model_id:
        q += " WHERE model_id = ?"
        p.append(model_id)
    return envelope(SERVE.rows(q + " ORDER BY model_id, subgroup_var, subgroup_value", p))


@router.get("/models/{model_id}/curves")
def curves(model_id: str, r: Role = Depends(role)):
    _need()
    rows = SERVE.rows("SELECT curve, x, y FROM ml_eval_curves WHERE model_id = ? ORDER BY curve, x", [model_id])
    if not rows:
        raise APIError(404, "UNKNOWN_MODEL", f"No curves for {model_id}")
    out = {}
    for x in rows:
        out.setdefault(x["curve"], []).append({"x": x["x"], "y": x["y"]})
    return envelope(out)


@router.get("/models/{model_id}/importance")
def importance(model_id: str, limit: int = 30, r: Role = Depends(role)):
    _need()
    rows = SERVE.rows("SELECT feature, mean_abs_shap, rank FROM ml_feature_importance WHERE model_id = ? ORDER BY rank LIMIT ?",
                      [model_id, limit])
    hiv = SERVE.one("SELECT rank, mean_abs_shap FROM ml_feature_importance WHERE model_id = ? AND feature = 'hiv'", [model_id])
    return envelope(rows, negative_control={"feature": "hiv", **(hiv or {})})


# ------------------------------------------------------------------------------------------------ v3 learning loop (L3)
# docs/contracts/v3-loop.md §7: champion vs challenger, gates, retrain history, feedback labels, monitoring; promote,
# rollback and retrain run as background jobs (api/jobs.py) that write the work DB, re-score and publish.
JOB_KIND = "models"


def _m(r: Role = Depends(role)) -> Role:
    return ministry(r)


def _cols(table: str) -> set[str]:
    return {x["column_name"] for x in SERVE.rows("SELECT column_name FROM information_schema.columns WHERE table_name = ?", [table])}


def _model_card(row: dict | None) -> dict | None:
    if not row:
        return None
    met = SERVE.rows("SELECT * FROM ml_eval_metrics WHERE model_id = ?", [row["model_id"]]) if SERVE.has_table("ml_eval_metrics") else []
    p = parse_json(row.get("params_json")) or {}
    out = {k: row.get(k) for k in ("model_id", "tier", "version", "trained_at", "train_window", "is_active", "status", "parent_model_id",
                                    "n_feedback_labels", "promoted_at", "promoted_by", "promote_reason")}
    out["high_cut"] = p.get("high_cut") if isinstance(p, dict) else None
    out["ipw"] = p.get("ipw") if isinstance(p, dict) else None
    out["metrics"] = {x["split"]: x for x in met}
    return out


def _loop_state() -> dict:
    if not SERVE.has_table("ml_model_registry"):
        raise APIError(404, "NO_MODELS", "Models are not trained yet (make train)")
    has_status = "status" in _cols("ml_model_registry")
    champ = SERVE.one("SELECT * FROM ml_model_registry WHERE is_active AND tier = 2")
    chall = SERVE.one("SELECT * FROM ml_model_registry WHERE tier = 2 AND status = 'challenger' ORDER BY trained_at DESC LIMIT 1") \
        if has_status else None
    runs = SERVE.rows("SELECT * FROM ml_retrain_runs ORDER BY sim_time DESC, started_at DESC") if SERVE.has_table("ml_retrain_runs") else []
    for x in runs:
        x["metrics"], x["gates"] = parse_json(x["metrics"]), parse_json(x["gates"])
    latest = next((x for x in runs if chall and x["challenger_id"] == chall["model_id"]), runs[0] if runs else None)
    fb = {"n": 0, "by_source": {}, "by_kind": {}, "verified_cancers": 0}
    if SERVE.has_table("ml_feedback_labels"):
        rows = SERVE.rows("SELECT source, label_kind, count(*) AS n, sum(label) AS pos FROM ml_feedback_labels GROUP BY 1, 2")
        for x in rows:
            fb["n"] += x["n"]
            fb["by_source"][x["source"]] = fb["by_source"].get(x["source"], 0) + x["n"]
            fb["by_kind"][x["label_kind"]] = fb["by_kind"].get(x["label_kind"], 0) + x["n"]
            if x["label_kind"] == "cancer":
                fb["verified_cancers"] += int(x["pos"] or 0)
        # small-cell suppression (ministry aggregates)
        fb["by_source"] = {k: (v if v >= 5 else "<5") for k, v in fb["by_source"].items()}
    mon: dict = {"psi": [], "calibration": [], "alert_volume": [], "high_count": []}
    if SERVE.has_table("mart_model_monitoring"):
        rows = SERVE.rows("SELECT * FROM mart_model_monitoring ORDER BY as_of")
        last = max((x["as_of"] for x in rows if x["metric"].startswith("psi:")), default=None)
        mon["psi"] = sorted([{"feature": x["metric"][4:], "value": x["value"], "detail": x["detail"], "as_of": x["as_of"]}
                             for x in rows if x["metric"].startswith("psi:") and x["as_of"] == last], key=lambda x: -(x["value"] or 0))
        mon["psi_history"] = [{"feature": x["metric"][4:], "value": x["value"], "as_of": x["as_of"]} for x in rows if x["metric"].startswith("psi:")]
        mon["calibration"] = [x for x in rows if x["metric"] in ("calib_slope", "ppv_verified", "verified_outcomes")]
        mon["alert_volume"] = [{"date": x["as_of"], "value": x["value"]} for x in rows if x["metric"] == "alert_volume"]
        mon["high_count"] = [{"date": x["as_of"], "value": x["value"]} for x in rows if x["metric"] == "high_count"]
    try:
        from ml.adherence import info as adherence_info
        adherence = adherence_info()
    except Exception:  # noqa: BLE001
        adherence = None
    audit = SERVE.rows("SELECT * FROM ml_model_audit ORDER BY audit_at DESC LIMIT 50") if SERVE.has_table("ml_model_audit") else []
    gates = (latest or {}).get("gates") or []
    return {"champion": _model_card(champ), "challenger": _model_card(chall), "gates": gates,
            "decision": (latest or {}).get("decision"), "latest_run": {k: v for k, v in (latest or {}).items() if k != "metrics"} or None,
            "comparison": (latest or {}).get("metrics"), "history": runs, "feedback": fb, "monitoring": mon, "adherence": adherence,
            "audit": audit}


@router.get("/models/learning-loop")
def learning_loop(r: Role = Depends(_m)):
    # the published state is cached per serve DB version; the running job is live (never cached)
    data = {**SERVE.cached(("learning_loop",), _loop_state), "running_job": jobs.running(JOB_KIND)}
    return envelope(data, note="Synthetic data. Challenger models are trained automatically; a person promotes them.")


class DecisionIn(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)
    force: bool = False


def _registered(model_id: str) -> dict:
    if not SERVE.has_table("ml_model_registry"):
        raise APIError(404, "NO_MODELS", "Models are not trained yet (make train)")
    row = SERVE.one("SELECT * FROM ml_model_registry WHERE model_id = ?", [model_id])
    if not row:
        raise APIError(404, "UNKNOWN_MODEL", f"Unknown model {model_id}")
    return row


def _submit(label: str, fn) -> dict:
    """Run a model job that writes the work DB and publishes. It holds the sim clock's advance lock from submission to
    the end (simulator.local.acquire), so it never runs next to a sim advance (in this or another process), and it
    conflicts with the in-process sim_advance job kind. Busy -> 409."""
    lock = None
    try:
        from simulator import local
    except ImportError:  # no sim clock in this deployment: the job-kind conflict still applies
        local = None
    if local is not None:
        try:
            lock = local.acquire(f"models: {label}")
        except local.BusyError as e:
            raise APIError(409, "MODEL_JOB_BUSY", str(e)) from None

    def run(progress):
        try:
            return fn(progress)
        finally:
            if lock is not None:
                lock.release()

    try:
        job = jobs.submit(JOB_KIND, run, conflicts=("sim_advance",))
    except jobs.Busy as e:
        if lock is not None:
            lock.release()
        raise APIError(409, "MODEL_JOB_BUSY", str(e), {"job_id": e.job_id}) from None
    return {"job_id": job["id"], "status": job["status"], "action": label}


def _decide(action: str, model_id: str, reason: str, actor: str):
    """Job body: flip the registry in the work DB, then re-score (pipeline `score` step) and publish."""
    def fn(progress):
        from ml import registry as R
        from pipeline.db import work_connection
        from pipeline.run import run as pipeline_run, sim_time_of
        progress(0.05, "registry")
        con = work_connection()
        try:
            st = sim_time_of(con)
            res = (R.promote if action == "promote" else R.rollback)(con, model_id, actor, reason, st)
        finally:
            con.close()
        progress(0.2, "score")
        pipe = pipeline_run(do_extract=False, start_at="score", log=lambda *_: None)
        progress(1.0, "published")
        return {**res, "pipeline": {"run_id": pipe.get("run_id"), "steps": pipe.get("steps")}}
    return fn


@router.post("/models/{model_id}/promote")
def promote(model_id: str, body: DecisionIn, x_actor: str | None = Header(default=None), r: Role = Depends(_m)):
    row = _registered(model_id)
    if row.get("tier") != 2:
        raise APIError(400, "NOT_PROMOTABLE", "Only Tier 2 challengers are promoted in the learning loop")
    if row.get("is_active"):
        raise APIError(409, "ALREADY_CHAMPION", f"{model_id} is already the champion")
    if SERVE.has_table("ml_retrain_runs") and not body.force:
        run = SERVE.one("SELECT decision, gates FROM ml_retrain_runs WHERE challenger_id = ? ORDER BY started_at DESC LIMIT 1", [model_id])
        if run and run["decision"] == "gates_failed":
            raise APIError(409, "GATES_FAILED", "The challenger failed one or more gates; resend with force=true to promote anyway",
                           {"gates": [g for g in (parse_json(run["gates"]) or []) if not g.get("pass")]})
    actor = (x_actor or "ministry-user").strip()[:80]
    return envelope(_submit("promote", _decide("promote", model_id, body.reason, actor)) | {"model_id": model_id, "actor": actor})


@router.post("/models/{model_id}/rollback")
def rollback(model_id: str, body: DecisionIn, x_actor: str | None = Header(default=None), r: Role = Depends(_m)):
    row = _registered(model_id)
    if row.get("tier") != 2:
        raise APIError(400, "NOT_PROMOTABLE", "Only Tier 2 models are rolled back in the learning loop")
    if row.get("is_active"):  # rolling back the champion restores the model it replaced when it was promoted
        prev = SERVE.one("""SELECT previous_model_id FROM ml_model_audit WHERE model_id = ? AND action = 'promote'
                            AND previous_model_id IS NOT NULL AND previous_model_id <> model_id
                            ORDER BY audit_at DESC LIMIT 1""", [model_id]) if SERVE.has_table("ml_model_audit") else None
        if not prev:
            raise APIError(409, "NO_PREDECESSOR", f"{model_id} was not promoted over another model: nothing to roll back to")
    actor = (x_actor or "ministry-user").strip()[:80]
    return envelope(_submit("rollback", _decide("rollback", model_id, body.reason, actor)) | {"model_id": model_id, "actor": actor})


@router.post("/models/retrain")
def retrain(x_actor: str | None = Header(default=None), r: Role = Depends(_m)):
    def fn(progress):
        from ml.retrain import run as retrain_run
        from pipeline.run import run as pipeline_run
        progress(0.05, "retrain")
        res = retrain_run(log=lambda *_: None)
        progress(0.9, "publish")
        pipeline_run(do_extract=False, start_at="publish", log=lambda *_: None)
        progress(1.0, "published")
        return _json.loads(_json.dumps(res, default=str))
    return envelope(_submit("retrain", fn) | {"actor": (x_actor or "ministry-user").strip()[:80]})


@router.get("/models/jobs/{job_id}")
def model_job(job_id: str, r: Role = Depends(_m)):
    j = jobs.get(job_id)
    if not j or j.get("kind") != JOB_KIND:
        raise APIError(404, "NOT_FOUND", "Job not found")
    return envelope({k: j.get(k) for k in ("id", "status", "progress", "step", "result", "error", "started_at", "finished_at")})
