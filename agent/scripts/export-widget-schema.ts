/**
 * Exports the widget zod schemas (src/widgets/specs.ts) as JSON Schema for the DeepEval widget gate
 * (evals/agent/metrics.py). Run after changing specs.ts:  pnpm export:widget-schema
 * Output: ../evals/agent/schemas/widgets.schema.json  ({ChartWidget, PatientWidget, ArtifactSpec, VideoWidget} under $defs).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ArtifactSpec, ChartWidget, PatientWidget, VideoWidget } from "../src/widgets/specs.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../evals/agent/schemas/widgets.schema.json");

// io: "input" keeps optional fields optional exactly as the parser accepts them.
const opts = { target: "draft-2020-12", io: "input", unrepresentable: "any" } as const;
const defs = {
  ChartWidget: z.toJSONSchema(ChartWidget, opts),
  PatientWidget: z.toJSONSchema(PatientWidget, opts),
  ArtifactSpec: z.toJSONSchema(ArtifactSpec, opts),
  VideoWidget: z.toJSONSchema(VideoWidget, opts),
};
for (const d of Object.values(defs)) delete (d as Record<string, unknown>).$schema;

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "early-signals/agent/widgets",
  title: "Early Signals agent widgets (generated from agent/src/widgets/specs.ts - do not edit)",
  $defs: defs,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`wrote ${out}`);
