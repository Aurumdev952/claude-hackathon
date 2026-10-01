/**
 * MCP server (plan B5): Streamable HTTP at /mcp, stateless (a fresh McpServer + transport per request), no auth (demo).
 * Exposes the same data tools as our agents for the caller's X-Role / X-Facility-Id, plus `ask_early_signals_agent`,
 * resources (semantic layer, tables, glossary, current snapshot, suggestions) and prompts. Only model-safe views leave the
 * server: ministry outputs are suppressed + de-identified, doctor outputs are pseudonymised (no patient names).
 */
import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context } from "hono";
import { z } from "zod";
import { completeTurn, summarise } from "../agents/run.js";
import { config } from "../config.js";
import { contextFromHeaders, parseContext, type AgentContext } from "../context.js";
import { SERVE } from "../db/duck.js";
import { semantic, suggestions } from "../db/semantic.js";
import { pseudonymise, ministryView } from "../guardrails/suppress.js";
import { describeModel } from "../llm/model.js";
import { modelSafe, toolDefsFor } from "../tools/index.js";
import { describeTables } from "../tools/describe_tables.js";
import { newToolCtx } from "../tools/types.js";

const VERSION = "0.1.0";

function json(v: unknown) {
  return JSON.stringify(v, null, 1);
}

function absolutize(o: unknown, origin: string): unknown {
  if (Array.isArray(o)) return o.map((x) => absolutize(x, origin));
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "url" && typeof v === "string" && v.startsWith("/") ? origin + v : absolutize(v, origin)]));
  }
  return o;
}

export function buildMcpServer(ctx: AgentContext, origin: string): McpServer {
  const server = new McpServer(
    { name: "early-signals", version: VERSION, title: "Early Signals - gastric cancer surveillance (synthetic Rwanda EMR)" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        `Data tools over the Early Signals data marts (synthetic OpenMRS EMR, Rwanda) for role '${ctx.role}'` +
        (ctx.role === "doctor" ? ` at facility ${ctx.facilityId} (patients are pseudonymised: display_id only).` : " (aggregates only, cells < 5 suppressed).") +
        " Start with describe_tables or read earlysignals://semantic-layer; typed tools (get_kpis, get_rates_trend, ...) are preferred over query_marts." +
        " ask_early_signals_agent delegates a whole question to the Early Signals agent. All data is synthetic.",
    },
  );

  // ---------------------------------------------------------------------------------------------- data tools
  const tctx = newToolCtx(ctx, "mcp");
  for (const def of toolDefsFor(ctx.role)) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args: unknown) => {
        try {
          const out = await def.execute(def.inputSchema.parse(args), tctx);
          let safe: unknown;
          if (def.name === "make_chart" && out && typeof out === "object" && "kind" in out) {
            safe = ctx.role === "doctor" ? pseudonymise(out) : ministryView(out); // the spec itself is useful to other agents
          } else {
            safe = modelSafe(def, out, tctx);
          }
          safe = absolutize(safe, origin);
          const isError = !!(safe && typeof safe === "object" && (safe as { ok?: unknown }).ok === false);
          return {
            content: [{ type: "text" as const, text: json(safe) }],
            structuredContent: (safe && typeof safe === "object" && !Array.isArray(safe) ? safe : { result: safe }) as Record<string, unknown>,
            isError,
          };
        } catch (e) {
          return { content: [{ type: "text" as const, text: `${def.name} failed: ${(e as Error).message}` }], isError: true };
        }
      },
    );
  }

  // ---------------------------------------------------------------------------------------------- agent delegation
  server.registerTool(
    "ask_early_signals_agent",
    {
      title: "Ask the Early Signals agent",
      description:
        "Delegates a natural-language question to the Early Signals agent (the ministry or doctor persona with its own tools, " +
        "guardrails and chart widgets). Returns the grounded answer, the tools it called (model-safe outputs), widget specs and " +
        "whether every number in the answer is supported by the data. role / facility_id default to this connection's headers.",
      inputSchema: z.object({
        question: z.string().min(3).max(4000),
        role: z.enum(["ministry", "doctor"]).optional(),
        facility_id: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ question, role, facility_id }) => {
      try {
        const c = role || facility_id !== undefined ? parseContext(role ?? ctx.role, facility_id ?? ctx.facilityId) : ctx;
        const { message, tctx: t } = await completeTurn({
          ctx: c, surface: "mcp",
          history: [{ id: `mcp_${crypto.randomUUID().slice(0, 12)}`, role: "user", parts: [{ type: "text", text: question }] }],
        });
        const s = summarise(message, t);
        const result = absolutize({
          answer: s.answer,
          role: c.role,
          facility_id: c.facilityId,
          validated_numbers: message.metadata?.validated_numbers ?? null,
          unsupported_numbers: message.metadata?.unsupported_numbers ?? [],
          tool_calls: s.tool_calls.map((x) => ({ name: x.name, input: x.input, output: x.output, error: x.error })),
          widgets: s.widgets.map((w) => (c.role === "doctor" ? pseudonymise(w) : ministryView(w))),
          model: message.metadata?.model,
          synthetic_data: true,
        }, origin) as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: s.answer || "(no answer)" }], structuredContent: result };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `agent failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---------------------------------------------------------------------------------------------- resources
  server.registerResource(
    "semantic-layer",
    "earlysignals://semantic-layer",
    { title: "Semantic layer", description: "Tables, columns, default filters, glossary and suggested questions (YAML)", mimeType: "application/yaml" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/yaml", text: readFileSync(config().semanticLayerPath, "utf8") }] }),
  );
  server.registerResource(
    "glossary",
    "earlysignals://glossary",
    { title: "Glossary", description: "Domain terms -> SQL conditions", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: json(semantic().glossary) }] }),
  );
  server.registerResource(
    "current",
    "earlysignals://current",
    { title: "Current data snapshot", description: "Published run id, simulated date, model and role of this connection", mimeType: "application/json" },
    async (uri) => {
      await SERVE().refresh();
      return {
        contents: [{
          uri: uri.href, mimeType: "application/json",
          text: json({ ...SERVE().meta(), ready: SERVE().ready, role: ctx.role, facility_id: ctx.facilityId, agent_model: describeModel(), synthetic_data: true }),
        }],
      };
    },
  );
  server.registerResource(
    "table",
    new ResourceTemplate("earlysignals://tables/{name}", {
      list: async () => {
        const out = (await describeTables.execute({}, newToolCtx(ctx, "mcp"))) as { tables: { name: string; description: string | null }[] };
        return { resources: out.tables.map((t) => ({ uri: `earlysignals://tables/${t.name}`, name: t.name, description: t.description ?? undefined, mimeType: "application/json" })) };
      },
    }),
    { title: "Table schema", description: "Columns and documentation of one queryable table", mimeType: "application/json" },
    async (uri, { name }) => {
      const out = await describeTables.execute({ tables: [String(name)] }, newToolCtx(ctx, "mcp"));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: json(out) }] };
    },
  );
  server.registerResource(
    "suggestions",
    new ResourceTemplate("earlysignals://suggestions/{role}", {
      list: async () => ({
        resources: (["ministry", "doctor"] as const).map((r) => ({ uri: `earlysignals://suggestions/${r}`, name: `suggestions-${r}`, mimeType: "application/json" })),
      }),
    }),
    { title: "Suggested questions", description: "Starter questions per role", mimeType: "application/json" },
    async (uri, { role }) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: json(suggestions(String(role) === "doctor" ? "doctor" : "ministry")) }],
    }),
  );

  // ---------------------------------------------------------------------------------------------- prompts
  const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  server.registerPrompt(
    "ministry_briefing",
    { title: "Ministry briefing", description: "One-page national surveillance briefing", argsSchema: { focus: z.string().optional() } },
    ({ focus }) => user(
      "Prepare a short national gastric cancer surveillance briefing from the Early Signals data (synthetic): headline KPIs for the latest " +
      "complete year (get_kpis), the national and under-50 incidence trend with APC (get_rates_trend), districts with the highest rates and " +
      "High-High hotspots (get_district_ranking), stage at diagnosis (get_stage_mix) and the care cascade (get_care_cascade). " +
      `Cite only numbers returned by the tools, note small numbers and CIs, end with three policy implications.${focus ? ` Focus: ${focus}.` : ""}`,
    ),
  );
  server.registerPrompt(
    "district_profile",
    { title: "District profile", description: "Profile of one district", argsSchema: { district_code: z.string().describe("e.g. NOR-MUS") } },
    ({ district_code }) => user(
      `Profile district ${district_code}: incidence trend (get_rates_trend level DISTRICT), its rank and hotspot status (get_district_ranking), ` +
      "facility H. pylori testing quality (get_facility_quality district_code) and stage at diagnosis (get_stage_mix level DISTRICT). " +
      "Use only tool numbers; respect suppressed cells (<5).",
    ),
  );
  server.registerPrompt(
    "patient_review",
    { title: "Patient review", description: "Doctor-side review of one patient (requires X-Role: doctor)", argsSchema: { display_id: z.string() } },
    ({ display_id }) => user(
      `Review patient ${display_id} at my facility: get_patient, get_patient_risk and get_patient_timeline (last 12 months). Summarise the risk ` +
      "band and probability, the top reasons with dates and lab values, open alerts, and next steps phrased as considerations. Do not state a diagnosis.",
    ),
  );
  server.registerPrompt(
    "care_cascade_review",
    { title: "Care cascade review", description: "Where patients drop out of the H. pylori and endoscopy pathways", argsSchema: { province: z.string().optional() } },
    ({ province }) => user(
      `Review the care cascade${province ? ` for province ${province}` : " nationally"} with get_care_cascade (both pathways): the biggest drop-offs ` +
      "(pct_of_prev), H. pylori testing and eradication coverage, endoscopy referral -> scope -> diagnosis. Compare with facility testing quality " +
      "(get_facility_quality). Use only tool numbers.",
    ),
  );
  return server;
}

/** Hono handler for /mcp (POST JSON-RPC; GET / DELETE answered by the transport in stateless mode). */
export async function handleMcp(c: Context) {
  let ctx: AgentContext;
  try {
    ctx = contextFromHeaders((n) => c.req.header(n));
  } catch (e) {
    const err = e as { status?: number; toJSON?: () => unknown; message: string };
    return c.json({ jsonrpc: "2.0", error: { code: -32600, message: err.message }, id: null }, (err.status ?? 400) as 400);
  }
  const origin = new URL(c.req.url).origin;
  const server = buildMcpServer(ctx, origin);
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 202);
}
