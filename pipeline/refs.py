"""Reference tables loaded into work.duckdb from data/reference (denominators, WHO std pop, geography, facilities)."""
from __future__ import annotations

import unicodedata

import polars as pl

from shared.config import DATA_DIR, REF_DIR
from shared.geo import AGE_GROUPS, DISTRICTS, PROVINCES, WHO_STD


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().strip()


EXTERNAL = {"ext_registry": "registry_incidence.parquet", "ext_surveys": "risk_factor_surveys.parquet",
            "ext_population": "population_projections.parquet"}


def load_external(con, ext_dir=None) -> list[str]:
    """v3 external synthetic sources (generator/external, `make external-data`) -> ext_registry, ext_surveys,
    ext_population. A missing file is skipped (the table, if any, is left as it is)."""
    ext_dir = ext_dir or (DATA_DIR / "external")
    loaded = []
    for tbl, fname in EXTERNAL.items():
        f = ext_dir / fname
        if f.exists():
            con.execute(f"CREATE OR REPLACE TABLE {tbl} AS SELECT * FROM read_parquet('{f.as_posix()}')")
            loaded.append(tbl)
    return loaded


def load_refs(con):
    dist = pl.DataFrame([{"district_code": k, "province_code": v[0], "name": v[1], "name_norm": _norm(v[1]),
                          "province": PROVINCES[v[0]]} for k, v in DISTRICTS.items()])
    con.register("_d", dist.to_arrow())
    con.execute("CREATE OR REPLACE TABLE ref_district AS SELECT * FROM _d")
    con.execute("CREATE OR REPLACE TABLE ref_province AS SELECT * FROM (VALUES "
                + ",".join(f"('{k}', '{v}')" for k, v in PROVINCES.items()) + ") t(province_code, name)")
    w = pl.DataFrame({"age_group": AGE_GROUPS, "age_index": list(range(18)), "weight": [x / sum(WHO_STD) for x in WHO_STD]})
    con.register("_w", w.to_arrow())
    con.execute("CREATE OR REPLACE TABLE core_ref_who_std AS SELECT * FROM _w")
    con.execute(f"""CREATE OR REPLACE TABLE core_ref_population AS
                    SELECT p.*, w.age_index FROM read_csv_auto('{(REF_DIR / 'district_population.csv').as_posix()}') p
                    JOIN core_ref_who_std w USING (age_group)""")
    con.execute(f"CREATE OR REPLACE TABLE ref_facility AS SELECT location_id, CAST(go_live_date AS DATE) AS go_live_date, "
                f"CAST(endoscopy_from_date AS DATE) AS endoscopy_from_date, catchment_weight, hb_gL "
                f"FROM read_csv_auto('{(REF_DIR / 'facilities.csv').as_posix()}')")
    con.execute(f"""CREATE OR REPLACE TABLE core_facility_events AS
                    SELECT location_id, CAST(event_date AS DATE) AS event_date, event_type, description
                    FROM read_csv_auto('{(REF_DIR / 'facility_events.csv').as_posix()}')""")
    load_external(con)
