"""Background jobs for long API actions (sim advance, model promote/retrain): a thread per job, progress in memory.

Shared by v3 tracks (docs/contracts/v3-loop.md §3, §7). One job per `kind` can run at a time.
"""
from __future__ import annotations

import datetime as dt
import threading
import traceback
import uuid
from typing import Any, Callable

_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_RUNNING: dict[str, str] = {}  # kind -> job id


class Busy(RuntimeError):
    def __init__(self, kind: str, job_id: str):
        super().__init__(f"a {kind} job is already running ({job_id})")
        self.kind, self.job_id = kind, job_id


def submit(kind: str, fn: Callable[[Callable[[float, str], None]], Any], on_done: Callable[[dict], None] | None = None) -> dict:
    """fn(progress) runs in a thread; progress(fraction 0-1, step label). Raises Busy if `kind` is already running."""
    with _LOCK:
        if kind in _RUNNING:
            raise Busy(kind, _RUNNING[kind])
        jid = f"{kind}-{uuid.uuid4().hex[:8]}"
        job = {"id": jid, "kind": kind, "status": "queued", "progress": 0.0, "step": None, "result": None, "error": None,
               "started_at": dt.datetime.now(dt.timezone.utc).isoformat(), "finished_at": None}
        _JOBS[jid] = job
        _RUNNING[kind] = jid

    def progress(frac: float, step: str | None = None):
        with _LOCK:
            job["progress"] = max(0.0, min(1.0, float(frac)))
            if step:
                job["step"] = step

    def run():
        with _LOCK:
            job["status"] = "running"
        try:
            res = fn(progress)
            with _LOCK:
                job.update(status="done", progress=1.0, result=res)
        except Exception as e:  # noqa: BLE001 - surfaced to the client as job.error
            with _LOCK:
                job.update(status="failed", error=f"{e.__class__.__name__}: {e}")
            traceback.print_exc()
        finally:
            with _LOCK:
                job["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
                _RUNNING.pop(kind, None)
            if on_done:
                try:
                    on_done(dict(job))
                except Exception:  # noqa: BLE001
                    traceback.print_exc()

    threading.Thread(target=run, name=jid, daemon=True).start()
    return dict(job)


def get(job_id: str) -> dict | None:
    with _LOCK:
        j = _JOBS.get(job_id)
        return dict(j) if j else None


def running(kind: str) -> dict | None:
    with _LOCK:
        jid = _RUNNING.get(kind)
        return dict(_JOBS[jid]) if jid else None
