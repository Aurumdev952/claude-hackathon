# Early Signals agent (`agent/`)

Node 22 + [Hono](https://hono.dev) backend for the Early Signals AI agent: two personas (ministry / doctor) on the
Vercel AI SDK 7, read-only access to the published DuckDB data marts, chart and patient widgets, persisted chats
(SQLite via Drizzle + libsql) with edit / rewind / regenerate, a Python visualisation sandbox and an MCP server that
exposes the same data tools to other agents. All data is synthetic. No authentication anywhere (demo only).

```
                         ┌──────────────── agent/ (Hono, :8787) ─────────────────────────────┐
 React /agent (useChat) ─┤ POST /agent/chat (SSE)      ┌─ agents/{ministry,doctor}.ts (prompts)│
 evals, scripts ─────────┤ POST /agent/chat/complete ──┤  agents/run.ts streamText + tools     │── OpenRouter / gov model
 other agents (MCP) ─────┤ /mcp (Streamable HTTP) ─────┘  tools/* (same objects for MCP)      │
                         │   │                                │                                 │
                         │   ▼                                ▼                                 │
                         │ db/repo.ts (Drizzle)        db/duck.ts READ_ONLY, external access off │
                         │ agent/data/agent.sqlite     data/analytics/current.json -> serve_*.duckdb
                         │                             guardrails/{sql,suppress,numbers}.ts      │
                         │ sandbox/runner.ts ── unshare -n · prlimit · timeout ── sandbox/.venv  │
                         └───────────────────────────────────────────────────────────────────────┘
```

## Run

```bash
make agent-setup          # pnpm install + uv sync --project agent/sandbox
make agent-dev            # tsx watch, http://localhost:8787  (or: cd agent && pnpm build && pnpm start)
make agent-test           # vitest: guardrail parity, tools on a fixture DB, repo, sandbox, HTTP + MCP (mock model)
make agent-smoke          # end-to-end against the running agent and the real published data (calls the model)
cd agent && pnpm mcp:check [--doctor <facility_id>]   # MCP client round trip
```

The agent reads `../.env` (and `agent/.env`) with dotenv; process environment wins. It needs a published serve DB
(`make dev-data` / the pipeline) and follows `data/analytics/current.json` exactly like `api/deps.py` (blue/green swap
without restart).

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | - | OpenRouter key (default provider) |
| `AGENT_MODEL` | `deepseek/deepseek-v4.1-flash` | model id |
| `AGENT_PROVIDER` | `openrouter` | `openai-compatible` for a government / self-hosted endpoint |
| `AGENT_BASE_URL`, `AGENT_API_KEY` | - | base URL (`.../v1`) and key for `openai-compatible` |
| `AGENT_PORT` | `8787` | |
| `AGENT_DB_PATH` | `agent/data/agent.sqlite` | chat history (relative paths resolve from the repo root) |
| `AGENT_ARTIFACTS_DIR` | `agent/data/artifacts` | sandbox outputs, 7-day TTL |
| `SANDBOX_TIMEOUT_S`, `SANDBOX_MEM_MB` | `30`, `2048` | sandbox limits |
| `AGENT_MAX_STEPS` | `8` | tool-loop steps per turn |
| `AGENT_SERVE_DB` | - | pin a specific DuckDB file (tests use the fixture) instead of following `current.json` |

Model check (2026-10-01): `deepseek/deepseek-v4.1-flash` is listed on OpenRouter and tool calling works (including
forced `tool_choice`). `deepseek/deepseek-v4.1` (the planned eval judge) is **not** listed; the closest are
`deepseek/deepseek-v4-pro` or `~deepseek/deepseek-pro-latest`.

## Roles and context

Same contract as the FastAPI (`api/deps.py`): `X-Role: ministry|doctor` (default ministry) and `X-Facility-Id: <int>`
(required for doctor). Errors use the FastAPI envelope `{"error": {"code", "message", "details"}}`
(`INVALID_ROLE`, `FACILITY_REQUIRED` 400; `FORBIDDEN` 403; `NOT_FOUND` 404; `INVALID_REQUEST` 400 with zod issues).
Conversations are pinned to the role + facility that created them; requests with other headers get 403.

## HTTP API

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/agent/health` | - | `{status, serve:{ready, run_id, sim_time, published_at, active, file}, model:{provider, model, base_url}, model_configured, sandbox:{ready, python, network_isolation, prlimit, timeout_s, mem_mb}, mcp}` |
| GET | `/agent/suggestions` | headers | `{data:{role, questions: string[]}}` |
| GET | `/agent/tools` | headers | `{data:[{name, title, label, description}]}` (tools of the header role) |
| GET | `/agent/conversations` | `?limit=` | `{data: Conversation[]}` for the header role (+ facility), newest first |
| POST | `/agent/conversations` | `{id?, title?}` | `201 {data: Conversation}` |
| GET | `/agent/conversations/:id` | - | `{data: Conversation & {messages: UIMessage[]}}` |
| PATCH | `/agent/conversations/:id` | `{title}` | `{data: Conversation}` |
| DELETE | `/agent/conversations/:id` | - | `{data:{id, deleted:true}}` |
| POST | `/agent/conversations/:id/truncate` | `{messageId, inclusive}` | `{data:{id, deleted, messages: UIMessage[]}}` |
| POST | `/agent/chat` | `{id, message?, messages?, trigger?, messageId?}` | AI SDK UI message stream (SSE), header `X-Conversation-Id` |
| POST | `/agent/chat/complete` | `{question? , messages?, conversation_id?, persist?}` | `{data:{conversation_id, role, facility_id, answer, tool_calls, widgets, retrieval_context, validated_numbers, unsupported_numbers, metadata, message, latency_ms}}` |
| GET | `/agent/artifacts/:run/:file` | - | sandbox file (PNG / HTML with a restrictive CSP / CSV / JSON); no role header needed |
| * | `/mcp` | JSON-RPC | MCP Streamable HTTP (see below) |

`Conversation = {id, role, facility_id, title, created_at, updated_at, run_id, message_count?, last_message_preview?}`.
`UIMessage` is the AI SDK 7 shape `{id, role, parts, metadata?}`; parts are stored verbatim (tool outputs included), so
widgets re-render after reload without re-running tools.

### `/agent/chat` (for `useChat`)

- `id`: the conversation id (`useChat({ id })`). Unknown ids create the conversation (title = first user text).
- `trigger: "submit-message"` (default): `message` (or the last of `messages`) must be a user message. It is appended; if
  a message with that id already exists it is replaced in place and everything after it is dropped (edit).
- `trigger: "regenerate-message"` + `messageId` = the assistant message to replace (truncated inclusive); without
  `messageId` trailing assistant messages are dropped. The history must then end with a user message.
- The server always rebuilds the full history from the DB, so the client should send only the last message:

```ts
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { MessageMetadata } from "@agent/widgets";

const { messages, sendMessage, regenerate, setMessages, stop, status } = useChat<UIMessage<MessageMetadata>>({
  id: conversationId,
  messages: initialMessages,                       // GET /agent/conversations/:id -> data.messages
  transport: new DefaultChatTransport({
    api: "/agent/chat",
    headers: () => ({ "X-Role": role, ...(facilityId ? { "X-Facility-Id": String(facilityId) } : {}) }),
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
      body: { id, message: messages.at(-1), trigger, messageId },
    }),
  }),
});
```

- Edit a user message: `POST truncate {messageId, inclusive: true}` -> `setMessages(data.messages)` -> `sendMessage({ text })`.
- Rewind to a message: `POST truncate {messageId, inclusive: false}` -> `setMessages(data.messages)`.
- Regenerate: `regenerate({ messageId: assistantId })`.
- Assistant `message.metadata` (`MessageMetadata` in `src/widgets/specs.ts`): `run_id, sim_time, model, role, facility_id,
  created_at, finished_at, usage, finish_reason` arrive on stream start / finish; `validated_numbers,
  unsupported_numbers, tools_called` are added when the message is persisted (reload to see them).
- Tool parts arrive as `part.type === "tool-<name>"` with `state` `input-streaming | input-available | output-available |
  output-error`; reasoning parts (`type: "reasoning"`) are streamed too.

## Widgets (`src/widgets/specs.ts`, imported by the UI via the `@agent/widgets` alias; zod only)

| Tool part | `part.output` | Notes |
|---|---|---|
| `tool-make_chart` | `ChartWidget {kind:"chart", id, spec: ChartSpec}` or `{ok:false, error, available_columns}` | `ChartSpec` = discriminated union on `type` |
| `tool-make_patient_widget` | `PatientWidget {kind:"patient", ...}` | doctor only; includes `name` for the clinician's screen |
| `tool-run_python` | `ArtifactSpec {kind:"artifact", run, ok, files:[{name,url,mime,kind,bytes}], stdout, stderr, error, timed_out}` | render `<img src=url>` or a sandboxed `<iframe src=url>` |

`ChartSpec` types (all carry `title, subtitle?, caption?, unit?, caveats?, source?{tool, sql, note}`):

- `line` / `area`: `x:{key,label?,kind?}`, `series:[{key, label?, lci?, uci?, dashed?, axis?}]`, `data: Row[]`,
  `annotations?:[{x,label}]`, `referenceLines?:[{y,label}]` (+ `stacked?` for area). CI band from `lci`/`uci` columns.
- `bar`: same axes/series, `orientation?: "vertical"|"horizontal"`, `stacked?`.
- `kpi`: `tiles:[{label, value|null, valueLabel? ("<5"), unit?, format?, ci?:[l,u], delta?, deltaLabel?, trend?: number[]}]`.
- `table`: `columns:[{key,label?,format?}]`, `data`.
- `choropleth`: `level:"district"|"province"`, `geoKey` (district codes like `NOR-MUS` / province codes), `valueKey`,
  `labelKey?`, `categorical?` (e.g. `lisa_quadrant` HH/LL/HL/LH/NS), `data`.
- `forest`: `labelKey, estimateKey, lciKey, uciKey, reference?` (1 for ratios, 0 for differences), `logScale?`, `data`.

`Row = Record<string, string|number|boolean|null>`; suppressed cells are `null` with a sibling `<col>_label: "<5"`
(`cases_label` for `cases`). `PatientWidget` carries `risk {band, probability, t1_score, rank_in_facility, as_of,
scoped_since_flag, first_high_at, top_reasons[{feature,label,contribution,value}]}`, `risk_history`, `timeline {window,
events[{ts,event_type,label,value_num,value_text,unit,is_abnormal,facility,highlight}], series{hb,weight}}`, `labs`,
`alerts`, `suggested_actions` (phrased "Consider ..."), `links {case: "/doctor/case/<id>", api}`.
`TOOL_LABELS`, `MINISTRY_TOOLS`, `DOCTOR_TOOLS` are exported for the UI and evals.

## Tools per role

| Tool | Ministry | Doctor | Notes |
|---|---|---|---|
| `describe_tables` | x | x | semantic layer + information_schema of the tables the role may query |
| `query_marts` | x | x | guarded SQL, `{sql_executed, columns, rows, row_count, truncated, caveats, dataset_id}`; errors as data |
| `get_kpis` | x | | port of `/kpis` |
| `get_rates_trend` | x | | `/rates` + `/trends/joinpoint` (APC, AAPC) |
| `get_district_ranking` | x | | `/rates/map` (ASR, SIR, LISA hotspots, HP testing, stage IV) |
| `get_care_cascade` | x | | `/cohort/funnel` |
| `get_stage_mix` | x | | `/stage-mix` (+ chi-square by tier) |
| `get_survival` | x | | `/survival/summary` (+ KM curve, Cox) |
| `get_facility_quality` | x | | `/facilities/quality` |
| `get_model_metrics` | x | x | `/models` + subgroups |
| `get_patient`, `get_patient_timeline`, `get_patient_risk`, `list_high_risk_patients`, `list_alerts` | | x | ports of `api/routers/patients.py` with the facility access check and the `app_state.sqlite` alert-status overlay |
| `make_chart` | x | x | the chart widget; references a `dataset_id` from a data tool (exact rows) or takes inline `data` |
| `make_patient_widget` | | x | the patient card |
| `run_python` | x | x | sandbox, max 2 runs per answer |

Data tools return `dataset_id` + `rows`; datasets are rebuilt from persisted tool parts, so follow-up turns can chart
earlier results. After a data tool returns rows for a trend / comparison / ranking question the next step is forced to
`make_chart`; a doctor question about one patient is forced to `make_patient_widget` once the patient is known.

## Guardrails and privacy

- SQL (`src/guardrails/sql.ts`, port of `api/llm/guardrails.py` + `nl2sql.py`): parsed by DuckDB itself
  (`json_serialize_sql`); exactly one SELECT, no table functions, no `read_*` / forbidden functions, no schema-qualified
  tables, allow-listed tables only (scope-aware CTE handling), `LIMIT 1000` added. Ministry: `mart_*`, `ml_*`,
  `ref_district`, `ref_province` minus patient-level marts (any table with a patient key, case points, training tables).
  Doctor: plus `pt_*` and `ml_risk_history`, all shadowed by facility-scoped CTEs that also drop name / birthdate
  columns. Execution on a READ_ONLY instance with `enable_external_access=false`, 5 s interrupt watchdog.
- Ministry outputs: small-cell suppression (`suppressed` flag as in `epi._suppress`, any count column < 5 with its derived
  rates) and de-identification. Doctor outputs: the UI gets full objects; the model only gets the pseudonymised view
  through `toModelOutput` (no names, birth dates or contact details; `display_id` + clinical data), also when history is
  replayed. MCP clients only ever receive these model-safe views.
- `numbersSupported` (port of `numbers_supported`) runs on every answer against all tool outputs of the conversation;
  the result is stored as `metadata.validated_numbers` / `unsupported_numbers`.

## MCP server

Streamable HTTP at `http://localhost:8787/mcp`, stateless, no auth, CORS open. The role comes from the connection
headers. Tools: the data tools of that role + `ask_early_signals_agent({question, role?, facility_id?})` (runs the whole
agent in-process, returns the answer, model-safe tool calls, widgets and `validated_numbers`). Resources:
`earlysignals://semantic-layer`, `earlysignals://glossary`, `earlysignals://current`, `earlysignals://tables/{name}`,
`earlysignals://suggestions/{role}`. Prompts: `ministry_briefing`, `district_profile`, `patient_review`,
`care_cascade_review`.

```bash
# Claude Code
claude mcp add --transport http early-signals http://localhost:8787/mcp -H "X-Role: ministry"
claude mcp add --transport http early-signals-doctor http://localhost:8787/mcp -H "X-Role: doctor" -H "X-Facility-Id: 1215"
# MCP Inspector
npx @modelcontextprotocol/inspector   # transport "Streamable HTTP", URL http://localhost:8787/mcp, header X-Role: ministry
```

Claude Desktop / other clients that accept remote HTTP servers in JSON:

```json
{
  "mcpServers": {
    "early-signals": { "type": "http", "url": "http://localhost:8787/mcp", "headers": { "X-Role": "ministry" } }
  }
}
```

Clients that only speak stdio can bridge with `npx mcp-remote http://localhost:8787/mcp --header "X-Role: ministry"`.

## Python sandbox (`run_python`)

Separate uv project `agent/sandbox` (pandas, pyarrow, matplotlib, plotly, numpy, scipy). Each run writes `script.py` +
`data.json` (rows of a `dataset_id` or of guarded `sql`) to `agent/data/sandbox/<run>/` and executes
`unshare -n prlimit --as --cpu timeout -s KILL <venv>/bin/python -I -B src/sandbox/prelude.py <run dir>` with a scrubbed
environment (no proxy variables, no API keys). The prelude warms the libraries, drops network modules and installs a
PEP 578 audit hook that blocks sockets, subprocesses, fork/exec, ctypes, network imports, writes outside the run dir and
reads outside the run dir + the Python installation. Open matplotlib figures are saved as PNG, plotly figures assigned to
variables as HTML (plotly.js from its CDN). Artifacts are moved to `AGENT_ARTIFACTS_DIR/<run>/` (7-day TTL).
`/agent/health` reports whether `unshare` network isolation is available.

## Tests

- `pnpm test`: builds `agent/data/fixtures/serve_fixture.duckdb` (`test/fixtures/build-duck.ts`) and runs
  `guardrails.test.ts` (allow / forbid, doctor scoping, suppression, de-identification, `numbersSupported` parity with
  Python outputs), `tools.test.ts`, `repo.test.ts` (create, append, truncate inclusive / exclusive, pinning),
  `sandbox.test.ts` (PNG, socket / `/etc/passwd` / subprocess blocked, infinite loop killed, no network under unshare,
  scrubbed env) and `app.test.ts` (SSE chat + persistence, regenerate, edit / rewind, `/complete`, doctor privacy across
  turns, MCP JSON-RPC) with `MockLanguageModelV4`.
- `pnpm smoke` (needs the running agent + real data + the model): ministry under-50 trend -> line chart with supported
  numbers; doctor highest-risk patient (facility with most HIGH alerts) -> patient widget with no names in model-visible
  outputs; reload, regenerate, truncate, role isolation.
- `pnpm spike`: the B10.1 DuckDB `json_serialize_sql` spike.

## Known limitations

- Small-cell suppression of model-written SQL is key-based (count-like column names); a query that renames a count
  column (e.g. `count(*) AS k`) is not recognised. The typed tools are suppressed explicitly.
- `numbersSupported` is a heuristic port (small integers <= 31 and years always pass).
- No auth, no rate limiting, CORS open: demo only.
