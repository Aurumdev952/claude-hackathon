# AI agent and MCP

`agent/` is a Node service (Hono + Vercel AI SDK 7) with two agents:

- a **clinical assistant** for doctors (facility-scoped, patient widgets);
- a **ministry analyst** for health officials (aggregates only, cells under 5 suppressed).

Both read the published DuckDB marts read-only and answer with chart widgets by default. They can run small Python
plotting scripts in a sandbox, and they keep chats in SQLite (edit, rewind, regenerate). Numbers in each answer are
checked against the tool outputs. The care tools can draft a care plan as a preview only: the agent never creates or
sends anything, and a doctor approves in the UI.

```bash
make agent-setup        # pnpm install + sandbox venv
make agent-dev          # http://localhost:8787/agent/health ; the dashboard chat is at /agent
make agent-test         # unit tests
make eval-agent         # DeepEval readiness gate (needs a running agent at AGENT_URL)
```

## Model

| Setting | Meaning |
|---|---|
| `AGENT_PROVIDER` | `openrouter` (default), `anthropic` (Claude, uses `ANTHROPIC_API_KEY`) or `openai-compatible` |
| `AGENT_MODEL` | Model id for the provider (default `deepseek/deepseek-v4.1-flash` on OpenRouter, `claude-sonnet-5-5` on Anthropic) |
| `AGENT_EFFORT` | `low`, `medium` (default), `high`, `xhigh` or `max` |
| `OPENROUTER_API_KEY` | Key for OpenRouter |
| `AGENT_BASE_URL` | Endpoint for a self-hosted or government-hosted model (`openai-compatible`) |

## Connect your own agent through MCP

The agent exposes its tools over MCP (Streamable HTTP) at `/mcp`. There is no auth in the demo.

```bash
claude mcp add --transport http early-signals http://localhost:8787/mcp -H "X-Role: ministry"
claude mcp add --transport http early-signals-doctor http://localhost:8787/mcp -H "X-Role: doctor" -H "X-Facility-Id: 1215"
```

`.mcp.json` equivalent:

```json
{ "mcpServers": { "early-signals": { "type": "http", "url": "http://localhost:8787/mcp", "headers": { "X-Role": "ministry" } } } }
```

Details: [`agent/README.md`](../agent/README.md). Evals: [`evals/agent/README.md`](../evals/agent/README.md).
