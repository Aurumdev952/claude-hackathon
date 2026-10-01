/**
 * Python visualisation sandbox (plan B6). Each run gets agent/data/sandbox/<run>/ with script.py + data.json, and executes
 *   [unshare -n|-rn] prlimit --as=<mem> --cpu=<s> timeout -s KILL <s> <venv python> -I -B prelude.py <run dir>
 * with a scrubbed environment (no proxy variables, no API keys). Artifacts are moved to AGENT_ARTIFACTS_DIR/<run>/ and served
 * by GET /agent/artifacts/:run/:file. Old runs are removed after 7 days.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_ROOT, config } from "../config.js";
import type { ArtifactFile, ArtifactSpec } from "../widgets/specs.js";

export interface SandboxCaps {
  python: string | null;
  viaUv: boolean;
  unshare: string[] | null;
  prlimit: boolean;
  timeout: boolean;
  ready: boolean;
}

let caps: SandboxCaps | null = null;

function works(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Feature detection (cached): venv python, unshare flavour, prlimit and timeout availability. */
export function sandboxCaps(refresh = false): SandboxCaps {
  if (caps && !refresh) return caps;
  const cfg = config();
  const venvPy = path.join(cfg.sandboxDir, ".venv", "bin", "python");
  let python: string | null = existsSync(venvPy) ? venvPy : null;
  let viaUv = false;
  if (!python && works("uv", ["--version"])) {
    python = "uv";
    viaUv = true;
  }
  let unshare: string[] | null = null;
  if (works("unshare", ["-n", "true"])) unshare = ["unshare", "-n"];
  else if (works("unshare", ["-rn", "true"])) unshare = ["unshare", "-rn"];
  caps = { python, viaUv, unshare, prlimit: works("prlimit", ["--version"]), timeout: works("timeout", ["--version"]), ready: !!python };
  return caps;
}

export const PRELUDE = path.join(AGENT_ROOT, "src", "sandbox", "prelude.py");

function scrubbedEnv(runDir: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: runDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    MPLBACKEND: "Agg",
    MPLCONFIGDIR: path.join(runDir, ".mpl"),
    XDG_CACHE_HOME: path.join(runDir, ".cache"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHASHSEED: "0",
    OPENBLAS_NUM_THREADS: "1",
    OMP_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
  };
}

/** Builds the isolated command line around `argv` (exported for tests). */
export function wrapCommand(argv: string[], opts: { timeoutS: number; memMb: number }): string[] {
  const c = sandboxCaps();
  const cmd: string[] = [];
  if (c.unshare) cmd.push(...c.unshare);
  if (c.prlimit) cmd.push("prlimit", `--as=${opts.memMb * 1024 * 1024}`, `--cpu=${Math.max(2, opts.timeoutS)}`, `--core=0`, `--fsize=${200 * 1024 * 1024}`);
  if (c.timeout) cmd.push("timeout", "-s", "KILL", String(opts.timeoutS));
  cmd.push(...argv);
  return cmd;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

const CAP = 20_000;

/** Runs an argv inside the sandbox wrapper with a scrubbed env (used by run_python and by the isolation tests). */
export function spawnSandboxed(argv: string[], opts: { cwd: string; timeoutS?: number; memMb?: number }): Promise<SpawnResult> {
  const cfg = config();
  const timeoutS = opts.timeoutS ?? cfg.sandboxTimeoutS;
  const memMb = opts.memMb ?? cfg.sandboxMemMb;
  const cmd = wrapCommand(argv, { timeoutS, memMb });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: scrubbedEnv(opts.cwd), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let hardKilled = false;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < CAP) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < CAP) stderr += d.toString("utf8"); });
    // belt and braces: if `timeout` is unavailable or the tree survives, kill the whole process group
    const guard = setTimeout(() => {
      hardKilled = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, (timeoutS + 5) * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      const ms = Date.now() - t0;
      const timedOut = hardKilled || code === 137 || signal === "SIGKILL" || (code === 124) || ms >= timeoutS * 1000;
      resolve({ code, signal, stdout: stdout.slice(0, CAP), stderr: stderr.slice(0, CAP), timedOut, ms });
    });
    child.on("error", (e) => {
      clearTimeout(guard);
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n${e.message}`, timedOut: false, ms: Date.now() - t0 });
    });
  });
}

const MIME: Record<string, [string, ArtifactFile["kind"]]> = {
  ".png": ["image/png", "image"], ".jpg": ["image/jpeg", "image"], ".jpeg": ["image/jpeg", "image"], ".svg": ["image/svg+xml", "image"],
  ".html": ["text/html", "html"], ".csv": ["text/csv", "csv"], ".json": ["application/json", "json"], ".txt": ["text/plain", "text"],
};

export function mimeFor(file: string): [string, ArtifactFile["kind"]] | null {
  return MIME[path.extname(file).toLowerCase()] ?? null;
}

export interface RunPythonInput {
  code: string;
  columns: string[];
  rows: Record<string, unknown>[];
  title?: string;
  timeoutS?: number;
}

export async function runPython(input: RunPythonInput): Promise<ArtifactSpec> {
  const cfg = config();
  const c = sandboxCaps();
  const run = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
  const base: Omit<ArtifactSpec, "ok" | "files" | "stdout" | "stderr" | "error" | "timed_out" | "duration_ms"> = {
    kind: "artifact", id: `art_${run}`, run, title: input.title, rows_in: input.rows.length, network_isolated: !!c.unshare,
  };
  if (!c.python) {
    return { ...base, ok: false, files: [], stdout: "", stderr: "", error: "Python sandbox is not installed (run: uv sync --project agent/sandbox)", timed_out: false, duration_ms: 0 };
  }
  const runDir = path.join(cfg.sandboxWorkDir, run);
  mkdirSync(path.join(runDir, "out"), { recursive: true });
  writeFileSync(path.join(runDir, "script.py"), input.code);
  writeFileSync(path.join(runDir, "data.json"), JSON.stringify({ columns: input.columns, rows: input.rows }));
  const py = c.viaUv
    ? ["uv", "run", "--project", cfg.sandboxDir, "--no-sync", "--offline", "python", "-I", "-B", PRELUDE, runDir]
    : [c.python, "-I", "-B", PRELUDE, runDir];
  const r = await spawnSandboxed(py, { cwd: runDir, timeoutS: input.timeoutS ?? cfg.sandboxTimeoutS });
  let result: { ok?: boolean; error?: string | null; files?: string[] } = {};
  try {
    result = JSON.parse(readFileSync(path.join(runDir, "result.json"), "utf8"));
  } catch {
    /* killed before writing a result */
  }
  const outDir = path.join(runDir, "out");
  const artDir = path.join(cfg.artifactsDir, run);
  const files: ArtifactFile[] = [];
  for (const f of existsSync(outDir) ? readdirSync(outDir) : []) {
    const m = mimeFor(f);
    const src = path.join(outDir, f);
    if (!m || !statSync(src).isFile() || f.startsWith(".")) continue;
    const bytes = statSync(src).size;
    if (bytes > 15 * 1024 * 1024) continue;
    mkdirSync(artDir, { recursive: true });
    cpSync(src, path.join(artDir, f));
    files.push({ name: f, url: `/agent/artifacts/${run}/${encodeURIComponent(f)}`, mime: m[0], kind: m[1], bytes });
  }
  rmSync(runDir, { recursive: true, force: true });
  const ok = r.code === 0 && !r.timedOut && result.ok !== false;
  let error: string | null = null;
  if (r.timedOut) error = `Timed out after ${input.timeoutS ?? cfg.sandboxTimeoutS} s and was killed`;
  else if (!ok) error = result.error ?? (r.stderr.trim().split("\n").at(-1) || `exit code ${r.code}`);
  return {
    ...base, ok, files, stdout: r.stdout.slice(0, 4000), stderr: r.stderr.slice(-4000), error, timed_out: r.timedOut, duration_ms: r.ms,
  };
}

/** Removes artifacts older than `days` (7-day TTL) and stale run directories. */
export function cleanupArtifacts(days = 7): number {
  const cfg = config();
  let n = 0;
  const cutoff = Date.now() - days * 86_400_000;
  for (const dir of [cfg.artifactsDir, cfg.sandboxWorkDir]) {
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const p = path.join(dir, d);
      try {
        const limit = dir === cfg.sandboxWorkDir ? Date.now() - 3_600_000 : cutoff;
        if (statSync(p).mtimeMs < limit) {
          rmSync(p, { recursive: true, force: true });
          n++;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}
