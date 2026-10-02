"""Track U3: the patient role gets a clean 403 (not a 500) from Ask the Data and the insight cards."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.main import app

PATIENT = {"X-Role": "patient", "X-Patient-Id": "1"}


@pytest.fixture(scope="module")
def client():
    return TestClient(app, raise_server_exceptions=False)  # no lifespan: the guard runs before any data access


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/v1/ask", {"question": "How many cases in 2025?"}),
    ("get", "/api/v1/ask/suggestions", None),
    ("get", "/api/v1/insights", None),
])
def test_patient_role_is_forbidden(client, method, path, body):
    r = client.request(method.upper(), path, headers=PATIENT, json=body)
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "FORBIDDEN"


def test_patient_role_without_patient_id_is_400(client):
    r = client.post("/api/v1/ask", headers={"X-Role": "patient"}, json={"question": "hi"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "PATIENT_REQUIRED"


def test_invalid_question_still_400_for_staff(client):
    r = client.post("/api/v1/ask", headers={"X-Role": "ministry"}, json={"question": ""})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_QUESTION"
