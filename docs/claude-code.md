# Built with Claude Code

Early Signals was written almost entirely by **Claude Opus 5.5** in [Claude Code](https://claude.com/claude-code), with
the team setting direction, reviewing and making the calls. This page lists the Claude Code features we used and the
automations that ship in the repo.

## How we built it

| Feature | How we used it |
|---|---|
| **Spec-first agentic build** | [`spec.md`](spec.md) was written as the single source of truth for humans and agents, with frozen contracts (schemas, tables, API shapes). Each deviation got one line in [`decisions.md`](decisions.md) (D-01 to D-60) |
| **`/goal`** | Long autonomous runs against a clear finish line ("all planted insights recovered", "Playwright journeys green"), so Claude kept iterating until the goal was met |
| **`/loop`** | Repeated tasks on an interval, for example `/loop 30m /validate-risk 5` to keep reviewing new HIGH-risk flags, and self-paced polling of long builds |
| **Claude Code on the web (cloud sessions)** | Most of the code was built in cloud sessions on `claude/*` branches, so work kept going without a laptop open |
| **Routines** | A daily routine (07:00 Africa/Kigali) starts a fresh cloud session that runs `/daily-report` and pushes the PDF |
| **Project skills** | `/validate-risk` and `/daily-report` in `.claude/skills/` (see below) |
| **Hooks and settings** | A SessionStart hook (`.claude/hooks/session-start.sh`) prepares cloud sessions; `.claude/settings.json` holds the permission allow and deny lists |
| **`CLAUDE.md`** | Repo notes for Claude: data rules (synthetic only, display IDs, no diagnosis words to patients), the project map and the commands |
| **Subagents and workflows** | Parallel agents for independent workstreams and reviews, and multi-agent workflows for larger fan-out tasks |
| **Git worktrees and `/fork`** | Isolated worktrees for parallel features (brand, 3D fixes, videos) and forked sessions to try alternatives |
| **Monitor** | Watching long-running builds, training and renders without blocking the session |
| **MCP** | The agent's own MCP server (`/mcp`) plugs Early Signals into Claude Code. See [agent-and-mcp.md](agent-and-mcp.md) |
| **`/brag`** | Produced the demo sizzle reel from real captures of the running app |

Claude also runs inside the product: the agent and the dashboard's AI features can use Claude through the Anthropic
provider (`AGENT_PROVIDER=anthropic`, `LLM_PROVIDER=anthropic`), and the agent evals can use Claude as the judge.

## Automations in this repo

Both skills need published data (`make dev-data` builds a small MySQL-free dataset). They identify patients by display
ID only.

| Command (in Claude Code) | What it does |
|---|---|
| `/validate-risk 5` | Fetches the 5 newest HIGH-risk patients that have not been reviewed yet (`scripts/risk_validation.py cases`). Claude checks each flag against the record (alarm features, labs, H. pylori, endoscopy status, demographics) and appends a verdict (`agree / disagree / uncertain`, confidence, evidence, per-reason checks) to `reports/risk_validation.jsonl`. It then commits and pushes `reports/` |
| `/loop 30m /validate-risk 5` | Repeats the review every 30 minutes for as long as the session is open. Once every HIGH case is reviewed, each run does nothing |
| `/daily-report` | Builds `reports/daily/<today>.pdf`, a one-page A4 brief with KPIs, trend, alerts by trigger, care coordination (new plans, overdue tasks, completion rate, days to endoscopy), the 2031 outlook, the top 8 high-risk patients with Claude's verdicts, data quality and provenance. Adds 3-4 observations against the previous day, then commits and pushes |

`/loop` lasts only as long as the session. The **daily Routine** is the durable schedule. A fresh cloud session has no
generated data, so the report renders from the committed `reports/snapshots/latest.json` and the validation log. The
snapshot is refreshed whenever validations are appended or a report is built against live data.

```bash
make validate-cases N=5                                  # what /validate-risk sees, as JSON
uv run python scripts/risk_validation.py summary         # agreement so far
make report                                              # PDF for today (live data, or the snapshot)
uv run python scripts/daily_report.py --from-snapshot --check
```

See [`reports/README.md`](../reports/README.md) for the file formats.
