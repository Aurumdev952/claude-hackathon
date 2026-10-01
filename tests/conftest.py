import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shared.config import BULK_DIR, DATA_DIR  # noqa: E402


@pytest.fixture(scope="session")
def ground_truth():
    p = DATA_DIR / "ground_truth.json"
    if not p.exists():
        pytest.skip("no generated dataset (run `make seed`)")
    return json.load(open(p))


@pytest.fixture(scope="session")
def scale(ground_truth):
    return float(ground_truth["scale"])


@pytest.fixture(scope="session")
def bulk_con():
    import duckdb
    if not (BULK_DIR / "parquet" / "obs").exists():
        pytest.skip("no generated dataset")
    con = duckdb.connect()
    for t in ("obs", "encounter", "orders", "person", "visit", "location_ext", "patient_identifier", "person_address"):
        con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{(BULK_DIR / 'parquet' / t).as_posix()}/*.parquet')")
    return con
