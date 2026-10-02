"""Track U3: daily report care / forecast blocks, snapshot back-compat, verified care outcomes in /validate-risk."""
from __future__ import annotations

import copy
import datetime as dt
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "scripts")]

import report_data as RD  # noqa: E402

pytest.importorskip("reportlab")
pytest.importorskip("pypdf")
import daily_report as DR  # noqa: E402
import risk_validation as RV  # noqa: E402

SNAP = json.loads((ROOT / "reports" / "snapshots" / "latest.json").read_text())


def _render(snap: dict, out: Path) -> dict:
    model = DR.build_model(snap, "snapshot", dt.date(2026, 10, 2), None, [])
    DR.render(model, out)
    assert DR.check_pdf(out) == 0
    return model


def test_committed_snapshot_has_care_and_forecast():
    assert SNAP["schema"] >= 2
    care, fc = SNAP["care"], SNAP["forecast"]
    for k in ("new_plans_7d", "overdue_tasks", "completion_rate_pct", "median_days_to_endoscopy", "plans_active"):
        assert k in care
    assert fc["lo95"] <= fc["lo80"] <= fc["mean"] <= fc["hi80"] <= fc["hi95"]
    assert fc["horizon_year"] >= 2030
    blob = json.dumps(SNAP)
    assert "given_name" not in blob and "family_name" not in blob


def test_snapshot_report_is_one_page_with_care_block(tmp_path):
    model = _render(SNAP, tmp_path / "r.pdf")
    assert model["care"] and model["forecast"]
    assert any(h.startswith("Care coordination") for h in model["highlights"])


def test_schema1_snapshot_still_renders(tmp_path):
    old = copy.deepcopy(SNAP)
    old.pop("care"), old.pop("forecast")
    old["schema"] = 1
    model = _render(old, tmp_path / "old.pdf")
    assert model["care"] is None and model["forecast"] is None


@pytest.fixture(scope="module")
def live():
    con, cur = RD.connect()
    if con is None:
        pytest.skip("no published serve DB (set DATA_DIR=data/next)")
    yield con, cur
    con.close()


def test_live_snapshot_blocks(live):
    con, cur = live
    snap = RD.build_snapshot(con, cur)
    if snap.get("care") is None:
        pytest.skip("care snapshot not published in this dataset")
    c = snap["care"]
    assert c["overdue_tasks"] <= c["open_tasks"]
    assert c["completed_tasks"] <= c["due_or_done_tasks"]
    if c["completion_rate_pct"] is not None:
        assert 0 <= c["completion_rate_pct"] <= 100


def test_validate_risk_bundle_has_verified_care_outcomes(live):
    con, cur = live
    if not RD.has_table(con, "pt_care_task"):
        pytest.skip("care snapshot not published in this dataset")
    types = ",".join(f"'{t}'" for t in RV.CARE_EVIDENCE_TASKS)
    pid = RD.one(con, f"""SELECT patient_id FROM pt_care_task WHERE status = 'COMPLETED' AND result IS NOT NULL AND type IN ({types})
                          ORDER BY plan_id LIMIT 1""")
    if not pid:
        pytest.skip("no completed care task with a result yet")
    out = RV._care_outcomes(con, pid["patient_id"])
    assert out["plans"] and out["verified_results"]
    assert all(v["result"] for v in out["verified_results"])
    assert "patient_id" not in json.dumps(out) and "given_name" not in json.dumps(out)
