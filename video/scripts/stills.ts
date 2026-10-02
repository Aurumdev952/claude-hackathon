/** Design check: render chosen frames of a composition from a props JSON file to PNGs.
 *   tsx scripts/stills.ts <CompositionId> <props.json> <outDir> <frame> [frame...]   ("mid" = middle of every scene) */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { ministryScenes } from "../src/compositions/ministryScenes";
import { patientScenes } from "../src/compositions/patientScenes";
import { browserExecutable } from "../src/lib/browser";
import { getBundle } from "../src/render";

const [id, file, out, ...frames] = process.argv.slice(2);
const props = JSON.parse(readFileSync(file, "utf8"));
mkdirSync(out, { recursive: true });
const serveUrl = await getBundle();
const exe = browserExecutable();
const chromiumOptions = { gl: "swangle" as const };
const browser = await openBrowser("chrome", { browserExecutable: exe, chromiumOptions });
const composition = await selectComposition({ serveUrl, id, inputProps: props, puppeteerInstance: browser, browserExecutable: exe, chromiumOptions });
let list = frames.map(Number);
if (frames[0] === "mid") {
  const scenes = id.startsWith("Patient") ? patientScenes(props) : ministryScenes(props);
  let t = 0; list = [];
  for (const s of scenes) { list.push(t + Math.round(s.duration * 0.8)); t += s.duration; }
}
for (const f of list) {
  const t0 = Date.now();
  await renderStill({ serveUrl, composition, inputProps: props, frame: f, output: join(out, `${id}-${String(f).padStart(5, "0")}.png`), puppeteerInstance: browser, browserExecutable: exe, chromiumOptions, overwrite: true });
  console.log(`frame ${f} ${(Date.now() - t0)}ms`);
}
await browser.close({ silent: true });
