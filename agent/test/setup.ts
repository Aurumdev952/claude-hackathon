/** Every test file runs against the fixture DB, an in-memory chat DB and temp artifact dirs (never the real data). */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURE_DB } from "./fixtures/build-duck.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "es-agent-test-"));
process.env.AGENT_SERVE_DB = FIXTURE_DB;
process.env.AGENT_DB_PATH = path.join(tmp, "agent.sqlite");
process.env.AGENT_ARTIFACTS_DIR = path.join(tmp, "artifacts");
process.env.AGENT_SANDBOX_WORK_DIR = path.join(tmp, "sandbox");
process.env.AGENT_APP_STATE = path.join(tmp, "app_state.sqlite");
process.env.SANDBOX_TIMEOUT_S = "20";
// the mock model stands in for the provider; pin a provider so the repo .env (e.g. AGENT_PROVIDER=anthropic) cannot leak in
process.env.AGENT_PROVIDER = "openrouter";
process.env.AGENT_MODEL = "test/model";
