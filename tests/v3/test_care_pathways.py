"""Care pathway schedule math (config/care_pathways.yaml, track L2)."""
from __future__ import annotations

from care import pathways


def test_all_six_pathways_and_known_task_types():
    p = pathways.pathways()
    assert set(p) == {"ENDOSCOPY_REFERRAL", "HP_TEST_AND_TREAT", "ANAEMIA_WORKUP", "ONCOLOGY_TREATMENT", "SURVIVORSHIP",
                      "PALLIATIVE_SUPPORT"}
    for pid, pw in p.items():
        assert pw["tasks"], pid
        for t in pw["tasks"]:
            assert t["type"] in pathways.TASK_TYPES
            for res, nxt in (t.get("next") or {}).items():
                for n in nxt or []:
                    pathways.task_spec(pid, n)  # every spawned task is defined in the same pathway


def test_ladder_app_t_minus_3_sms_due_chw_7_doctor_14():
    lad = pathways.ladder()
    assert [s["offset_days"] for s in lad] == [-3, 0, 7, 14]
    assert lad[0]["channels"] == ["APP"]
    assert set(lad[1]["channels"]) == {"APP", "SMS"}
    assert lad[2]["spawn"] == "CHW_VISIT" and lad[2]["escalation_level"] == 2
    assert lad[3]["doctor"] and lad[3]["escalation_level"] == 3


def test_endoscopy_due_30_days_or_14_with_alarm_features():
    (t,) = pathways.start_tasks("ENDOSCOPY_REFERRAL")
    assert (t["type"], t["opens"], t["due"]) == ("ENDOSCOPY", 0, 30)
    (t,) = pathways.start_tasks("ENDOSCOPY_REFERRAL", trigger="ALARM_NO_SCOPE_90D", facts={"alarm": True})
    assert t["due"] == 14
    assert pathways.next_tasks("ENDOSCOPY_REFERRAL", "ENDOSCOPY", "SUSPICIOUS") == ["PATHOLOGY_REVIEW"]
    assert pathways.next_tasks("ENDOSCOPY_REFERRAL", "ENDOSCOPY", "GASTRITIS") == ["RESULT_DISCUSSED"]


def test_hp_test_of_cure_at_least_4_weeks_after_14_day_course():
    tr = pathways.task_spec("HP_TEST_AND_TREAT", "HP_TREATMENT")
    toc = pathways.task_spec("HP_TEST_AND_TREAT", "HP_TEST_OF_CURE")
    # anchor = start of the eradication course; the window opens after the course plus 28 days
    assert toc["opens_days"] >= tr["course_days"] + 28
    assert toc["due_days"] > toc["opens_days"]
    assert pathways.next_tasks("HP_TEST_AND_TREAT", "HP_TEST", "POSITIVE") == ["HP_TREATMENT"]
    assert pathways.next_tasks("HP_TEST_AND_TREAT", "HP_TEST", "NEGATIVE") == []
    assert pathways.next_tasks("HP_TEST_AND_TREAT", "HP_TEST_OF_CURE", "POSITIVE") == ["HP_TREATMENT"]  # second line
    assert tr["max_spawns"] == 2
    # an untreated positive starts directly with the course
    (t,) = pathways.start_tasks("HP_TEST_AND_TREAT", trigger="HP_POS_UNTREATED")
    assert t["type"] == "HP_TREATMENT"


def test_survivorship_every_3_months_to_year_3_then_6_months_to_year_5():
    spec = pathways.task_spec("SURVIVORSHIP", "FOLLOWUP_VISIT")
    occ = pathways.occurrences(spec)
    early = [d for d in occ if d <= 1095]
    late = [d for d in occ if d > 1092]
    assert early[0] == 91 and all(b - a == 91 for a, b in zip(early, early[1:]))
    assert len(early) == 12
    assert late[0] - early[-1] == 182 and all(b - a == 182 for a, b in zip(late, late[1:]))
    assert max(occ) <= 1826 and pathways.pathway("SURVIVORSHIP")["end_days"] == 1826
    labs = pathways.occurrences(pathways.task_spec("SURVIVORSHIP", "B12_CHECK"))
    assert labs[0] == 182 and all(b - a == 182 for a, b in zip(labs, labs[1:]))
    o, d = pathways.window(spec, 91)
    assert (o, d) == (70, 91)


def test_survivorship_conditional_tasks():
    base = {t["type"] for t in pathways.start_tasks("SURVIVORSHIP", facts={})}
    assert base == {"FOLLOWUP_VISIT", "B12_CHECK", "NUTRITION_REVIEW"}
    full = {t["type"] for t in pathways.start_tasks("SURVIVORSHIP", facts={"total_gastrectomy": True, "advanced": True})}
    assert {"B12_INJECTION", "SURVEILLANCE_IMAGING"} <= full  # B12 after total gastrectomy, CT only when advanced


def test_palliative_pain_review_every_2_weeks():
    occ = pathways.occurrences(pathways.task_spec("PALLIATIVE_SUPPORT", "PAIN_REVIEW"))
    assert occ[0] == 14 and all(b - a == 14 for a, b in zip(occ, occ[1:]))


def test_public_shape():
    p = pathways.public("ENDOSCOPY_REFERRAL")
    assert set(p) >= {"id", "name", "description", "triggers", "tasks", "default_channels"}
    assert set(p["tasks"][0]) >= {"type", "title", "due_days"}
