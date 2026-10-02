"""pytest wiring for the DeepEval gate (`make eval-agent`).

- Not collected by `make test` (pyproject testpaths = ["tests"]) and marked `llm`.
- Loads ../../.env without overriding the environment (OPENROUTER_API_KEY, AGENT_URL, EVAL_JUDGE_MODEL).
- Live preflight: agent /agent/health and the OpenRouter key's remaining credit. When either is unavailable the
  suite is skipped - unless EVAL_REQUIRE_AGENT=1 (set by `make eval-agent`), then it FAILS: an agent that cannot be
  evaluated is not ready. A judge that becomes unavailable mid-run (401/402/403) aborts the run and fails it.
- EVAL_OFFLINE=1 replays fixtures/responses.json (real recorded answers) with the deterministic checks only; the
  readiness test is skipped because no verdict is possible without the judge.
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
    """One evaluation per session. Live: preflight (agent health + OpenRouter key credit) then agent + judge.
    EVAL_OFFLINE=1: replay fixtures/responses.json with the deterministic checks only."""
    from evals.agent.runner import EvalAborted, offline, run_eval

    if offline():
        return run_eval()
    required = os.getenv("EVAL_REQUIRE_AGENT", "").lower() in ("1", "true", "yes")
    try:
        res = run_eval()
    except EvalAborted as e:
        if required:
            pytest.fail(f"EVAL ABORTED - cannot evaluate the agent: {e}", pytrace=False)
        pytest.skip(f"cannot evaluate the agent: {e}")
    if res["meta"].get("aborted"):
        pytest.fail(f"EVAL ABORTED - {res['meta']['aborted']} (partial report: {res.get('paths', {}).get('md')})", pytrace=False)
    return res
