/** Node-side rendering: bundle the compositions once, then render MP4s (H.264) and poster stills with the local
 * Chromium headless shell and SwiftShader GL (swangle) for the 3D shot. Used by the render server and the CLI. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition, type ChromiumOptions } from "@remotion/renderer";
import { browserExecutable } from "./lib/browser";

const here = dirname(fileURLToPath(import.meta.url));
export const VIDEO_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(VIDEO_ROOT, "..");
export const OUT_DIR = resolve(process.env.VIDEO_OUT_DIR ?? join(REPO_ROOT, "data", "videos"));

/** GL backend. Chromium's default rasterises the SVG scenes about 2.5x faster than swangle here and still gives WebGL
 * through SwiftShader, so it is the first choice; for the 3D composition a tiny GlCheck still proves WebGL works and
 * otherwise swangle (SwiftShader via ANGLE, the plan's setting) is used; with no WebGL at all the 2D body is drawn.
 * VIDEO_GL=swangle|angle|egl|swiftshader|default forces one backend for everything. */
const glEnv = process.env.VIDEO_GL;
const forcedGl: ChromiumOptions["gl"] | undefined = glEnv === undefined || glEnv === ""
  ? undefined : (glEnv === "default" || glEnv === "auto" ? null : glEnv) as ChromiumOptions["gl"];
const HAS_3D = new Set(["PatientCaseSummary"]);
/** A 3D frame slower than this (ms, measured once per process on a real frame) switches patient videos to the 2D body. */
const MAX_3D_MS = Number(process.env.VIDEO_3D_MAX_MS ?? 6000);
let mode3d: Promise<{ gl: ChromiumOptions["gl"]; use3d: boolean }> | null = null;

let bundlePromise: Promise<string> | null = null;
/** Webpack-bundle the Remotion project once per process (about 10-20 s). */
export function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = bundle({ entryPoint: join(VIDEO_ROOT, "src", "index.ts"), publicDir: join(VIDEO_ROOT, "public"), onProgress: () => undefined });
    bundlePromise.catch(() => { bundlePromise = null; });
  }
  return bundlePromise;
}

const browsers = new Map<string, ReturnType<typeof openBrowser>>();
/** One long-lived browser per GL mode (opening Chromium costs ~1 s per render otherwise). */
function getBrowser(chromiumOptions: ChromiumOptions) {
  const key = String(chromiumOptions.gl);
  let b = browsers.get(key);
  if (!b) {
    b = openBrowser("chrome", { browserExecutable: browserExecutable(), chromiumOptions });
    b.catch(() => browsers.delete(key));
    browsers.set(key, b);
  }
  return b;
}

/** Hash of the composition sources, so a design change never serves a stale cached render. */
export const CODE_VERSION = (() => {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(f.name) && !/^(server|render|build-props)\.ts$/.test(f.name)) h.update(f.name).update(readFileSync(p));
    }
  };
  walk(join(VIDEO_ROOT, "src"));
  return h.digest("hex").slice(0, 12);
})();

/** Cache key: composition + props + composition code version. */
export const propsHash = (compositionId: string, props: unknown) =>
  createHash("sha256").update(`${compositionId}\n${CODE_VERSION}\n${JSON.stringify(props)}`).digest("hex").slice(0, 32);

export type RenderResult = { mp4: string; png: string; seconds: number; frames: number };

/** Render `compositionId` with `props` to <outDir>/<hash>.mp4 plus a poster PNG. */
export async function renderVideo(compositionId: string, props: Record<string, unknown>, opts: {
  hash?: string; outDir?: string; onProgress?: (p: number, stage: string) => void; concurrency?: number;
} = {}): Promise<RenderResult> {
  const t0 = Date.now();
  const outDir = opts.outDir ?? OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const hash = opts.hash ?? propsHash(compositionId, props);
  const serveUrl = await getBundle();
  opts.onProgress?.(0.02, "bundled");
  let gl: ChromiumOptions["gl"] = forcedGl === undefined ? null : forcedGl;
  if (HAS_3D.has(compositionId)) {
    const m = await (mode3d ??= choose3d(serveUrl, compositionId, props));
    gl = m.gl;
    if (!m.use3d || process.env.VIDEO_3D === "off") props = { ...props, force2d: true };
  }
  const chromiumOptions: ChromiumOptions = { gl, headless: true };
  const puppeteerInstance = await getBrowser(chromiumOptions);
  const exe = browserExecutable();
  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps: props, puppeteerInstance, browserExecutable: exe, chromiumOptions });
  const mp4 = join(outDir, `${hash}.mp4`), png = join(outDir, `${hash}.png`);
  const tmp = join(outDir, `${hash}.part.mp4`);
  await renderMedia({
    serveUrl, composition, inputProps: props, codec: "h264", crf: 20, pixelFormat: "yuv420p", imageFormat: "jpeg", jpegQuality: 92,
    concurrency: opts.concurrency ?? Number(process.env.VIDEO_CONCURRENCY ?? 3), outputLocation: tmp, puppeteerInstance,
    browserExecutable: exe, chromiumOptions, timeoutInMilliseconds: 120_000, overwrite: true,
    onProgress: ({ progress }) => opts.onProgress?.(0.02 + 0.93 * progress, "rendering"),
  });
  // poster: the end of the title scene (everything has animated in)
  await renderStill({ serveUrl, composition, inputProps: props, frame: Math.min(composition.durationInFrames - 1, 110), output: png,
    imageFormat: "png", puppeteerInstance, browserExecutable: exe, chromiumOptions, overwrite: true });
  renameSync(tmp, mp4);
  opts.onProgress?.(1, "done");
  return { mp4, png, seconds: (Date.now() - t0) / 1000, frames: composition.durationInFrames };
}

/** Pick the GL backend for the 3D shot (GlCheck still: default first, then swangle) and time one real 3D frame. */
async function choose3d(serveUrl: string, id: string, props: Record<string, unknown>): Promise<{ gl: ChromiumOptions["gl"]; use3d: boolean }> {
  const candidates: ChromiumOptions["gl"][] = forcedGl !== undefined ? [forcedGl] : [null, "swangle"];
  for (const gl of candidates) {
    const chromiumOptions: ChromiumOptions = { gl, headless: true };
    try {
      const puppeteerInstance = await getBrowser(chromiumOptions);
      const check = await selectComposition({ serveUrl, id: "GlCheck", inputProps: {}, puppeteerInstance, chromiumOptions });
      await renderStill({ serveUrl, composition: check, inputProps: {}, frame: 0, output: join(OUT_DIR, `glcheck-${process.pid}.png`), puppeteerInstance, chromiumOptions, overwrite: true });
      try { unlinkSync(join(OUT_DIR, `glcheck-${process.pid}.png`)); } catch { /* ignore */ }
      const composition = await selectComposition({ serveUrl, id, inputProps: props, puppeteerInstance, chromiumOptions });
      const out = join(OUT_DIR, `probe-3d-${process.pid}.png`);
      const t0 = Date.now();
      await renderStill({ serveUrl, composition, inputProps: props, frame: 210, output: out, puppeteerInstance, chromiumOptions, overwrite: true, timeoutInMilliseconds: 60_000 });
      const ms = Date.now() - t0;
      try { unlinkSync(out); } catch { /* ignore */ }
      const use3d = ms <= MAX_3D_MS;
      console.log(`[video] WebGL with gl=${gl ?? "default"}; 3D probe frame ${ms} ms (limit ${MAX_3D_MS} ms) -> ${use3d ? "3D" : "2D fallback"}`);
      return { gl, use3d };
    } catch (e) {
      console.warn(`[video] no WebGL with gl=${gl ?? "default"}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.warn("[video] no WebGL backend works: patient videos use the 2D body");
  return { gl: forcedGl ?? null, use3d: false };
}

/** Close the long-lived browsers (CLI renders call this so the process can exit). */
export async function closeBrowsers() {
  for (const b of browsers.values()) {
    try { await (await b).close({ silent: true }); } catch { /* already closed */ }
  }
  browsers.clear();
}

export const cachedFiles = (hash: string, outDir = OUT_DIR) => {
  const mp4 = join(outDir, `${hash}.mp4`), png = join(outDir, `${hash}.png`);
  return existsSync(mp4) ? { mp4, png: existsSync(png) ? png : null } : null;
};
