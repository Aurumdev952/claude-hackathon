/** Video render server (contract docs/contracts/v3-loop.md §8). Hono on VIDEO_PORT (8790); Vite proxies /video here.
 *
 *   POST /video/jobs {kind, params}      -> {job_id, cached}   (props built with the caller's role headers)
 *   GET  /video/jobs/:id                 -> {status, progress, url, poster_url, error}
 *   GET  /video/jobs/:id/events          -> SSE progress stream (same fields)
 *   GET  /video/files/:hash.mp4|.png     -> the render (Range supported; ?download=1 for an attachment)
 *   GET  /video/props/:kind?...          -> built props (for the frontend Player preview)
 *   GET  /video/health
 *
 * Renders run one at a time (each uses `concurrency` Chromium tabs). Output is cached by sha256(composition + props) in
 * data/videos/ for 14 days. A file URL is a capability link: its hash is unguessable without the underlying data, and
 * the props behind it could only be built by a caller the API allowed. */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ApiError, API_URL, buildMinistryProps, buildPatientProps, normaliseMinistryParams } from "./build-props";
import { browserExecutable } from "./lib/browser";
import { COMPOSITION_FOR, FORBIDDEN_KEYS, type VideoKind } from "./props";
import { getBundle, OUT_DIR, propsHash, renderVideo } from "./render";

const PORT = Number(process.env.VIDEO_PORT ?? 8790);
const TTL_DAYS = Number(process.env.VIDEO_TTL_DAYS ?? 14);
const KINDS = Object.keys(COMPOSITION_FOR) as VideoKind[];
const FORWARD = ["x-role", "x-facility-id", "x-patient-id"];

type Job = {
  id: string; kind: VideoKind; composition: string; status: "queued" | "rendering" | "done" | "error"; progress: number;
  stage: string; error: string | null; created: number; finished: number | null; seconds: number | null; label: string;
  props?: Record<string, unknown>;
};
const jobs = new Map<string, Job>();
const queue: string[] = [];
let working = false;
let bundled = false;

const forwardHeaders = (c: Context) => {
  const h: Record<string, string> = {};
  for (const k of FORWARD) { const v = c.req.header(k); if (v) h[k] = v; }
  return h;
};

async function buildProps(kind: VideoKind, params: Record<string, unknown>, headers: Record<string, string>) {
  if (kind === "patient") {
    const id = params.patient_id ?? params.id;
    if (id === undefined || id === null || !/^\d+$/.test(String(id))) throw new ApiError(400, "params.patient_id (integer) is required");
    if ((headers["x-role"] ?? "").toLowerCase() !== "doctor") throw new ApiError(403, "Patient videos need the doctor role (X-Role: doctor, X-Facility-Id)");
    const props = await buildPatientProps(String(id), headers);
    const s = JSON.stringify(props);
    for (const k of FORBIDDEN_KEYS) if (s.includes(`"${k}"`)) throw new ApiError(500, "identifying field in patient props");
    return { props: props as unknown as Record<string, unknown>, label: props.display_id };
  }
  const p = normaliseMinistryParams(params as Record<string, string>);
  const props = await buildMinistryProps(p, headers);
  return { props: props as unknown as Record<string, unknown>, label: `ministry-${p.from}-${p.to}${kind === "ministry_vertical" ? "-vertical" : ""}` };
}

const filesFor = (hash: string) => ({ mp4: join(OUT_DIR, `${hash}.mp4`), png: join(OUT_DIR, `${hash}.png`), meta: join(OUT_DIR, `${hash}.json`) });
const view = (j: Job) => ({
  job_id: j.id, kind: j.kind, status: j.status, progress: Math.round(j.progress * 1000) / 1000, stage: j.stage, error: j.error,
  url: j.status === "done" ? `/video/files/${j.id}.mp4` : null, poster_url: j.status === "done" ? `/video/files/${j.id}.png` : null,
  download_url: j.status === "done" ? `/video/files/${j.id}.mp4?download=1` : null, render_seconds: j.seconds,
});

async function pump() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const j = jobs.get(id);
      if (!j || !j.props) continue;
      j.status = "rendering";
      j.stage = "starting";
      try {
        const r = await renderVideo(j.composition, j.props, { hash: j.id, onProgress: (p, stage) => { j.progress = p; j.stage = stage; } });
        writeFileSync(filesFor(j.id).meta, JSON.stringify({ kind: j.kind, composition: j.composition, label: j.label, created: new Date().toISOString(), seconds: r.seconds, frames: r.frames }));
        j.status = "done"; j.progress = 1; j.stage = "done"; j.seconds = r.seconds; j.finished = Date.now();
        console.log(`[video] ${j.composition} ${j.id} rendered in ${r.seconds.toFixed(1)} s (${r.frames} frames)`);
      } catch (e) {
        j.status = "error"; j.error = (e as Error).message; j.finished = Date.now();
        console.error(`[video] ${j.id} failed:`, e);
      } finally {
        delete j.props; // keep memory small; the props are reproducible from the API
      }
    }
  } finally {
    working = false;
  }
}

function cleanup() {
  if (!existsSync(OUT_DIR)) return;
  const cutoff = Date.now() - TTL_DAYS * 86400000;
  let n = 0;
  for (const f of readdirSync(OUT_DIR)) {
    const p = join(OUT_DIR, f);
    try {
      if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; jobs.delete(f.split(".")[0]); }
    } catch { /* raced with a render */ }
  }
  if (n) console.log(`[video] TTL cleanup removed ${n} files older than ${TTL_DAYS} days`);
}

const app = new Hono();
const errorJson = (c: Context, e: unknown) => {
  const status = e instanceof ApiError ? e.status : 500;
  const body = e instanceof ApiError && e.body && typeof e.body === "object" ? e.body : null;
  return c.json({ error: (e as Error).message, upstream: body }, status as 400);
};

app.get("/video/health", (c) => c.json({ status: "ok", bundled, browser: browserExecutable(), api: API_URL, queue: queue.length,
  rendering: [...jobs.values()].filter((j) => j.status === "rendering").map((j) => j.id), out_dir: OUT_DIR, ttl_days: TTL_DAYS }));

app.get("/video/props/:kind", async (c) => {
  const kind = c.req.param("kind") as VideoKind;
  if (!KINDS.includes(kind)) return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
  try {
    const { props } = await buildProps(kind, c.req.query(), forwardHeaders(c));
    c.header("X-Composition", COMPOSITION_FOR[kind]);
    c.header("Cache-Control", "no-store");
    return c.json(props);
  } catch (e) {
    return errorJson(c, e);
  }
});

app.post("/video/jobs", async (c) => {
  let body: { kind?: string; params?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: "JSON body {kind, params} required" }, 400); }
  const kind = body.kind as VideoKind;
  if (!KINDS.includes(kind)) return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
  try {
    const { props, label } = await buildProps(kind, body.params ?? {}, forwardHeaders(c));
    const composition = COMPOSITION_FOR[kind];
    const id = propsHash(composition, props);
    const f = filesFor(id);
    const existing = jobs.get(id);
    if (existsSync(f.mp4)) {
      const now = new Date();
      try { utimesSync(f.mp4, now, now); if (existsSync(f.png)) utimesSync(f.png, now, now); } catch { /* best effort */ }
      if (!existing || existing.status !== "done") {
        jobs.set(id, { id, kind, composition, status: "done", progress: 1, stage: "done", error: null, created: Date.now(), finished: Date.now(), seconds: null, label });
      }
      return c.json({ job_id: id, cached: true });
    }
    if (existing && (existing.status === "queued" || existing.status === "rendering")) return c.json({ job_id: id, cached: false });
    jobs.set(id, { id, kind, composition, status: "queued", progress: 0, stage: "queued", error: null, created: Date.now(), finished: null, seconds: null, label, props });
    queue.push(id);
    void pump();
    return c.json({ job_id: id, cached: false }, 202);
  } catch (e) {
    return errorJson(c, e);
  }
});

const lookup = (id: string): Job | null => {
  const j = jobs.get(id);
  if (j) return j;
  // after a restart: a finished file is still a finished job
  const f = filesFor(id);
  if (/^[0-9a-f]{32}$/.test(id) && existsSync(f.mp4)) {
    const meta = existsSync(f.meta) ? JSON.parse(readFileSync(f.meta, "utf8")) : {};
    const job: Job = { id, kind: meta.kind ?? "patient", composition: meta.composition ?? "", status: "done", progress: 1, stage: "done", error: null,
      created: statSync(f.mp4).mtimeMs, finished: statSync(f.mp4).mtimeMs, seconds: meta.seconds ?? null, label: meta.label ?? id };
    jobs.set(id, job);
    return job;
  }
  return null;
};

app.get("/video/jobs/:id", (c) => {
  const j = lookup(c.req.param("id"));
  return j ? c.json(view(j)) : c.json({ error: "job not found" }, 404);
});

app.get("/video/jobs/:id/events", (c) => {
  const id = c.req.param("id");
  if (!lookup(id)) return c.json({ error: "job not found" }, 404);
  return streamSSE(c, async (s) => {
    let last = "";
    for (;;) {
      const j = lookup(id);
      if (!j) break;
      const v = JSON.stringify(view(j));
      if (v !== last) { await s.writeSSE({ event: "progress", data: v }); last = v; }
      if (j.status === "done" || j.status === "error") break;
      await s.sleep(500);
    }
  });
});

app.get("/video/files/:file", (c) => {
  const m = /^([0-9a-f]{32})\.(mp4|png)$/.exec(c.req.param("file"));
  if (!m) return c.json({ error: "not found" }, 404);
  const [, hash, ext] = m;
  const f = filesFor(hash);
  const path = ext === "mp4" ? f.mp4 : f.png;
  if (!existsSync(path)) return c.json({ error: "not found (expired or never rendered)" }, 404);
  const size = statSync(path).size;
  const meta = existsSync(f.meta) ? JSON.parse(readFileSync(f.meta, "utf8")) : {};
  const name = `early-signals-${String(meta.label ?? hash).replace(/[^A-Za-z0-9._-]/g, "_")}.${ext}`;
  const headers: Record<string, string> = {
    "Content-Type": ext === "mp4" ? "video/mp4" : "image/png", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="${name}"`,
  };
  const range = c.req.header("range");
  const r = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (r && ext === "mp4") {
    const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
    const end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream,
      { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
});

cleanup();
setInterval(cleanup, 6 * 3600 * 1000).unref();
const t0 = Date.now();
getBundle().then(() => { bundled = true; console.log(`[video] bundle ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`); })
  .catch((e) => console.error("[video] bundling failed", e));
serve({ fetch: app.fetch, port: PORT, hostname: process.env.VIDEO_HOST ?? "0.0.0.0" }, (i) => {
  console.log(`[video] render server on http://localhost:${i.port}/video/health (API ${API_URL}, out ${OUT_DIR})`);
});
