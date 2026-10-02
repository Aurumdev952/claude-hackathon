/**
 * Calls to the FastAPI (`API_URL`, /api/v1) and the video render server (`VIDEO_URL`) on behalf of a tool, with the
 * caller's role headers, so the API's own access rules apply (doctor facility scoping, ministry-only forecasts).
 * The agent never calls an endpoint that creates care plans, changes tasks or sends notifications.
 */
import { config } from "../config.js";
import type { AgentContext } from "../context.js";

export class UpstreamError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Endpoints the agent may POST to. Everything else is read-only GET. */
const POST_ALLOWED = [/^\/care\/notifications\/preview$/, /^\/forecast\/scenario$/, /^\/video\/jobs$/];

export function roleHeaders(ctx: AgentContext): Record<string, string> {
  const h: Record<string, string> = { "X-Role": ctx.role };
  if (ctx.role === "doctor" && ctx.facilityId !== null) h["X-Facility-Id"] = String(ctx.facilityId);
  return h;
}

async function call(base: string, path: string, ctx: AgentContext, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
  const method = init.method ?? "GET";
  if (method !== "GET" && !POST_ALLOWED.some((r) => r.test(path))) {
    throw new UpstreamError(403, "AGENT_WRITE_BLOCKED", `The agent may not ${method} ${path}`);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config().upstreamTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method,
      headers: { ...roleHeaders(ctx), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    throw new UpstreamError(503, aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      `${aborted ? "Timed out calling" : "Could not reach"} ${base} (${(e as Error).message ?? e})`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } | string } | null)?.error;
    const code = typeof err === "object" && err?.code ? err.code : `HTTP_${res.status}`;
    const msg = typeof err === "object" ? err?.message ?? text.slice(0, 200) : typeof err === "string" ? err : text.slice(0, 200);
    throw new UpstreamError(res.status, code, msg || `HTTP ${res.status}`);
  }
  return json;
}

/** FastAPI call; returns the envelope's `data` (and `meta` / extra keys on `.envelope`). */
export async function api<T = unknown>(ctx: AgentContext, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<{ data: T; envelope: Record<string, unknown> }> {
  const out = (await call(`${config().fastApiUrl.replace(/\/$/, "")}/api/v1`, path, ctx, init)) as Record<string, unknown> | null;
  return { data: (out?.data ?? null) as T, envelope: out ?? {} };
}

/** Video render server call (`/video/...`), raw JSON. */
export async function video<T = unknown>(ctx: AgentContext, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  return (await call(config().videoUrl, path, ctx, init)) as T;
}

export function upstreamMessage(e: unknown): { ok: false; error: string; code?: string; status?: number } {
  if (e instanceof UpstreamError) return { ok: false, error: e.message, code: e.code, status: e.status };
  return { ok: false, error: String((e as Error)?.message ?? e) };
}
