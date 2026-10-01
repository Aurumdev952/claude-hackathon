/** GET /agent/artifacts/:run/:file - sandbox outputs (PNG / plotly HTML / CSV). HTML is served with a restrictive CSP. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { mimeFor } from "../sandbox/runner.js";

export const artifactRoutes = new Hono();

artifactRoutes.get("/artifacts/:run/:file", (c) => {
  const run = c.req.param("run");
  const file = decodeURIComponent(c.req.param("file"));
  if (!/^[\w-]{1,80}$/.test(run) || !/^[\w.-]{1,120}$/.test(file) || file.startsWith(".")) throw new ApiError(400, "INVALID_PATH", "Bad artifact path");
  const root = path.resolve(config().artifactsDir);
  const p = path.resolve(root, run, file);
  if (!p.startsWith(root + path.sep) || !existsSync(p) || !statSync(p).isFile()) throw new ApiError(404, "NOT_FOUND", "Artifact not found");
  const m = mimeFor(file);
  if (!m) throw new ApiError(404, "NOT_FOUND", "Artifact type not served");
  const headers: Record<string, string> = {
    "Content-Type": m[0],
    "Cache-Control": "private, max-age=604800, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  if (m[1] === "html" || m[0] === "image/svg+xml") {
    // plotly HTML loads plotly.js from its CDN; nothing else, no forms, no top navigation
    headers["Content-Security-Policy"] =
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.plot.ly; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; sandbox allow-scripts";
  }
  return c.body(readFileSync(p), 200, headers);
});
