"""Demo controls for the simulator (SPEC §10.1, §14.2 POST /admin/sim). The API only writes a control file; the
simulator process reads it every loop."""
from __future__ import annotations

import datetime as dt
import json
import os

from fastapi import APIRouter, Body

from shared.config import SIM_STATE_DIR

from .. import jobs
from ..deps import APIError, envelope

router = APIRouter()
CONTROL = SIM_STATE_DIR / "control.json"


def read_control() -> dict:
    try:
        return json.load(open(CONTROL))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"paused": False, "demo_mode": False, "fast_forward_days": 0}


@router.post("/admin/sim")
def sim(body: dict = Body(...)):
    action = body.get("action")
    if action == "advance":
        return envelope(_advance(body))
    c = read_control()
    if action == "pause":
        c["paused"] = True
    elif action == "resume":
        c["paused"] = False
    elif action == "demo_mode":
        c["demo_mode"] = bool(body.get("enabled", True))
    elif action == "fast_forward":
        days = int(body.get("days", 7))
        if not 1 <= days <= 365:
            raise APIError(400, "INVALID_DAYS", "days must be 1-365")
        c["fast_forward_days"] = int(c.get("fast_forward_days", 0)) + days
    else:
        raise APIError(400, "INVALID_ACTION", "action must be pause|resume|demo_mode|fast_forward|advance")
    c["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    SIM_STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONTROL.with_suffix(".tmp")
    json.dump(c, open(tmp, "w"))
    os.replace(tmp, CONTROL)
    return envelope(c)


# ------------------------------------------------------------------------------------------------ v3 sim clock jobs
# docs/contracts/v3-loop.md §3 (API control): `simulator.local` (track L1) runs the MySQL-free tick; the API runs it as
# a background job (api/jobs.py) and reports progress over GET /admin/sim/jobs/{id} and `sim_job` WS events.
def _local():
    try:
        from simulator import local
        return local
    except ImportError:
        raise APIError(503, "SIM_UNAVAILABLE", "The local sim clock (simulator.local) is not available") from None


def _emit(job_id: str, status: str, progress: float, step: str | None):
    """Queue a `sim_job` event for every client (the care outbox is drained by api.main._watch)."""
    try:
        from care.store import get_store
        get_store().push({"type": "sim_job", "job_id": job_id, "status": status, "progress": round(float(progress), 3),
                          "step": step})
    except Exception:  # noqa: BLE001 - progress events are best effort
        pass


def _advance(body: dict) -> dict:
    try:
        days = int(body.get("days", 1))
    except (TypeError, ValueError):
        raise APIError(400, "INVALID_DAYS", "days must be an integer") from None
    if not 1 <= days <= 90:
        raise APIError(400, "INVALID_DAYS", "days must be 1-90")
    local = _local()
    holder: dict = {}

    def run(progress):
        last = {"step": None}

        def on_progress(frac, step=None, *_, **__):
            progress(frac, step)
            if step != last["step"]:
                last["step"] = step
                _emit(holder.get("id", ""), "running", frac, step)

        busy = getattr(local, "BusyError", None)
        try:
            return local.advance(days, on_progress=on_progress)
        except Exception as e:  # noqa: BLE001
            if busy and isinstance(e, busy):
                raise RuntimeError("another advance is already running") from e
            raise

    def done(job: dict):
        _emit(job["id"], job["status"], job.get("progress") or 0.0, job.get("step"))

    try:
        job = jobs.submit("sim_advance", run, on_done=done)
    except jobs.Busy as e:
        raise APIError(409, "SIM_BUSY", str(e), {"job_id": e.job_id}) from None
    holder["id"] = job["id"]
    _emit(job["id"], "queued", 0.0, None)
    return {"job_id": job["id"], "status": job["status"], "days": days}


@router.get("/admin/sim/jobs/{job_id}")
def sim_job(job_id: str):
    j = jobs.get(job_id)
    if not j:
        raise APIError(404, "NOT_FOUND", "Job not found")
    return envelope({k: j.get(k) for k in ("id", "status", "progress", "step", "result", "error", "started_at", "finished_at")})


@router.get("/admin/sim/status")
def sim_status():
    local = _local()
    st = dict(local.status())
    rj = jobs.running("sim_advance")
    if rj and not st.get("running_job"):
        st["running_job"] = {k: rj.get(k) for k in ("id", "status", "progress", "step")}
    return envelope(st)
