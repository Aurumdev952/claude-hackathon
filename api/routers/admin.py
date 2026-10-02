"""Demo controls for the simulator (SPEC §10.1, §14.2 POST /admin/sim). The API only writes a control file; the
simulator process reads it every loop."""
from __future__ import annotations

import datetime as dt
import json
import os
import socket
import threading
import time

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
    if action == "auto_start":
        return envelope(auto_start(body.get("seconds_per_day", DEFAULT_SPD)))
    if action == "auto_stop":
        return envelope(auto_stop())
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
        raise APIError(400, "INVALID_ACTION", "action must be pause|resume|demo_mode|fast_forward|advance|auto_start|auto_stop")
    return envelope(write_control(c))


def write_control(c: dict) -> dict:
    c["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    CONTROL.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONTROL.with_suffix(".tmp")
    json.dump(c, open(tmp, "w"))
    os.replace(tmp, CONTROL)
    return c


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
    elif rj and isinstance(st.get("running_job"), dict):
        st["running_job"] = {**st["running_job"], "id": rj.get("id"), "status": rj.get("status")}
    # auto clock: the external `simulator.local --auto` process (st["auto"]) or the in-API loop below (st["auto"]["api"])
    api = api_auto_state()
    a = dict(st.get("auto") or {})
    ext = bool(a.get("running"))
    a["api"] = api
    a["source"] = "process" if ext else ("api" if api["enabled"] else None)
    a["enabled"] = bool(a.get("enabled")) or api["enabled"]
    if api["enabled"] and not ext:
        a["seconds_per_day"] = api["seconds_per_day"]
    st["auto"] = a
    return envelope(st)


# ------------------------------------------------------------------------------------------------ in-API auto clock
# `auto_start {seconds_per_day}` / `auto_stop` (v3 U2). A daemon thread in the API process submits `advance(1)` jobs
# (api/jobs.py) at that pace. The flag lives in control.json under `api_auto` {enabled, seconds_per_day, owner, beat}
# so it survives an API restart; with several API processes on one data dir only the owner (pid + recent heartbeat)
# ticks. It never double-ticks: it skips while an advance job runs in this process, while another process holds the
# advance lock (advance_progress.json), and whenever the separate `python -m simulator.local --auto` process is alive
# (that process follows control.json `paused` / `seconds_per_day`, which auto_start / auto_stop also set).
DEFAULT_SPD = 30.0
MIN_SPD, MAX_SPD = 5.0, 3600.0
BEAT_S = 5.0
_AUTO_LOCK = threading.Lock()
_AUTO: dict = {"thread": None, "stop": None, "next_tick_at": None, "last_job_id": None, "last_error": None, "ticks": 0}
_OWNER = f"{socket.gethostname()}:{os.getpid()}"


def _now() -> float:
    return time.time()


def _owner_alive(a: dict) -> bool:
    """Another API process owns the loop and its heartbeat is fresh."""
    own, beat = a.get("owner"), float(a.get("beat") or 0)
    if not own or own == _OWNER:
        return False
    host, _, pid = str(own).rpartition(":")
    if host == socket.gethostname():
        try:
            os.kill(int(pid), 0)
        except (OSError, ValueError):
            return False
    return _now() - beat < max(30.0, 3 * float(a.get("seconds_per_day") or DEFAULT_SPD))


def _thread_alive() -> bool:
    t = _AUTO["thread"]
    return t is not None and t.is_alive()


def api_auto_state() -> dict:
    a = dict(read_control().get("api_auto") or {})
    mine = _thread_alive()
    running = mine or (bool(a.get("enabled")) and _owner_alive(a))
    return {"enabled": bool(a.get("enabled")) and running, "requested": bool(a.get("enabled")),
            "seconds_per_day": float(a.get("seconds_per_day") or DEFAULT_SPD), "running": running,
            "owner": "this" if mine else (a.get("owner") if running else None),
            "next_tick_at": _AUTO["next_tick_at"] if mine else None, "ticks": _AUTO["ticks"] if mine else None,
            "last_job_id": _AUTO["last_job_id"] if mine else None, "last_error": _AUTO["last_error"] if mine else None,
            "stopped_reason": a.get("stopped_reason")}


def _external_auto_alive(local) -> bool:
    try:
        return bool((local.status().get("auto") or {}).get("running"))
    except Exception:  # noqa: BLE001
        return False


def _advance_running_elsewhere(local) -> bool:
    if jobs.running("sim_advance"):
        return True
    try:
        return bool(local.status().get("running_job"))
    except Exception:  # noqa: BLE001
        return False


def _at_end(local) -> bool:
    try:
        return local.sim_time() >= local.SIM_END
    except Exception:  # noqa: BLE001
        return False


def _auto_loop(stop: threading.Event):
    """Tick every `seconds_per_day` (wall time between tick starts; a slow tick delays the next one, never overlaps)."""
    next_at = _now()
    beat = 0.0
    while not stop.is_set():
        c = read_control()
        a = c.get("api_auto") or {}
        if not a.get("enabled") or a.get("owner") not in (None, _OWNER):
            break
        spd = float(a.get("seconds_per_day") or DEFAULT_SPD)
        if _now() - beat >= BEAT_S:                  # heartbeat (ownership) without rewriting the file every second
            beat = a["beat"] = _now()
            c["api_auto"] = a
            write_control(c)
        if _now() >= next_at:
            try:
                local = _local()
                if _at_end(local):
                    c = read_control()
                    c["api_auto"] = {**(c.get("api_auto") or {}), "enabled": False, "stopped_reason": "sim_end"}
                    write_control(c)
                    break
                if _external_auto_alive(local) or _advance_running_elsewhere(local):
                    next_at = _now() + 1.0          # skip: someone else is ticking; re-check shortly
                else:
                    try:
                        out = _advance({"days": 1})
                        _AUTO["last_job_id"], _AUTO["last_error"] = out["job_id"], None
                        _AUTO["ticks"] += 1
                        next_at = _now() + spd
                    except APIError as e:           # SIM_BUSY (lost a race) -> retry soon
                        _AUTO["last_error"] = e.detail.get("code") if isinstance(e.detail, dict) else str(e)
                        next_at = _now() + 1.0
            except Exception as e:  # noqa: BLE001 - the loop never dies on one bad tick
                _AUTO["last_error"] = f"{e.__class__.__name__}: {e}"
                next_at = _now() + spd
        _AUTO["next_tick_at"] = dt.datetime.fromtimestamp(next_at, dt.timezone.utc).isoformat()
        stop.wait(min(1.0, max(0.05, next_at - _now())))
    _AUTO["next_tick_at"] = None


def _start_thread():
    with _AUTO_LOCK:
        if _thread_alive():
            return
        stop = threading.Event()
        t = threading.Thread(target=_auto_loop, args=(stop,), name="sim-auto-clock", daemon=True)
        _AUTO.update(thread=t, stop=stop, ticks=0, last_error=None)
        t.start()


def _stop_thread(wait: float = 2.0):
    with _AUTO_LOCK:
        t, stop = _AUTO["thread"], _AUTO["stop"]
    if stop is not None:
        stop.set()
    if t is not None and t.is_alive() and t is not threading.current_thread():
        t.join(timeout=wait)


def auto_start(seconds_per_day) -> dict:
    try:
        spd = float(seconds_per_day)
    except (TypeError, ValueError):
        raise APIError(400, "INVALID_PACE", "seconds_per_day must be a number") from None
    if not MIN_SPD <= spd <= MAX_SPD:
        raise APIError(400, "INVALID_PACE", f"seconds_per_day must be {MIN_SPD:g}-{MAX_SPD:g}")
    local = _local()
    if _at_end(local):
        raise APIError(409, "SIM_END", "The simulation has reached its end date (2027-12-31)")
    c = read_control()
    a = c.get("api_auto") or {}
    if a.get("enabled") and _owner_alive(a):          # another API process owns the loop: just change its pace
        c["api_auto"] = {**a, "seconds_per_day": spd}
    else:
        c["api_auto"] = {"enabled": True, "seconds_per_day": spd, "owner": _OWNER, "beat": _now(),
                         "started_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    # keep a separately running `simulator.local --auto` process in step (it reads these two keys)
    c["paused"], c["seconds_per_day"] = False, spd
    write_control(c)
    if c["api_auto"].get("owner") == _OWNER:
        _start_thread()
    return {"auto": api_auto_state(), "control": {k: c.get(k) for k in ("paused", "seconds_per_day", "demo_mode")}}


def auto_stop() -> dict:
    c = read_control()
    c["api_auto"] = {**(c.get("api_auto") or {}), "enabled": False, "stopped_reason": "user"}
    c["paused"] = True
    write_control(c)
    _stop_thread()
    return {"auto": api_auto_state(), "control": {k: c.get(k) for k in ("paused", "seconds_per_day", "demo_mode")}}


def resume_auto_on_startup():
    """Called from the API lifespan: restart the loop when control.json says it was on and no live owner holds it.
    Never under pytest (a TestClient must not start ticking a real data dir); SIM_AUTO_RESUME=0 disables it."""
    if os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("SIM_AUTO_RESUME", "1") == "0":
        return
    try:
        c = read_control()
        a = c.get("api_auto") or {}
        if a.get("enabled") and not _owner_alive(a):
            c["api_auto"] = {**a, "owner": _OWNER, "beat": _now()}
            write_control(c)
            _start_thread()
    except Exception as e:  # noqa: BLE001
        print(f"auto clock resume failed: {e}")
