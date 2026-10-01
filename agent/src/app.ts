/** Hono app: /agent/* (chat, conversations, artifacts, meta) and /mcp. No auth (demo); role via X-Role / X-Facility-Id. */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { config } from "./config.js";
import { contextFromHeaders } from "./context.js";
import { SERVE } from "./db/duck.js";
import { suggestions } from "./db/semantic.js";
import { ApiError } from "./lib/errors.js";
import type { Env } from "./lib/hono.js";
import { describeModel } from "./llm/model.js";
import { handleMcp } from "./mcp/server.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { sandboxCaps } from "./sandbox/runner.js";
import { toolDefsFor } from "./tools/index.js";
import { TOOL_LABELS } from "./widgets/specs.js";

export function createApp() {
  const app = new Hono<Env>();

  app.use("*", cors({
    origin: (o) => o ?? "*",
    allowHeaders: ["Content-Type", "X-Role", "X-Facility-Id", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Conversation-Id", "Mcp-Session-Id"],
  }));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toJSON(), err.status);
    if (err instanceof ZodError) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body", details: { issues: err.issues.slice(0, 10) } } }, 400);
    }
    if (err instanceof SyntaxError) return c.json({ error: { code: "INVALID_JSON", message: err.message, details: {} } }, 400);
    console.error("[agent] unhandled:", err);
    return c.json({ error: { code: "INTERNAL", message: String(err.message ?? err).slice(0, 300), details: {} } }, 500);
  });

  // ---------------------------------------------------------------------------------------------- public meta
  app.get("/agent/health", async (c) => {
    await SERVE().refresh().catch(() => false);
    const caps = sandboxCaps();
    const cfg = config();
    return c.json({
      status: SERVE().ready ? "ok" : "starting",
      serve: { ready: SERVE().ready, ...SERVE().meta(), file: SERVE().path },
      model: describeModel(cfg),
      model_configured: cfg.provider === "openai-compatible" ? !!cfg.baseUrl : !!cfg.apiKey,
      sandbox: {
        ready: caps.ready, python: caps.python, network_isolation: caps.unshare ? caps.unshare.join(" ") : null,
        prlimit: caps.prlimit, timeout_s: cfg.sandboxTimeoutS, mem_mb: cfg.sandboxMemMb,
      },
      mcp: "/mcp",
    });
  });

  // role-aware routes
  const agent = new Hono<Env>();
  agent.use("*", async (c, next) => {
    c.set("ctx", contextFromHeaders((n) => c.req.header(n)));
    await next();
  });
  agent.get("/suggestions", (c) => {
    const ctx = c.get("ctx");
    return c.json({ data: { role: ctx.role, questions: suggestions(ctx.role) } });
  });
  agent.get("/tools", (c) => {
    const ctx = c.get("ctx");
    return c.json({
      data: toolDefsFor(ctx.role).map((d) => ({ name: d.name, title: d.title, label: TOOL_LABELS[d.name], description: d.description })),
    });
  });
  agent.route("/", chatRoutes);
  agent.route("/", conversationRoutes);

  app.route("/agent", artifactRoutes); // no role needed: <img src> cannot send headers
  app.route("/agent", agent);
  app.all("/mcp", (c) => handleMcp(c));
  app.get("/", (c) => c.json({ service: "early-signals-agent", health: "/agent/health", mcp: "/mcp" }));
  return app;
}
