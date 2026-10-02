"""api/jobs.py: a finished job has already swapped the API's serve DB (no stale read right after "done")."""
from __future__ import annotations

import time

from api import jobs


def test_done_job_has_refreshed_the_serve_db(monkeypatch):
    calls = []
    from api import deps
    monkeypatch.setattr(deps.SERVE, "refresh", lambda: calls.append("refresh") or True)
    j = jobs.submit("t-refresh", lambda p: calls.append("fn") or 1)
    for _ in range(100):
        if jobs.get(j["id"])["status"] == "done":
            break
        time.sleep(0.01)
    assert jobs.get(j["id"])["status"] == "done"
    assert calls == ["fn", "refresh"]  # refreshed before the job reads as done
