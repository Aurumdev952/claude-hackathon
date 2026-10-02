"""WebSocket subscription filter (contract §4.3, track L2): targeted care events, broadcast compatibility, and the
care.sqlite outbox drained by api.main._watch()."""
from __future__ import annotations

import pytest

from api.ws import Hub
from shared.config import ANALYTICS_DIR


class FakeWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, t):
        self.sent.append(t)


def test_targets_filter():
    h = Hub()
    doc, doc2, pat, anon = FakeWS(), FakeWS(), FakeWS(), FakeWS()
    h.clients |= {doc, doc2, pat, anon}
    h.subscribe(doc, {"role": "doctor", "facility_id": 1201})
    h.subscribe(doc2, {"role": "doctor", "facility_id": "1202"})
    h.subscribe(pat, {"role": "patient", "patient_id": 55})
    assert set(h.targets({"type": "care_update", "facility_id": 1201, "patient_id": 55})) == {doc}
    assert set(h.targets({"type": "notification", "patient_id": 55, "notification": {}})) == {pat}
    assert h.targets({"type": "notification", "patient_id": 56, "notification": {}}) == []
    for t in ("sim_job", "refresh", "alert_new", "sim_tick"):
        assert set(h.targets({"type": t})) == {doc, doc2, pat, anon}  # broadcast stays backward compatible
    with pytest.raises((ValueError, KeyError)):
        h.subscribe(anon, {"role": "doctor"})
    with pytest.raises(ValueError):
        h.subscribe(anon, {"role": "admin"})


def test_websocket_subscription_and_outbox_drain(tmp_path):
    if not (ANALYTICS_DIR / "current.json").exists():
        pytest.skip("no published serve DB")
    from fastapi.testclient import TestClient

    from api import app_state
    from care import store as st
    app_state.CON = app_state._con(":memory:")
    old = st.set_store(st.Store(tmp_path / "care.sqlite"))
    try:
        from api.main import app
        with TestClient(app) as c, c.websocket_connect("/api/v1/ws") as wd, c.websocket_connect("/api/v1/ws") as wp, \
                c.websocket_connect("/api/v1/ws") as wa:
            wd.send_json({"subscribe": {"role": "doctor", "facility_id": 1201}})
            assert wd.receive_json() == {"type": "subscribed", "role": "doctor", "facility_id": 1201}
            wp.send_json({"subscribe": {"role": "patient", "patient_id": 55}})
            assert wp.receive_json()["type"] == "subscribed"
            wa.send_json({"subscribe": {"role": "nobody"}})
            assert wa.receive_json()["code"] == "INVALID_SUBSCRIPTION"
            s = st.get_store()
            s.push({"type": "care_update", "facility_id": 1201, "patient_id": 55, "plan_id": "CP-1", "task_id": None, "kind": "x"})
            s.push({"type": "notification", "patient_id": 99, "notification": {"id": "NT-0"}})
            s.push({"type": "notification", "patient_id": 55, "notification": {"id": "NT-1"}})
            s.push({"type": "sim_job", "job_id": "j1", "status": "running", "progress": 0.5, "step": "pipeline"})

            def until_sim_job(ws):
                got = []
                while True:
                    m = ws.receive_json()
                    if m["type"] in ("refresh", "sim_tick", "alert_new"):
                        continue
                    got.append(m)
                    if m["type"] == "sim_job":
                        return got

            d = until_sim_job(wd)
            p = until_sim_job(wp)
            a = until_sim_job(wa)
        assert [m["type"] for m in d] == ["care_update", "sim_job"] and d[0]["plan_id"] == "CP-1"
        assert [m["type"] for m in p] == ["notification", "sim_job"] and p[0]["notification"]["id"] == "NT-1"
        assert [m["type"] for m in a] == ["sim_job"]
        assert s.drain() == []  # the watcher emptied the outbox
    finally:
        st.set_store(old)
