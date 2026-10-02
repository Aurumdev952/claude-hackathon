/** HTTP surface with a mock language model: chat SSE + persistence, regenerate, edit/truncate, /complete, MCP, errors. */
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { setModelOverride } from "../src/llm/model.js";

const app = createApp();
const MIN = { "X-Role": "ministry", "Content-Type": "application/json" };
const DOC = { "X-Role": "doctor", "X-Facility-Id": "101", "Content-Type": "application/json" };
const NAMES = /Alice|Uwase|Jean|Habimana|Grace|Mukamana/;

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function streamOf(parts: unknown[]) {
  return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
}

/** Scripted model: tool calls first (one per step), then a final text. Records every prompt it receives. */
function scripted(calls: { name: string; input: Record<string, unknown> }[], finalText: string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: async (opts) => {
      prompts.push(JSON.stringify(opts.prompt));
      const toolResults = opts.prompt.filter((m) => m.role === "tool").length;
      const step = calls[toolResults];
      if (step) {
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `call_${toolResults}_${Math.random().toString(36).slice(2, 7)}`, toolName: step.name, input: JSON.stringify(step.input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ]) as never;
      }
      return streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: finalText },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]) as never;
    },
  });
  return { model, prompts };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const getConv = async (id: string, h = MIN) => (await (await app.request(`/agent/conversations/${id}`, { headers: h })).json()).data;

afterAll(() => setModelOverride(null));

describe("meta routes", () => {
  it("health reports the fixture snapshot, model and sandbox", async () => {
    const r = await app.request("/agent/health");
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.serve).toMatchObject({ ready: true, run_id: 7, sim_time: "2026-06-30T23:59:59" });
    expect(b.model.model).toBeTruthy();
    expect(b.mcp).toBe("/mcp");
  });
  it("suggestions and tools per role", async () => {
    const s = await (await app.request("/agent/suggestions", { headers: DOC })).json();
    expect(s.data.role).toBe("doctor");
    expect(s.data.questions).toContain("My 10 highest-risk patients");
    const t = await (await app.request("/agent/tools", { headers: MIN })).json();
    expect(t.data.map((x: { name: string }) => x.name)).toContain("get_rates_trend");
  });
  it("role errors match the FastAPI contract", async () => {
    const bad = await app.request("/agent/suggestions", { headers: { "X-Role": "admin" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("INVALID_ROLE");
    const nofac = await app.request("/agent/suggestions", { headers: { "X-Role": "doctor" } });
    expect((await nofac.json()).error.code).toBe("FACILITY_REQUIRED");
  });
  it("artifact paths cannot escape the artifacts directory", async () => {
    expect((await app.request("/agent/artifacts/..%2F..%2Fetc/passwd")).status).toBeGreaterThanOrEqual(400);
    expect((await app.request("/agent/artifacts/run1/..%2F..%2Fagent.sqlite")).status).toBe(400);
    expect((await app.request("/agent/artifacts/run1/figure_1.png")).status).toBe(404);
  });
});

describe("chat (mock model)", () => {
  beforeAll(() => {
    const { model } = scripted([{ name: "get_kpis", input: {} }], "The national ASR was 7.54 in 2026 (synthetic data).");
    setModelOverride(model);
  });

  it("streams a UI message, persists both messages with metadata", async () => {
    const res = await app.request("/agent/chat", {
      method: "POST", headers: MIN,
      body: JSON.stringify({ id: "c-stream", message: { id: "u1", role: "user", parts: [{ type: "text", text: "What is the national ASR?" }] }, trigger: "submit-message" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = await res.text();
    expect(sse).toContain('"type":"tool-output-available"');
    expect(sse).toContain('"type":"text-delta"');
    const conv = await waitFor(() => getConv("c-stream"), (c) => c?.messages?.length === 2);
    expect(conv.title).toBe("What is the national ASR?");
    const a = conv.messages[1];
    expect(a.role).toBe("assistant");
    expect(a.parts.map((p: { type: string }) => p.type)).toEqual(expect.arrayContaining(["tool-get_kpis", "text"]));
    expect(a.metadata).toMatchObject({ role: "ministry", run_id: 7, validated_numbers: true, tools_called: ["get_kpis"] });
  });

  it("regenerate replaces the assistant message", async () => {
    const before = await getConv("c-stream");
    const oldId = before.messages[1].id;
    const res = await app.request("/agent/chat", {
      method: "POST", headers: MIN,
      body: JSON.stringify({ id: "c-stream", trigger: "regenerate-message", messageId: oldId, messages: [before.messages[0]] }),
    });
    await res.text();
    const after = await waitFor(() => getConv("c-stream"), (c) => c.messages.length === 2 && c.messages[1].id !== oldId);
    expect(after.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(after.messages[1].id).not.toBe(oldId);
  });

  it("edit = truncate inclusive + send; rewind = truncate exclusive", async () => {
    const t = await app.request("/agent/conversations/c-stream/truncate", { method: "POST", headers: MIN, body: JSON.stringify({ messageId: "u1", inclusive: true }) });
    expect((await t.json()).data).toMatchObject({ deleted: 2, messages: [] });
    const res = await app.request("/agent/chat", {
      method: "POST", headers: MIN,
      body: JSON.stringify({ id: "c-stream", message: { id: "u1b", role: "user", parts: [{ type: "text", text: "Edited question" }] } }),
    });
    await res.text();
    const conv = await waitFor(() => getConv("c-stream"), (c) => c.messages.length === 2);
    expect(conv.messages[0].id).toBe("u1b");
    expect(conv.title).toBe("Edited question"); // the first message was replaced: the auto title follows it
    const rw = await app.request("/agent/conversations/c-stream/truncate", { method: "POST", headers: MIN, body: JSON.stringify({ messageId: "u1b", inclusive: false }) });
    expect((await rw.json()).data.messages.map((m: { id: string }) => m.id)).toEqual(["u1b"]);
  });

  it("editing the first message in place retitles; a renamed title is kept", async () => {
    const send = async (id: string, msgId: string, text: string) => (await app.request("/agent/chat", {
      method: "POST", headers: MIN, body: JSON.stringify({ id, message: { id: msgId, role: "user", parts: [{ type: "text", text }] } }),
    })).text();
    await send("c-title", "t1", "First question");
    await waitFor(() => getConv("c-title"), (c) => c?.messages?.length === 2);
    await send("c-title", "t1", "First question, edited in place");
    let conv = await waitFor(() => getConv("c-title"), (c) => c.messages.length === 2 && c.messages[0].parts[0].text.includes("edited"));
    expect(conv.title).toBe("First question, edited in place");
    await app.request("/agent/conversations/c-title", { method: "PATCH", headers: MIN, body: JSON.stringify({ title: "My briefing" }) });
    const t = await app.request("/agent/conversations/c-title/truncate", { method: "POST", headers: MIN, body: JSON.stringify({ messageId: "t1", inclusive: true }) });
    expect((await t.json()).data.messages).toEqual([]);
    await send("c-title", "t2", "Another question");
    conv = await waitFor(() => getConv("c-title"), (c) => c.messages.length === 2);
    expect(conv.title).toBe("My briefing");
  });

  it("conversations are pinned to their role", async () => {
    const r = await app.request("/agent/conversations/c-stream", { headers: DOC });
    expect(r.status).toBe(403);
    const r2 = await app.request("/agent/chat", {
      method: "POST", headers: DOC,
      body: JSON.stringify({ id: "c-stream", message: { id: "u9", role: "user", parts: [{ type: "text", text: "x" }] } }),
    });
    expect(r2.status).toBe(403);
  });

  it("conversation CRUD", async () => {
    const c = await (await app.request("/agent/conversations", { method: "POST", headers: MIN, body: JSON.stringify({ title: "Mine" }) })).json();
    expect(c.data).toMatchObject({ role: "ministry", title: "Mine" });
    const p = await (await app.request(`/agent/conversations/${c.data.id}`, { method: "PATCH", headers: MIN, body: JSON.stringify({ title: "Renamed" }) })).json();
    expect(p.data.title).toBe("Renamed");
    const list = await (await app.request("/agent/conversations", { headers: MIN })).json();
    expect(list.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([c.data.id, "c-stream"]));
    expect((await app.request(`/agent/conversations/${c.data.id}`, { method: "DELETE", headers: MIN })).status).toBe(200);
    expect((await app.request(`/agent/conversations/${c.data.id}`, { headers: MIN })).status).toBe(404);
  });

  it("/agent/chat/complete returns answer, model-safe tool calls and widgets", async () => {
    const { model } = scripted([{ name: "get_rates_trend", input: { age_band: "<50" } }, { name: "make_chart", input: { type: "line", title: "Under-50", dataset_id: "ds1", x: "year", series: [{ key: "asr" }] } }], "It rose from 1.29 to 2.19.");
    setModelOverride(model);
    const r = await app.request("/agent/chat/complete", { method: "POST", headers: MIN, body: JSON.stringify({ question: "How has the under-50 rate changed?" }) });
    const d = (await r.json()).data;
    expect(d.answer).toBe("It rose from 1.29 to 2.19.");
    expect(d.tool_calls.map((t: { name: string }) => t.name)).toEqual(["get_rates_trend", "make_chart"]);
    expect(d.widgets[0]).toMatchObject({ tool: "make_chart", kind: "chart", spec: { type: "line" } });
    expect(d.validated_numbers).toBe(true);
    expect(d.retrieval_context.length).toBe(2);
    const r2 = await app.request("/agent/chat/complete", { method: "POST", headers: MIN, body: JSON.stringify({ question: "x" }) });
    expect((await r2.json()).data.conversation_id).toBeNull();
  });

  it("flags unsupported numbers", async () => {
    setModelOverride(scripted([{ name: "get_kpis", input: {} }], "The ASR was 77.7 in 2026.").model);
    const d = (await (await app.request("/agent/chat/complete", { method: "POST", headers: MIN, body: JSON.stringify({ question: "ASR?" }) })).json()).data;
    expect(d.validated_numbers).toBe(false);
    expect(d.unsupported_numbers).toEqual([77.7]);
  });
});

describe("chart nudge vs python requests (mock model)", () => {
  /** Records the toolChoice and tool names of every model call; calls get_rates_trend once, then answers. */
  function recording() {
    const calls: { toolChoice: unknown; tools: string[] }[] = [];
    const model = new MockLanguageModelV4({
      modelId: "mock",
      doStream: async (opts) => {
        calls.push({ toolChoice: opts.toolChoice, tools: (opts.tools ?? []).map((t: { name: string }) => t.name) });
        if (!opts.prompt.some((m) => m.role === "tool")) {
          return streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: `call_${Math.random().toString(36).slice(2, 7)}`, toolName: "get_rates_trend", input: JSON.stringify({ age_band: "<50" }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
          ]) as never;
        }
        return streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done." }, { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ]) as never;
      },
    });
    return { model, calls };
  }
  const ask = (question: string) => app.request("/agent/chat/complete", { method: "POST", headers: MIN, body: JSON.stringify({ question }) });

  it("a trend question forces make_chart after the data tool", async () => {
    const { model, calls } = recording();
    setModelOverride(model);
    await (await ask("How has the under-50 rate changed by year?")).json();
    expect(calls[1].toolChoice).toMatchObject({ type: "tool", toolName: "make_chart" });
  });

  it("a python / matplotlib / plotly request is not forced to make_chart and keeps run_python", async () => {
    for (const q of [
      "Write a python script that plots the under-50 ASR by year",
      "Plot the under-50 rate by year with matplotlib",
      "Make a plotly chart of the under-50 trend",
      "Use run_python to compare the under-50 rate by year",
    ]) {
      const { model, calls } = recording();
      setModelOverride(model);
      await (await ask(q)).json();
      expect(calls.length).toBe(2);
      expect(calls[1].toolChoice).not.toMatchObject({ type: "tool", toolName: "make_chart" });
      expect(calls[1].tools).toContain("run_python");
    }
  });
});

describe("doctor privacy (mock model)", () => {
  it("names never reach the model, in the same turn or from history", async () => {
    const s = scripted([{ name: "list_high_risk_patients", input: {} }, { name: "make_patient_widget", input: { display_id: "ES-0001-A" } }], "ES-0001-A is HIGH risk (13.1%).");
    setModelOverride(s.model);
    const res = await app.request("/agent/chat", {
      method: "POST", headers: DOC,
      body: JSON.stringify({ id: "c-doc", message: { id: "d1", role: "user", parts: [{ type: "text", text: "Show me my highest-risk patient" }] } }),
    });
    const sse = await res.text();
    expect(sse).toContain("Alice Uwase"); // the clinician's UI gets the full patient card
    const conv = await waitFor(() => getConv("c-doc", DOC), (c) => c?.messages?.length === 2);
    expect(conv.messages[1].parts.some((p: { type: string }) => p.type === "tool-make_patient_widget")).toBe(true);
    expect(s.prompts.length).toBe(3);
    for (const p of s.prompts) expect(p).not.toMatch(NAMES);
    // second turn: the persisted widget output is converted back for the model through toModelOutput
    const s2 = scripted([], "Consider endoscopy referral.");
    setModelOverride(s2.model);
    await (await app.request("/agent/chat", {
      method: "POST", headers: DOC,
      body: JSON.stringify({ id: "c-doc", message: { id: "d2", role: "user", parts: [{ type: "text", text: "What should I do next?" }] } }),
    })).text();
    expect(s2.prompts[0]).toContain("ES-0001-A");
    expect(s2.prompts[0]).not.toMatch(NAMES);
  });
});

describe("MCP endpoint", () => {
  const rpc = (body: unknown, headers: Record<string, string> = { "X-Role": "ministry" }) =>
    app.request("/mcp", { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

  it("initialize + tools/list + tools/call (stateless)", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("early-signals");
    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_kpis", "query_marts", "ask_early_signals_agent"]));
    expect(names).not.toContain("get_patient");
    const call = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_kpis", arguments: { year: 2025 } } })).json();
    expect(call.result.structuredContent).toMatchObject({ ok: true, year: 2025 });
  });

  it("doctor connection gets pseudonymised patient tools", async () => {
    const h = { "X-Role": "doctor", "X-Facility-Id": "101" };
    const call = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_patient", arguments: { display_id: "ES-0001-A" } } }, h)).json();
    expect(call.result.structuredContent.ok).toBe(true);
    expect(JSON.stringify(call)).not.toMatch(NAMES);
    const res = await (await rpc({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "earlysignals://current" } }, h)).json();
    expect(res.result.contents[0].text).toContain('"facility_id": 101');
  });

  it("rejects a doctor connection without a facility", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }, { "X-Role": "doctor" });
    expect(r.status).toBe(400);
  });
});
