/** CLI: print video props as JSON. `tsx scripts/build-props.ts patient <id> <facility>` or `... ministry <from> <to>`. */
import { buildMinistryProps, buildPatientProps } from "../src/build-props";

const [kind, a, b] = process.argv.slice(2);
const out = kind === "patient"
  ? await buildPatientProps(a, { "X-Role": "doctor", "X-Facility-Id": b })
  : await buildMinistryProps({ from: a ?? 2015, to: b ?? 2026 }, { "X-Role": "ministry" });
process.stdout.write(JSON.stringify(out, null, 1));
