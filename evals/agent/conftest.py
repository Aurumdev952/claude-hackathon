"""pytest wiring for the DeepEval gate (`make eval-agent`).

- Not collected by `make test` (pyproject testpaths = ["tests"]) and marked `llm`.
- Loads ../../.env without overriding the environment (OPENROUTER_API_KEY, AGENT_URL, EVAL_JUDGE_MODEL).
- Skips when the agent (AGENT_URL) or the judge key is unavailable - unless EVAL_REQUIRE_AGENT=1 (set by
  `make eval-agent`), in which case the run fails: an agent that cannot be evaluated is not ready.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "1")
os.environ.setdefault("DEEPEVAL_DISABLE_DOTENV", "1")
os.environ.setdefault("DEEPEVAL_GRPC_LOGGING", "0")
os.environ.setdefault("ERROR_REPORTING", "0")


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip().removeprefix("export ").strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv(ROOT / ".env")


def pytest_collection_modifyitems(config, items):
    for item in items:
        if "evals/agent" in str(item.fspath):
            item.add_marker(pytest.mark.llm)


@pytest.fixture(scope="session")
def eval_results():
    from evals.agent import client
    from evals.agent.runner import run_eval

    required = os.getenv("EVAL_REQUIRE_AGENT", "").lower() in ("1", "true", "yes")
    problems = []
    if not os.getenv("OPENROUTER_API_KEY"):
        problems.append("OPENROUTER_API_KEY is not set (judge model)")
    if not os.getenv("EVAL_REUSE_RESPONSES") and client.health() is None:
        problems.append(f"agent not reachable at {client.agent_url()} (start it: make agent-dev)")
    if problems:
        msg = "; ".join(problems)
        if required:
            pytest.fail(f"cannot evaluate the agent: {msg}", pytrace=False)
        pytest.skip(msg)
    return run_eval()
