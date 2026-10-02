"""care.journey.compute phase ordering (Wave 3 integration finding): the 'Seen' phase is the first contact with care
after the plan, which can be the referral endoscopy itself, so it never comes after the endoscopy it led to."""
from __future__ import annotations

from care import journey


def _phase(j, name):
    return next(p for p in j["phases"] if p["phase"] == name)


def test_seen_is_not_after_the_endoscopy_it_led_to():
    patient = {"patient_id": 1, "is_case": True, "dx_date": "2026-08-05", "dead": False, "death_date": None}
    events = [  # the referral endoscopy (encounter type 5), pathology, then a later clinic visit (type 3)
        {"ts": "2026-07-12T09:00:00", "event_type": "VISIT", "concept_id": 5, "label": "Endoscopy", "encounter_id": 10},
        {"ts": "2026-07-12T09:00:00", "event_type": "ENDOSCOPY", "concept_id": 5002, "label": "Suspicious lesion", "encounter_id": 10},
        {"ts": "2026-08-11T10:00:00", "event_type": "VISIT", "concept_id": 3, "label": "Return visit", "encounter_id": 11},
    ]
    plans = [{"id": "CP-1", "pathway": "ENDOSCOPY_REFERRAL", "approved_at": "2026-06-30T10:00:00",
              "tasks": [{"type": "ENDOSCOPY", "status": "COMPLETED", "opens_at": "2026-06-30T23:59:59", "due_at": "2026-07-28T23:59:59"}]}]
    j = journey.compute(patient, events, plans=plans, alerts=[{"created_at": "2026-06-20T00:00:00", "trigger": "RISK_BAND_HIGH"}],
                        first_notification="2026-06-30T10:00:00", now="2026-09-01T00:00:00")
    seen, endo = _phase(j, "Seen"), _phase(j, "Endoscopy")
    assert seen["status"] == "done" and endo["status"] == "done"
    assert seen["start"] <= endo["start"], (seen, endo)
    assert seen["start"].startswith("2026-07-12")


def test_seen_uses_a_clinic_visit_when_it_comes_first():
    patient = {"patient_id": 2, "is_case": False, "dx_date": None, "dead": False, "death_date": None}
    events = [{"ts": "2026-07-03T10:00:00", "event_type": "VISIT", "concept_id": 2, "label": "Clinic visit", "encounter_id": 20},
              {"ts": "2026-07-20T09:00:00", "event_type": "VISIT", "concept_id": 5, "label": "Endoscopy", "encounter_id": 21}]
    plans = [{"id": "CP-2", "pathway": "ENDOSCOPY_REFERRAL", "approved_at": "2026-07-01T10:00:00", "tasks": []}]
    j = journey.compute(patient, events, plans=plans, alerts=[{"created_at": "2026-06-25T00:00:00", "trigger": "RISK_BAND_HIGH"}],
                        first_notification="2026-07-01T10:00:00", now="2026-08-01T00:00:00")
    assert _phase(j, "Seen")["start"].startswith("2026-07-03")
