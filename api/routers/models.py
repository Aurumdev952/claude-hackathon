"""Model registry and evaluation (SPEC §14.2, §13.8)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..deps import SERVE, APIError, Role, envelope, parse_json, role

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
