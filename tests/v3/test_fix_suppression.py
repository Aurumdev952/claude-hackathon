"""F1 #5 / #6: ministry care aggregates cannot be back-calculated (complementary suppression, derived values)."""
from __future__ import annotations

from api.suppress import small, suppress_breakdowns, suppress_group

F = ("approved", "cancer_found")


def _recoverable(total, cells):
    """A hidden cell is recoverable when it is the only hidden cell of a column whose total is shown."""
    hidden = [c for c in cells if c is None]
    return total is not None and len(hidden) == 1


def test_lone_hidden_district_gets_a_partner():
    rows = [{"district_code": "NOR-MUS", "approved": 5, "cancer_found": 0},
            {"district_code": "EAS-KAY", "approved": 3, "cancer_found": 0}]
    tot, (by_d,) = suppress_breakdowns({"approved": 8, "cancer_found": 0}, [rows], F)
    assert tot["approved"] == 8
    assert [r["approved"] for r in by_d] == [None, None]     # 8 - 5 no longer gives 3
    assert by_d[1]["approved_label"] == "<5" and by_d[0]["approved_label"] == "suppressed"
    assert [r["cancer_found"] for r in by_d] == [0, 0]      # zeros stay


def test_next_smallest_cell_is_the_partner_and_no_column_is_recoverable():
    rows = [{"k": "A", "approved": 40}, {"k": "B", "approved": 2}, {"k": "C", "approved": 9}, {"k": "D", "approved": 12}]
    tot, (out,) = suppress_breakdowns({"approved": 63}, [rows], ("approved",))
    assert [r["approved"] for r in out] == [40, None, None, 12]
    assert not _recoverable(tot["approved"], [r["approved"] for r in out])


def test_without_a_partner_the_total_is_hidden():
    rows = [{"k": "A", "approved": 3}, {"k": "B", "approved": 0}]
    tot, (out,) = suppress_breakdowns({"approved": 3}, [rows], ("approved",))
    assert tot["approved"] is None and out[0]["approved"] is None and out[1]["approved"] == 0


def test_two_breakdowns_of_one_total_are_consistent():
    d = [{"d": "X", "approved": 10, "cancer_found": 6}, {"d": "Y", "approved": 7, "cancer_found": 0}]
    p = [{"p": "ENDO", "approved": 15, "cancer_found": 5}, {"p": "HP", "approved": 2, "cancer_found": 1}]
    tot, (bd, bp) = suppress_breakdowns({"approved": 17, "cancer_found": 6}, [d, p], F)
    for col in F:
        for rows in (bd, bp):
            assert not _recoverable(tot[col], [r[col] for r in rows]), (col, rows, tot)
        for rows in (bd, bp):
            assert all(v is None or not small(v) for v in [r[col] for r in rows])


def test_complement_inside_a_row_and_derived_values():
    rows = [{"level": "APP", "n": 9, "adhered": 7, "rate": 0.778, "median_days": 12.0},   # 2 did not adhere
            {"level": "SMS", "n": 30, "adhered": 20, "rate": 0.667, "median_days": 9.0},
            {"level": "CHW", "n": 4, "adhered": 4, "rate": 1.0, "median_days": 5.0}]
    out, _ = suppress_group(rows, ("n", "adhered"), base="n", pairs=(("adhered", "n"),),
                            derived={"rate": ("n", "adhered"), "median_days": ("n", "adhered")})
    app, sms, chw = out
    assert app["adhered"] is None and app["adhered_label"] == "suppressed" and app["rate"] is None and app["median_days"] is None
    assert chw["n"] is None and chw["adhered"] is None and chw["rate"] is None
    # n: CHW hidden (4) alone in the column -> the next-smallest (APP 9) is hidden too; adhered: APP + CHW hidden
    assert app["n"] is None or sms["n"] is None
    assert sum(r["n"] is None for r in out) >= 2 and sum(r["adhered"] is None for r in out) >= 2


def test_survival_hidden_when_its_denominator_or_deaths_are_small():
    rows = [{"route": "care_pathway", "n": 12, "n_surv_eligible": 4, "surv_1y": 0.75, "n_dead_1y": 1},
            {"route": "usual", "n": 300, "n_surv_eligible": 250, "surv_1y": 0.4, "n_dead_1y": 150}]
    for x in rows:
        x["_alive"] = x["n_surv_eligible"] - x["n_dead_1y"]
    out, _ = suppress_group(rows, ("n", "n_surv_eligible"), derived={"surv_1y": ("n_dead_1y", "_alive")})
    assert out[0]["n_surv_eligible"] is None and out[0]["surv_1y"] is None
    assert out[1]["n_surv_eligible"] is None              # complementary partner of the hidden cell
    assert out[1]["surv_1y"] == 0.4                       # its own counts are large: the rate reveals no small cell
    rows[1]["n_dead_1y"], rows[1]["_alive"] = 247, 3          # ... unless the survivors (the complement) are few
    out, _ = suppress_group(rows, ("n", "n_surv_eligible"), derived={"surv_1y": ("n_dead_1y", "_alive")})
    assert out[1]["surv_1y"] is None


# ---------------------------------------------------------------------------------------------------- the endpoints
import duckdb  # noqa: E402
import pytest  # noqa: E402


@pytest.fixture()
def ministry_api(tmp_path):
    from fastapi.testclient import TestClient

    from api.deps import SERVE
    from api.main import app
    path = tmp_path / "serve.duckdb"
    con = duckdb.connect(str(path))
    con.execute("""CREATE TABLE mart_care_funnel AS SELECT * FROM (VALUES
        (DATE '2026-07-01', 'NOR-MUS', 'ENDOSCOPY_REFERRAL', 12, 5, 5, 4, 4, 0, 0),
        (DATE '2026-07-01', 'EAS-KAY', 'ENDOSCOPY_REFERRAL', 9, 3, 3, 2, 2, 0, 0))
        t(period, district_code, pathway, flagged, approved, notified, attended, endoscopy, cancer_found, early_stage)""")
    con.execute("""CREATE TABLE mart_care_adherence AS SELECT * FROM (VALUES
        ('channel', 'APP', 9, 7, 0.778, 12.0), ('channel', 'SMS', 30, 20, 0.667, 9.0), ('channel', 'CHW', 4, 4, 1.0, 5.0))
        t(dim, level, n, adhered, rate, median_days)""")
    con.execute("""CREATE TABLE mart_care_impact AS SELECT * FROM (VALUES
        ('care_pathway', 6, 50.0, 0.75, 4, 'Synthetic', 6, 3, 1), ('usual', 300, 22.0, 0.4, 250, 'Synthetic', 280, 62, 150))
        t(route, n, early_stage_pct, surv_1y, n_surv_eligible, note, n_staged, n_early, n_dead_1y)""")
    con.close()
    saved = (SERVE._con, SERVE.current, SERVE._cache)
    SERVE._con = duckdb.connect(str(path), read_only=True)
    SERVE.current, SERVE._cache = {"run_id": -3, "active": "test"}, {}
    yield TestClient(app)
    SERVE._con.close()
    SERVE._con, SERVE.current, SERVE._cache = saved


def test_funnel_totals_do_not_reveal_a_district(ministry_api):
    d = ministry_api.get("/api/v1/care/funnel").json()["data"]
    steps = {s["step"]: s for s in d["steps"]}
    assert steps["approved"]["n"] == 8
    by = {r["district_code"]: r for r in d["by_district"]}
    assert by["EAS-KAY"]["approved"] is None and by["NOR-MUS"]["approved"] is None   # 8 - 5 = 3 is gone
    for col in ("approved", "notified", "attended", "endoscopy"):
        cells = [r[col] for r in d["by_district"]]
        assert steps[col]["n"] is None or sum(c is None for c in cells) != 1, col
    path = d["by_pathway"][0]
    assert path["approved"] == 8   # the pathway breakdown is a single row equal to the (shown) total


def test_adherence_and_impact_endpoints(ministry_api):
    rows = {r["level"]: r for r in ministry_api.get("/api/v1/care/adherence?by=channel").json()["data"]}
    assert rows["APP"]["adhered"] is None and rows["APP"]["rate"] is None      # 9 - 7 = 2 did not adhere
    assert rows["CHW"]["n"] is None and rows["CHW"]["rate"] is None
    imp = {r["route"]: r for r in ministry_api.get("/api/v1/care/impact").json()["data"]}
    cp = imp["care_pathway"]
    assert cp["n_surv_eligible"] is None and cp["surv_1y"] is None and cp["early_stage_pct"] is None  # 3 early, 1 death
    assert "n_dead_1y" not in cp and "n_staged" not in cp
    assert imp["usual"]["surv_1y"] == 0.4 and imp["usual"]["early_stage_pct"] == 22.0
