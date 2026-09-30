"""One-off geo preprocessing (SPEC §5.3).

Input: geoBoundaries RWA ADM1/ADM2/ADM3 (data/reference/geo_raw/*.geojson, CC BY 4.0).
Output:
  frontend/public/geo/{districts,provinces}.geojson  (simplified, with our codes)
  data/reference/district_adjacency.json              (queen contiguity + centroids)
  data/reference/sectors.json                         (sector -> district, centroid, simplified polygon)
"""
from __future__ import annotations

import json
import unicodedata

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from shared.config import REF_DIR, ROOT
from shared.geo import DISTRICTS, NAME_TO_CODE, PROVINCES

RAW = REF_DIR / "geo_raw"
OUT_FE = ROOT / "frontend" / "public" / "geo"

PROV_NAME_TO_CODE = {"city of kigali": "KGL", "kigali city": "KGL", "northern province": "NOR", "southern province": "SOU",
                     "eastern province": "EAS", "western province": "WES"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().strip()
    return s


def load(level: str):
    return json.load(open(RAW / f"rwa_{level}.geojson"))["features"]


def round_coords(geom, nd=4):
    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


def main() -> None:
    OUT_FE.mkdir(parents=True, exist_ok=True)
    districts = {}
    for f in load("ADM2"):
        code = NAME_TO_CODE.get(norm(f["properties"]["shapeName"]))
        if not code:
            raise SystemExit(f"Unmatched district {f['properties']['shapeName']}")
        districts[code] = shape(f["geometry"]).buffer(0)
    missing = set(DISTRICTS) - set(districts)
    assert not missing, missing

    feats = []
    for code, g in districts.items():
        prov, name, _ = DISTRICTS[code]
        simp = g.simplify(0.002, preserve_topology=True)
        c = g.representative_point()
        feats.append({"type": "Feature", "properties": {"district_code": code, "name": name, "province_code": prov,
                                                         "province": PROVINCES[prov], "centroid": [round(c.x, 4), round(c.y, 4)]},
                      "geometry": round_coords(simp)})
    json.dump({"type": "FeatureCollection", "features": feats}, open(OUT_FE / "districts.geojson", "w"))

    pfeats = []
    for f in load("ADM1"):
        pc = PROV_NAME_TO_CODE[norm(f["properties"]["shapeName"])]
        g = shape(f["geometry"]).buffer(0).simplify(0.003, preserve_topology=True)
        c = g.representative_point()
        pfeats.append({"type": "Feature", "properties": {"province_code": pc, "name": PROVINCES[pc], "centroid": [round(c.x, 4), round(c.y, 4)]},
                       "geometry": round_coords(g)})
    json.dump({"type": "FeatureCollection", "features": pfeats}, open(OUT_FE / "provinces.geojson", "w"))

    # queen adjacency: touching or overlapping after tiny buffer
    adj = {}
    buf = {k: v.buffer(0.0015) for k, v in districts.items()}
    for a in districts:
        adj[a] = sorted(b for b in districts if b != a and buf[a].intersects(districts[b]))
    cents = {k: [round(v.representative_point().x, 5), round(v.representative_point().y, 5)] for k, v in districts.items()}
    bounds = {k: list(v.bounds) for k, v in districts.items()}
    json.dump({"adjacency": adj, "centroids": cents, "bounds": bounds}, open(REF_DIR / "district_adjacency.json", "w"), indent=1)

    sectors = []
    for f in load("ADM3"):
        g = shape(f["geometry"]).buffer(0)
        p = g.representative_point()
        code = next((k for k, d in districts.items() if d.contains(p)), None)
        if code is None:
            code = min(districts, key=lambda k: districts[k].distance(p))
        sectors.append({"sector": f["properties"]["shapeName"], "district_code": code,
                        "centroid": [round(p.x, 5), round(p.y, 5)], "area": g.area,
                        "geometry": round_coords(g.simplify(0.001, preserve_topology=True), 5)})
    json.dump(sectors, open(REF_DIR / "sectors.json", "w"))
    country = unary_union(list(districts.values()))
    print(f"districts={len(feats)} provinces={len(pfeats)} sectors={len(sectors)} bounds={country.bounds}")


if __name__ == "__main__":
    main()
