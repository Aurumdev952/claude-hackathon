#!/bin/bash
# SessionStart hook for Claude Code on the web (cloud sessions only; local sessions are left alone).
# Installs the Python env used by /validate-risk and /daily-report and exports PYTHONPATH=. for the session.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if command -v uv >/dev/null 2>&1; then
  # idempotent; the container is cached after the hook, so later sessions are a quick no-op
  uv sync --inexact --extra dev --extra report >&2   # --inexact: keep extras other sessions installed (eval, llm, dl)
else
  echo "session-start: uv not found; install it (https://docs.astral.sh/uv/) to run the report scripts" >&2
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  grep -qs '^export PYTHONPATH=' "$CLAUDE_ENV_FILE" || echo 'export PYTHONPATH=.' >> "$CLAUDE_ENV_FILE"
fi
exit 0
