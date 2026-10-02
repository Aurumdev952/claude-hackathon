"""In-API auto clock (track U2): POST /admin/sim {action: auto_start|auto_stop}, GET /admin/sim/status.

A fake `simulator.local` replaces the real clock and control.json lives in tmp_path, so these tests never touch a data
dir and never advance real sim time."""
from __future__ import annotations

import datetime as dt
import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class FakeLocal:
    """Stands in for simulator.local: advance() moves a fake clock by `days` and can block to simulate a slow tick."""
    SIM_END = dt.datetime(2027, 12, 31, 23, 59, 59)

    class BusyError(RuntimeError):
        pass

    def __init__(self, now=dt.datetime(2026, 6, 30, 23, 59, 59)):
        self.now = now
        self.calls = 0
        self.concurrent = 0
        self.max_concurrent = 0
        self.tick_seconds = 0.0
        self.external_auto = False
        self.lock = threading.Lock()

    def sim_time(self):
        return self.now

    def advance(self, days, on_progress=None, **_):
        with self.lock:
            self.calls += 1
            self.concurrent += 1
            self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            if on_progress:
                on_progress(0.5, "pipeline")
            time.sleep(self.tick_seconds)
            self.now = min(self.now + dt.timedelta(days=days), self.SIM_END)
            return {"status": "done", "sim_time_to": self.now.isoformat()}
        finally:
            with self.lock:
                self.concurrent -= 1

    def status(self):
        return {"sim_time": self.now.isoformat(), "sim_end": self.SIM_END.isoformat(),
                "days_left": max(0, (self.SIM_END - self.now).days),
                "auto": {"enabled": self.external_auto, "running": self.external_auto, "paused": False,
                         "seconds_per_day": 60.0, "demo_mode": False},
                "running_job": None, "last_tick": None}


@pytest.fixture()
def sim(tmp_path, monkeypatch):
    from api import jobs
    from api.routers import admin
    fake = FakeLocal()
    monkeypatch.setattr(admin, "CONTROL", tmp_path / "control.json")
    monkeypatch.setattr(admin, "_local", lambda: fake)
    monkeypatch.setattr(admin, "_emit", lambda *a, **k: None)
    monkeypatch.setattr(admin, "MIN_SPD", 0.05)
    monkeypatch.setattr(admin, "BEAT_S", 0.2)
    app = FastAPI()
    app.include_router(admin.router, prefix="/api/v1")

    from fastapi import HTTPException, Request
    from fastapi.responses import JSONResponse

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):   # same envelope as api.main
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    with TestClient(app) as c:
        yield c, fake, admin
    admin._stop_thread(wait=5)
    # let a running fake advance finish so the next test starts with no sim_advance job
    for _ in range(100):
        if not jobs.running("sim_advance"):
            break
        time.sleep(0.05)


def _wait(pred, timeout=8.0):
    t = time.time()
    while time.time() - t < timeout:
        if pred():
            return True
        time.sleep(0.05)
    return False


def _post(c, body):
    return c.post("/api/v1/admin/sim", json=body, headers={"X-Role": "ministry"})  # the sim controls need a role (F1 #18a)


def test_auto_start_validates_pace(sim):
    c, _, admin = sim
    for bad in ("fast", 0.0, 99999):
        r = _post(c, {"action": "auto_start", "seconds_per_day": bad})
        assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_PACE"
    assert not admin._thread_alive()


def test_auto_start_ticks_then_auto_stop_stops(sim):
    c, fake, admin = sim
    r = _post(c, {"action": "auto_start", "seconds_per_day": 0.1})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["auto"]["enabled"] is True
    ctl = json.loads(admin.CONTROL.read_text())
    assert ctl["api_auto"]["enabled"] is True and ctl["api_auto"]["seconds_per_day"] == 0.1 and ctl["paused"] is False

    assert _wait(lambda: fake.calls >= 2), "the auto clock should submit advance(1) jobs at the chosen pace"
    st = c.get("/api/v1/admin/sim/status").json()["data"]
    assert st["auto"]["enabled"] is True and st["auto"]["source"] == "api"
    assert st["auto"]["api"]["seconds_per_day"] == 0.1 and st["auto"]["api"]["owner"] == "this"

    r = _post(c, {"action": "auto_stop"})
    assert r.status_code == 200 and r.json()["data"]["auto"]["enabled"] is False
    assert _wait(lambda: not admin._thread_alive())
    _wait(lambda: fake.concurrent == 0)
    n = fake.calls
    time.sleep(0.5)
    assert fake.calls == n, "no ticks after auto_stop"
    ctl = json.loads(admin.CONTROL.read_text())
    assert ctl["api_auto"]["enabled"] is False and ctl["paused"] is True
    st = c.get("/api/v1/admin/sim/status").json()["data"]
    assert st["auto"]["enabled"] is False and st["auto"]["source"] is None


def test_never_overlaps_a_running_advance(sim):
    """A slow tick (longer than the pace) is never doubled up: the loop skips while an advance job runs."""
    c, fake, _ = sim
    fake.tick_seconds = 0.6
    _post(c, {"action": "auto_start", "seconds_per_day": 0.05})
    assert _wait(lambda: fake.calls >= 3, timeout=10)
    _post(c, {"action": "auto_stop"})
    assert fake.max_concurrent == 1


def test_no_double_tick_when_the_external_auto_process_runs(sim):
    """`python -m simulator.local --auto` alive -> the API loop leaves the ticking to it (and only syncs control.json)."""
    c, fake, admin = sim
    fake.external_auto = True
    r = _post(c, {"action": "auto_start", "seconds_per_day": 0.1})
    assert r.status_code == 200
    time.sleep(0.8)
    assert fake.calls == 0
    st = c.get("/api/v1/admin/sim/status").json()["data"]
    assert st["auto"]["source"] == "process" and st["auto"]["enabled"] is True
    assert json.loads(admin.CONTROL.read_text())["seconds_per_day"] == 0.1   # the process follows the new pace
    _post(c, {"action": "auto_stop"})


def test_manual_advance_while_auto_running_is_busy_not_doubled(sim):
    c, fake, _ = sim
    fake.tick_seconds = 0.8
    _post(c, {"action": "auto_start", "seconds_per_day": 5})
    assert _wait(lambda: fake.concurrent == 1)
    r = _post(c, {"action": "advance", "days": 7})
    assert r.status_code == 409 and r.json()["error"]["code"] == "SIM_BUSY"
    _post(c, {"action": "auto_stop"})
    assert fake.max_concurrent == 1


def test_stops_at_sim_end(sim):
    c, fake, admin = sim
    fake.now = FakeLocal.SIM_END - dt.timedelta(days=1)
    _post(c, {"action": "auto_start", "seconds_per_day": 0.05})
    assert _wait(lambda: not admin._thread_alive(), timeout=10)
    assert fake.now == FakeLocal.SIM_END
    ctl = json.loads(admin.CONTROL.read_text())
    assert ctl["api_auto"]["enabled"] is False and ctl["api_auto"]["stopped_reason"] == "sim_end"
    r = _post(c, {"action": "auto_start", "seconds_per_day": 10})
    assert r.status_code == 409 and r.json()["error"]["code"] == "SIM_END"


def test_resume_on_startup_respects_owner_and_pytest_guard(sim, monkeypatch):
    c, fake, admin = sim
    admin.write_control({"api_auto": {"enabled": True, "seconds_per_day": 0.1, "owner": "elsewhere:1", "beat": 0}})
    admin.resume_auto_on_startup()            # PYTEST_CURRENT_TEST is set: never starts under tests
    assert not admin._thread_alive()
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("SIM_AUTO_RESUME", "0")
    admin.resume_auto_on_startup()
    assert not admin._thread_alive()
    monkeypatch.setenv("SIM_AUTO_RESUME", "1")
    # a live owner elsewhere (fresh heartbeat, other host) keeps the loop: this process does not take over
    admin.write_control({"api_auto": {"enabled": True, "seconds_per_day": 0.1, "owner": "otherhost:1", "beat": time.time()}})
    admin.resume_auto_on_startup()
    assert not admin._thread_alive()
    # a dead owner (stale heartbeat): this process resumes the loop and ticks
    admin.write_control({"api_auto": {"enabled": True, "seconds_per_day": 0.1, "owner": "otherhost:1", "beat": 0}})
    admin.resume_auto_on_startup()
    assert admin._thread_alive()
    assert _wait(lambda: fake.calls >= 1)
    _post(c, {"action": "auto_stop"})


def test_legacy_actions_still_work(sim):
    c, _, admin = sim
    assert _post(c, {"action": "pause"}).json()["data"]["paused"] is True
    assert _post(c, {"action": "resume"}).json()["data"]["paused"] is False
    r = _post(c, {"action": "nope"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_ACTION"
