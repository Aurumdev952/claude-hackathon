/**
 * End-to-end smoke test against a running agent (AGENT_URL, default http://localhost:8787) and the real published data:
 *   1. ministry "How has the under-50 rate changed since 2015?" -> tool-make_chart line part, numbers supported
 *   2. doctor "Show me my highest-risk patient" (facility with HIGH alerts) -> tool-make_patient_widget, no names in any
 *      model-visible tool output or in the answer
 *   3. persistence: reload, regenerate (trigger), truncate (rewind)
 * Exit code 1 on any failed check.
 */
import { SERVE } from "../src/db/duck.js";
import { numbersSupported, collectNumbers } from "../src/guardrails/numbers.js";
import { modelSafe, toolDefsFor } from "../src/tools/index.js";
import { newToolCtx } from "../src/tools/types.js";
import type { AgentContext } from "../src/context.js";

const BASE = (process.env.AGENT_URL ?? "http://localhost:8787").replace(/\/$/, "");
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  - ${detail}` : ""}`);
  if (!ok) failures++;
};

type Part = { type: string; text?: string; state?: string; input?: unknown; output?: unknown };
type Msg = { id: string; role: string; parts: Part[]; metadata?: Record<string, unknown> };

async function chat(headers: Record<string, string>, body: unknown): Promise<{ status: number; sse: string; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/agent/chat`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const sse = await r.text();
  return { status: r.status, sse, ms: Date.now() - t0 };
}

async function conversation(id: string, headers: Record<string, string>): Promise<{ messages: Msg[]; title: string }> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/agent/conversations/${id}`, { headers });
    const d = (await r.json()).data;
    if (d?.messages?.at(-1)?.role === "assistant") return d;
    await new Promise((res) => setTimeout(res, 250));
  }
  const r = await fetch(`${BASE}/agent/conversations/${id}`, { headers });
  return (await r.json()).data;
}

function modelViews(ctx: AgentContext, parts: Part[]) {
  const t = newToolCtx(ctx);
  const defs = new Map(toolDefsFor(ctx.role).map((d) => [d.name as string, d]));
  return parts.filter((p) => p.type.startsWith("tool-") && p.state === "output-available").map((p) => {
    const def = defs.get(p.type.slice(5));
    return { tool: p.type.slice(5), view: def ? modelSafe(def, p.output, t) : p.output, full: p.output };
  });
}

const text = (m: Msg) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
const toolNames = (m: Msg) => m.parts.filter((p) => p.type.startsWith("tool-")).map((p) => p.type.slice(5));

// ------------------------------------------------------------------------------------------------- health
const health = await (await fetch(`${BASE}/agent/health`)).json();
check(health.status === "ok", "agent health", `run ${health.serve?.run_id}, sim_time ${health.serve?.sim_time}, model ${health.model?.model}`);

// ------------------------------------------------------------------------------------------------- ministry
const MIN = { "X-Role": "ministry" };
const minId = `smoke-ministry-${Date.now()}`;
const q1 = "How has the under-50 rate changed since 2015?";
const r1 = await chat(MIN, { id: minId, message: { id: `${minId}-u1`, role: "user", parts: [{ type: "text", text: q1 }] }, trigger: "submit-message" });
check(r1.status === 200 && r1.sse.includes('"type":"finish"'), "ministry SSE stream completed", `${r1.ms} ms, ${r1.sse.length} bytes`);
const c1 = await conversation(minId, MIN);
const a1 = c1.messages.at(-1)!;
console.log(`\n[ministry] Q: ${q1}\n[ministry] tools: ${toolNames(a1).join(" -> ")}\n[ministry] A: ${text(a1)}\n[ministry] metadata: ${JSON.stringify(a1.metadata)}\n`);
const chartPart = a1.parts.find((p) => p.type === "tool-make_chart" && p.state === "output-available" && (p.output as { kind?: string })?.kind === "chart");
const spec = (chartPart?.output as { spec?: { type: string; series?: { key: string }[]; data?: unknown[]; x?: { key: string } } })?.spec;
check(!!chartPart, "ministry answer has a tool-make_chart part");
check(spec?.type === "line", "chart type is line", `type=${spec?.type} x=${spec?.x?.key} series=${spec?.series?.map((s) => s.key).join(",")} points=${spec?.data?.length}`);
const minCtx: AgentContext = { role: "ministry", facilityId: null };
const pool = modelViews(minCtx, a1.parts).flatMap((v) => collectNumbers(v.view));
check(numbersSupported(text(a1), pool), "every number in the ministry answer is supported by tool output");
check(a1.metadata?.validated_numbers === true, "server-side validated_numbers = true", `unsupported=${JSON.stringify(a1.metadata?.unsupported_numbers)}`);

// ------------------------------------------------------------------------------------------------- doctor
const fac = process.env.SMOKE_FACILITY
  ? Number(process.env.SMOKE_FACILITY)
  : Number((await SERVE().one(`
      SELECT f.facility_id AS location_id, count(DISTINCT a.alert_id) FILTER (WHERE a.severity = 'HIGH') AS high_alerts
      FROM pt_patient_facility f JOIN core_dim_location l ON l.location_id = f.facility_id
      LEFT JOIN pt_alerts a ON a.patient_id = f.patient_id
      GROUP BY ALL ORDER BY high_alerts DESC, count(DISTINCT a.alert_id) DESC LIMIT 1`))?.location_id);
const DOC = { "X-Role": "doctor", "X-Facility-Id": String(fac) };
const docId = `smoke-doctor-${Date.now()}`;
const q2 = "Show me my highest-risk patient";
const r2 = await chat(DOC, { id: docId, message: { id: `${docId}-u1`, role: "user", parts: [{ type: "text", text: q2 }] } });
check(r2.status === 200 && r2.sse.includes('"type":"finish"'), "doctor SSE stream completed", `facility ${fac}, ${r2.ms} ms`);
const c2 = await conversation(docId, DOC);
const a2 = c2.messages.at(-1)!;
console.log(`\n[doctor] facility ${fac} Q: ${q2}\n[doctor] tools: ${toolNames(a2).join(" -> ")}\n[doctor] A: ${text(a2)}\n[doctor] metadata: ${JSON.stringify(a2.metadata)}\n`);
const wPart = a2.parts.find((p) => p.type === "tool-make_patient_widget" && p.state === "output-available" && (p.output as { kind?: string })?.kind === "patient");
const widget = wPart?.output as { patient_id: number; display_id: string; name: string; risk?: { band: string } } | undefined;
check(!!wPart, "doctor answer has a tool-make_patient_widget part", widget ? `${widget.display_id}, risk ${widget.risk?.band}` : "");
const names = widget ? await SERVE().one("SELECT given_name, family_name FROM pt_patient WHERE patient_id = ?", [widget.patient_id]) : null;
check(!!widget?.name && widget.name === `${names?.given_name} ${names?.family_name}`, "the UI payload carries the patient's name (clinician screen)");
const docCtx: AgentContext = { role: "doctor", facilityId: fac };
const views = JSON.stringify(modelViews(docCtx, a2.parts).map((v) => v.view));
const nameRe = names ? new RegExp(`\\b(${String(names.given_name)}|${String(names.family_name)})\\b`) : /given_name/;
check(!/given_name|family_name/.test(views), "no given_name / family_name keys in model-visible tool outputs");
check(!nameRe.test(views), "the patient's name is absent from model-visible tool outputs");
check(!nameRe.test(text(a2)), "the patient's name is absent from the model's answer");
check(a2.metadata?.validated_numbers === true, "doctor answer numbers supported", `unsupported=${JSON.stringify(a2.metadata?.unsupported_numbers)}`);

// ------------------------------------------------------------------------------------------------- persistence
check(c1.messages.length === 2 && c1.title.startsWith("How has the under-50"), "ministry conversation persisted and reloadable", `title "${c1.title}"`);
const oldId = a1.id;
const r3 = await chat(MIN, { id: minId, trigger: "regenerate-message", messageId: oldId, messages: [c1.messages[0]] });
const c3 = await conversation(minId, MIN);
check(r3.status === 200 && c3.messages.length === 2 && c3.messages[1].id !== oldId, "regenerate replaced the assistant message",
  `${oldId} -> ${c3.messages[1]?.id}; tools ${toolNames(c3.messages[1]).join(" -> ")}`);
const tr = await (await fetch(`${BASE}/agent/conversations/${minId}/truncate`, {
  method: "POST", headers: { ...MIN, "Content-Type": "application/json" }, body: JSON.stringify({ messageId: c3.messages[0].id, inclusive: false }),
})).json();
check(tr.data?.deleted === 1 && tr.data.messages.length === 1, "truncate (rewind) kept only the user message");
const list = await (await fetch(`${BASE}/agent/conversations`, { headers: DOC })).json();
check(list.data.some((c: { id: string }) => c.id === docId), "doctor conversation listed for its facility");
const forbidden = await fetch(`${BASE}/agent/conversations/${docId}`, { headers: MIN });
check(forbidden.status === 403, "doctor conversation is not visible to the ministry role");

console.log(`\n${failures ? `${failures} check(s) FAILED` : "all smoke checks passed"}`);
SERVE().close();
process.exit(failures ? 1 : 0);
