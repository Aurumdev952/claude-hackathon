"""F1 #18b: the patient's own plan never carries internal codes that hint at a diagnosis."""
from __future__ import annotations

import json

from api.routers import patient_app

RAW = ("ONCOLOGY_TREATMENT", "ONCOLOGY_INTAKE", "CHEMO_CYCLE", "STAGING_CT", "MDT_PLAN", "SURGERY", "SURVIVORSHIP",
       "SURVEILLANCE_IMAGING", "PALLIATIVE_SUPPORT", "PATHOLOGY_REVIEW", "ONCOLOGY")


def _task(i, t):
    return {"id": f"CT-{i}", "plan_id": "CP-1", "seq": i, "type": t, "title": f"step {i}", "status": "DUE",
            "opens_at": "2026-07-01T00:00:00", "due_at": "2026-07-10T00:00:00", "completed_at": None, "reminders": 0}


def test_me_plan_has_no_diagnosis_codes(monkeypatch):
    plan = {"id": "CP-1", "patient_id": 7, "display_id": "MUS-0000007X", "pathway": "ONCOLOGY_TREATMENT", "status": "ACTIVE",
            "facility_id": 1207, "target_facility_id": 1001, "note": "doctor note", "model_id": "m", "context": {},
            "tasks": [_task(1, "ONCOLOGY_INTAKE"), _task(2, "STAGING_CT"), _task(3, "CHEMO_CYCLE"), _task(4, "HP_TREATMENT")],
            "events": [{"id": 1, "task_id": None, "kind": "PLAN_CREATED", "actor": "doctor", "sim_time": "x"},
                       {"id": 2, "task_id": "CT-1", "kind": "NEXT_PATHWAY_SUGGESTED", "actor": "system", "sim_time": "x"}]}
    monkeypatch.setattr(patient_app.engine, "plans_for", lambda pid: [plan])
    monkeypatch.setattr(patient_app.SERVE, "one", lambda *a, **k: {"name": "Referral Hospital (Synthetic)"})
    out = patient_app.patient_plans(7)
    text = json.dumps(out)
    for code in RAW:
        assert code not in text, code
    p = out[0]
    assert "pathway" not in p and p["pathway_name"] == "Specialist treatment"
    assert [t["type"] for t in p["tasks"]] == ["SPECIALIST_VISIT", "SCAN", "TREATMENT_CYCLE", "HP_TREATMENT"]
    assert "note" not in p and "model_id" not in p


def test_notification_template_key_is_neutral():
    n = {"id": "NT-1", "plan_id": "CP-1", "task_id": "CT-3", "channel": "APP", "template_key": "ONCOLOGY_TREATMENT.CHEMO_CYCLE.reminder",
         "title": "t", "body": "b", "created_sim": "x", "delivered_sim": "x", "read_sim": None, "acted_sim": None}
    assert patient_app._note(n, "Aline")["template_key"] == "care.TREATMENT_CYCLE.reminder"
    assert patient_app.patient_template_key("default.ENDOSCOPY.completed") == "care.ENDOSCOPY.completed"
