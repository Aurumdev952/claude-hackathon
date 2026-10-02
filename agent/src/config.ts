/** Runtime configuration: ../.env (repo root) and agent/.env are loaded into process.env, process env wins. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

function findAgentRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "src", "widgets"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const AGENT_ROOT = findAgentRoot();
export const REPO_ROOT = path.resolve(AGENT_ROOT, "..");

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  // dotenv never overrides variables that are already set in the process environment
  for (const f of [path.join(AGENT_ROOT, ".env"), path.join(REPO_ROOT, ".env")]) {
    if (existsSync(f)) dotenv.config({ path: f, quiet: true });
  }
}

function fromRepo(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

export type Provider = "openrouter" | "openai-compatible";

export interface Config {
  port: number;
  provider: Provider;
  model: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  dataDir: string;
  analyticsDir: string;
  /** Explicit serve DB file (tests / fixtures); otherwise follows <analyticsDir>/current.json like api/deps.py */
  serveDbPath: string | undefined;
  appStatePath: string;
  semanticLayerPath: string;
  dbPath: string;
  artifactsDir: string;
  sandboxDir: string;
  sandboxWorkDir: string;
  sandboxTimeoutS: number;
  sandboxMemMb: number;
  maxSteps: number;
  queryTimeoutMs: number;
  fastApiUrl: string;
  /** Video render server (video/, Remotion + Hono); create_video posts jobs here. */
  videoUrl: string;
  /** Timeout for calls to the FastAPI / video server (care preview, worklist, scenarios, video jobs). */
  upstreamTimeoutMs: number;
}

export function loadConfig(): Config {
  loadEnv();
  const e = process.env;
  const dataDir = fromRepo(e.DATA_DIR || "data");
  const analyticsDir = e.AGENT_ANALYTICS_DIR ? fromRepo(e.AGENT_ANALYTICS_DIR) : path.join(dataDir, "analytics");
  const provider = (e.AGENT_PROVIDER || "openrouter").toLowerCase() === "openai-compatible" ? "openai-compatible" : "openrouter";
  return {
    port: num(e.AGENT_PORT, 8787),
    provider,
    model: e.AGENT_MODEL || "deepseek/deepseek-v4.1-flash",
    baseUrl: e.AGENT_BASE_URL || undefined,
    apiKey: provider === "openrouter" ? e.OPENROUTER_API_KEY : e.AGENT_API_KEY || e.OPENROUTER_API_KEY,
    dataDir,
    analyticsDir,
    serveDbPath: e.AGENT_SERVE_DB ? fromRepo(e.AGENT_SERVE_DB) : undefined,
    appStatePath: e.AGENT_APP_STATE ? fromRepo(e.AGENT_APP_STATE) : path.join(analyticsDir, "app_state.sqlite"),
    semanticLayerPath: fromRepo(e.SEMANTIC_LAYER_PATH || "api/llm/semantic_layer.yaml"),
    dbPath: fromRepo(e.AGENT_DB_PATH || "agent/data/agent.sqlite"),
    artifactsDir: fromRepo(e.AGENT_ARTIFACTS_DIR || "agent/data/artifacts"),
    sandboxDir: path.join(AGENT_ROOT, "sandbox"),
    sandboxWorkDir: fromRepo(e.AGENT_SANDBOX_WORK_DIR || "agent/data/sandbox"),
    sandboxTimeoutS: num(e.SANDBOX_TIMEOUT_S, 30),
    sandboxMemMb: num(e.SANDBOX_MEM_MB, 2048),
    maxSteps: num(e.AGENT_MAX_STEPS, 8),
    queryTimeoutMs: num(e.AGENT_QUERY_TIMEOUT_MS, 5000),
    fastApiUrl: e.API_URL || "http://localhost:8000",
    videoUrl: e.VIDEO_URL || "http://127.0.0.1:8790",
    upstreamTimeoutMs: num(e.AGENT_UPSTREAM_TIMEOUT_MS, 8000),
  };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
/** Tests override env then call this to rebuild the singleton. */
export function resetConfig(): void {
  cached = undefined;
}
