"""python -m generator.load  — (re)load an already generated dataset into MySQL."""
from shared.config import BULK_DIR, generator_cfg

from .facilities import build_facilities
from .loader import load_all
from .reference_tables import build as build_reference

if __name__ == "__main__":
    cfg = generator_cfg()
    import json
    from shared.config import DATA_DIR
    gt = json.load(open(DATA_DIR / "ground_truth.json"))
    facs = build_facilities(cfg, int(gt["seed"]))
    load_all(BULK_DIR, build_reference(facs), log=lambda s: print(s, flush=True))
