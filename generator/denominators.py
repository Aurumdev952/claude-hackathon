"""python -m generator.denominators — rebuild district_population.csv from the latent persons table."""
import polars as pl

from shared.config import LATENT_DIR, REF_DIR
from shared.geo import DISTRICT_CODES

from .context import SIM_END
from .ground_truth import denominators

if __name__ == "__main__":
    lp = pl.read_parquet(LATENT_DIR / "persons.parquet")
    idx = {k: i for i, k in enumerate(DISTRICT_CODES)}
    P = {"birth": lp["birth_day"].to_numpy(), "emr_start": lp["emr_start"].to_numpy(), "move_day": lp["move_day"].to_numpy(),
         "district_idx": lp["district_code"].replace_strict(idx).to_numpy(),
         "district2_idx": lp["district2_code"].replace_strict(idx).to_numpy(),
         "sex": (lp["sex"] == "M").cast(pl.Int8).to_numpy()}
    denominators(P, lp["death_day"].to_numpy(), SIM_END).write_csv(REF_DIR / "district_population.csv")
    print("district_population.csv rebuilt")
