/** CLI render (make video-render):
 *   tsx scripts/render.ts --kind patient --id <patient_id> [--facility <location_id>]
 *   tsx scripts/render.ts --kind ministry|ministry_vertical [--from 2015 --to 2026 --sex ALL --age ALL --def CONFIRMED_PROBABLE]
 * Builds props from the API (API_URL), renders to data/videos/<hash>.mp4 (+ .png) and prints the timing. A patient render
 * needs the doctor's facility: pass --facility, or it is looked up from the patient's linked facilities. */
import { parseArgs } from "node:util";
import { buildMinistryProps, buildPatientProps, API_URL } from "../src/build-props";
import { COMPOSITION_FOR, type VideoKind } from "../src/props";
import { closeBrowsers, propsHash, renderVideo } from "../src/render";

const { values: a } = parseArgs({ options: {
  kind: { type: "string", default: "patient" }, id: { type: "string" }, facility: { type: "string" }, from: { type: "string" }, to: { type: "string" },
  sex: { type: "string" }, age: { type: "string" }, def: { type: "string" }, force2d: { type: "boolean", default: false },
} });
const kind = a.kind as VideoKind;
if (!COMPOSITION_FOR[kind]) throw new Error(`--kind must be one of ${Object.keys(COMPOSITION_FOR).join(", ")}`);

const t0 = Date.now();
let props: Record<string, unknown>;
if (kind === "patient") {
  if (!a.id) throw new Error("--id <patient_id> is required for a patient video");
  const facility = a.facility ?? process.env.FACILITY_ID ?? (await findFacility(a.id));
  props = await buildPatientProps(a.id, { "X-Role": "doctor", "X-Facility-Id": String(facility) });
  if (a.force2d) props.force2d = true;
} else {
  props = await buildMinistryProps({ from: a.from, to: a.to, sex: a.sex, age: a.age, def: a.def }, { "X-Role": "ministry" });
}
const tProps = (Date.now() - t0) / 1000;
const comp = COMPOSITION_FOR[kind];
let last = -1;
const r = await renderVideo(comp, props, {
  hash: propsHash(comp, props),
  onProgress: (p, stage) => { const k = Math.floor(p * 10); if (k !== last) { last = k; process.stderr.write(`[video] ${stage} ${Math.round(p * 100)}%\n`); } },
});
console.log(JSON.stringify({ composition: comp, mp4: r.mp4, poster: r.png, frames: r.frames, props_seconds: tProps, render_seconds: r.seconds }, null, 1));
await closeBrowsers();
process.exit(0);

/** The patient's facility, via the serve DB's link table exposed by the API: try each facility from /meta/filters. */
async function findFacility(id: string): Promise<string> {
  const f = await fetch(`${API_URL}/meta/filters`, { headers: { "X-Role": "ministry" } }).then((x) => x.json()) as any;
  for (const fac of f.data?.facilities ?? []) {
    const res = await fetch(`${API_URL}/patients/${id}`, { headers: { "X-Role": "doctor", "X-Facility-Id": String(fac.location_id) } });
    if (res.ok) return String(fac.location_id);
  }
  throw new Error(`no facility can see patient ${id}; pass --facility`);
}
