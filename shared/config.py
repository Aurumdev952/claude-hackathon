"""Shared config + path helpers (env overrides YAML)."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def _env_path(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    p = Path(v) if v else default
    return p if p.is_absolute() else (ROOT / p)


DATA_DIR = _env_path("DATA_DIR", ROOT / "data")
CONFIG_DIR = _env_path("CONFIG_DIR", ROOT / "config")
REF_DIR = DATA_DIR / "reference"
BULK_DIR = DATA_DIR / "bulk"
LATENT_DIR = BULK_DIR / "latent"
ANALYTICS_DIR = DATA_DIR / "analytics"
MODELS_DIR = DATA_DIR / "models"
SIM_STATE_DIR = DATA_DIR / "sim_state"


@lru_cache(maxsize=None)
def load_yaml(name: str) -> dict:
    path = CONFIG_DIR / name if not name.startswith("/") else Path(name)
    with open(path) as f:
        return yaml.safe_load(f)


def generator_cfg() -> dict:
    cfg = dict(load_yaml("generator.yaml"))
    if os.environ.get("SCALE"):
        cfg["scale"] = float(os.environ["SCALE"])
    if os.environ.get("SEED"):
        cfg["seed"] = int(os.environ["SEED"])
    return cfg


def pipeline_cfg() -> dict:
    return load_yaml("pipeline.yaml")


def models_cfg() -> dict:
    return load_yaml("models.yaml")


def llm_cfg() -> dict:
    cfg = dict(load_yaml("llm.yaml"))
    cfg["provider"] = os.environ.get("LLM_PROVIDER", cfg.get("provider", "template"))
    return cfg


def body_map() -> dict:
    return load_yaml("body_map.yaml")


def mysql_params(database: str | None = "openmrs") -> dict:
    p = {
        "host": os.environ.get("MYSQL_HOST", "127.0.0.1"),
        "port": int(os.environ.get("MYSQL_PORT", "3306")),
        "user": os.environ.get("MYSQL_USER", "root"),
        "password": os.environ.get("MYSQL_ROOT_PASSWORD", os.environ.get("MYSQL_PASSWORD", "change_me")),
    }
    if database:
        p["database"] = database
    return p
