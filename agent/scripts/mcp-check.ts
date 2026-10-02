/**
 * MCP round-trip against a running agent (default http://localhost:8787/mcp):
 *   pnpm mcp:check [--doctor <facility_id>] [--no-agent]
 * Lists tools / resources / prompts, calls get_kpis (ministry) or list_high_risk_patients (doctor), reads a resource and asks
 * the agent a question through ask_early_signals_agent.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.env.AGENT_URL ?? "http://localhost:8787").replace(/\/$/, "");
const args = process.argv.slice(2);
const docIdx = args.indexOf("--doctor");
const facility = docIdx >= 0 ? args[docIdx + 1] : undefined;
const headers: Record<string, string> = facility ? { "X-Role": "doctor", "X-Facility-Id": facility } : { "X-Role": "ministry" };

const client = new Client({ name: "early-signals-mcp-check", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
const info = client.getServerVersion();
console.log(`connected: ${info?.name} ${info?.version} as ${headers["X-Role"]}${facility ? ` @ ${facility}` : ""}`);

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(", ")}`);
const resources = await client.listResources();
console.log(`resources (${resources.resources.length}): ${resources.resources.slice(0, 8).map((r) => r.uri).join(", ")}${resources.resources.length > 8 ? ", ..." : ""}`);
const templates = await client.listResourceTemplates();
console.log(`resource templates: ${templates.resourceTemplates.map((r) => r.uriTemplate).join(", ")}`);
const prompts = await client.listPrompts();
console.log(`prompts: ${prompts.prompts.map((p) => p.name).join(", ")}`);

const cur = await client.readResource({ uri: "earlysignals://current" });
console.log(`earlysignals://current -> ${(cur.contents[0] as { text: string }).text.replace(/\s+/g, " ").slice(0, 200)}`);
const tbl = await client.readResource({ uri: "earlysignals://tables/mart_rates" });
console.log(`earlysignals://tables/mart_rates -> ${(tbl.contents[0] as { text: string }).text.replace(/\s+/g, " ").slice(0, 160)}...`);
const pr = await client.getPrompt({ name: facility ? "patient_review" : "district_profile", arguments: facility ? { display_id: "X" } : { district_code: "NOR-MUS" } });
console.log(`prompt -> ${JSON.stringify(pr.messages[0].content).slice(0, 120)}...`);

const call = facility ? { name: "list_high_risk_patients", arguments: { limit: 3 } } : { name: "get_kpis", arguments: {} };
const r = await client.callTool(call);
const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
console.log(`${call.name} -> isError=${!!r.isError} ${text.replace(/\s+/g, " ").slice(0, 400)}`);
if (facility && /given_name|family_name|"name"/.test(text)) throw new Error("patient names leaked over MCP");

if (!args.includes("--no-agent")) {
  const q = facility ? "Show me my highest-risk patient" : "What is the national age-standardised rate in the latest complete year?";
  const a = await client.callTool({ name: "ask_early_signals_agent", arguments: { question: q } }, undefined, { timeout: 180_000 });
  const sc = a.structuredContent as { answer?: string; validated_numbers?: boolean; tool_calls?: { name: string }[]; widgets?: unknown[] };
  console.log(`ask_early_signals_agent("${q}") -> tools=[${sc?.tool_calls?.map((t) => t.name).join(", ")}] widgets=${sc?.widgets?.length} validated=${sc?.validated_numbers}`);
  console.log(`answer: ${sc?.answer?.slice(0, 600)}`);
  if (facility && /given_name|family_name/.test(JSON.stringify(a))) throw new Error("patient names leaked over MCP");
}
await client.close();
