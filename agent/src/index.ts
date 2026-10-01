/** Entry point: `pnpm dev` (tsx watch) or `pnpm build && pnpm start`. Listens on AGENT_PORT (8787). */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { SERVE } from "./db/duck.js";
import { describeModel } from "./llm/model.js";
import { cleanupArtifacts, sandboxCaps } from "./sandbox/runner.js";

const cfg = config();
await db();
await SERVE().refresh(true).catch((e) => console.warn("[agent] serve DB not ready:", e.message));
cleanupArtifacts();
setInterval(() => cleanupArtifacts(), 3_600_000).unref();

const app = createApp();
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: process.env.AGENT_HOST ?? "0.0.0.0" }, (info) => {
  const m = describeModel(cfg);
  const caps = sandboxCaps();
  console.log(`[agent] http://localhost:${info.port}  (model ${m.provider}:${m.model}; serve run ${SERVE().meta().run_id ?? "-"}; ` +
    `sandbox ${caps.ready ? "ready" : "missing"}${caps.unshare ? ", no-network" : ""}; MCP /mcp)`);
});

// SSE turns can take minutes: no request timeout on the node server
(server as unknown as { requestTimeout?: number; headersTimeout?: number }).requestTimeout = 0;

const shutdown = () => {
  server.close();
  SERVE().close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
