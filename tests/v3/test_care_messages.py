"""Notification wording: plain advice, no diagnosis words, no names (contract §4.1, track L2)."""
from __future__ import annotations

import itertools

import pytest

from care import messages, pathways


def _texts(node):
    if isinstance(node, dict):
        for v in node.values():
            yield from _texts(v)
    elif isinstance(node, str):
        yield node


def test_catalogue_has_no_forbidden_words():
    cat = messages.catalogue()
    hits = [(t, messages.forbidden_hits(t)) for t in _texts(cat) if messages.forbidden_hits(t)]
    assert not hits


def test_bodies_never_carry_a_name():
    cat = messages.catalogue()
    for scope, tasks in cat.items():
        if scope == "greeting":
            continue
        for t in _texts(tasks):
            assert "{first_name}" not in t and "given_name" not in t


def test_forbidden_detector_works():
    assert messages.forbidden_hits("Your biopsy result shows a Tumour") == ["tumour", "biopsy result"]
    assert messages.forbidden_hits("Please visit the clinic") == []


@pytest.mark.parametrize("pid", list(pathways.pathways()))
def test_every_rendered_message_is_clean(pid):
    pw = pathways.pathway(pid)
    for t, stage, ch in itertools.product(pw["tasks"], messages.STAGES, ("APP", "SMS", "CHW")):
        m = messages.render(pid, t["type"], stage, ch, task_title=t["title"], facility="Kayonza District Hospital (Synthetic)",
                            date="2026-07-30T00:00:00", display_id="KAY-0001274A")
        for text in (m["title"], m["body"]):
            assert not messages.forbidden_hits(text), (pid, t["type"], stage, ch, text)
            assert "{" not in text and "}" not in text, text
        if ch == "SMS" and pathways.patient_facing(pid, t["type"]):
            assert len(m["body"]) <= 160, m["body"]  # one SMS segment
        if ch == "CHW":
            assert "KAY-0001274A" in m["body"]  # CHW messages address the patient by display id only


def test_task_titles_are_patient_safe():
    for pid, pw in pathways.pathways().items():
        assert not messages.forbidden_hits(pw["name"])
        for t in pw["tasks"]:
            assert not messages.forbidden_hits(t["title"]), (pid, t["title"])


def test_greeting_only_in_app():
    assert messages.greeting("Aline") == "Hi Aline,"
    m = messages.render("ENDOSCOPY_REFERRAL", "ENDOSCOPY", "approved", "SMS", task_title="Upper GI endoscopy",
                        facility="X (Synthetic)", date="2026-07-30T00:00:00")
    assert "Aline" not in m["body"] and "30 July 2026" in m["body"]
