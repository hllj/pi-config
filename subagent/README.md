# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process

- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes; `session_shutdown` on quit kills children + marks records `aborted`
- **Per-agent/step timeout**: `timeoutMs` kills runaway subagents (SIGTERM → SIGKILL)
- **Context files**: Inject file contents into an agent's system prompt via `contextFiles`
- **Structured output**: `expect` JSON-Schema contracts validated after completion
- **Cross-agent messaging**: `send_message`/`get_messages` with delivery status; pending messages are injected into the next spawn of the recipient
- **Running-subagents widget + `/agents`** screen showing live subagent processes
- **Workflow persistence**: per-step `appendEntry`; interrupted workflows can be inspected via `get_workflow` and resumed via `resume_workflow`
- **Parallel workflow steps**: consecutive `parallelGroup` members run concurrently
- **Persistent run store**: every dispatch is recorded to disk — a real pi session file per run (crash-safe, replayable via `pi --resume`) plus a queryable `record.json` — tracked via `/runs`, `list_subagent_sessions`, and `get_subagent_session`

## Structure

```
pi-config/subagent/          # Symlinked to ~/.pi/agent/extensions/subagent
├── index.ts                  # The extension (entry point)
├── agents.ts                 # Agent discovery + frontmatter parsing
├── expect.ts                 # Structured-output (JSON Schema) contract validation
├── messaging.ts              # Cross-agent message store + delivery status
├── workflow-engine.ts        # Workflow state machine (conditions, errors, resume)
├── workflow-renderer.ts      # Workflow TUI rendering
├── session-store.ts          # Persistent run store (record.json + child session files)
├── runs-screen.ts            # /runs TUI screen
├── agents/                   # Agent definitions ★ NOW CO-LOCATED HERE
│   ├── scout.md              # Fast codebase recon with pi-lens
│   ├── planner.md            # Implementation plans with pi-lens
│   ├── reviewer.md           # Code review with pi-lens diagnostics
│   ├── worker.md             # Test-first (TDD) implementation with pi-lens verification
│   └── general.md            # All-rounder fallback: investigate/plan/implement/verify end-to-end
├── prompts/                  # Workflow prompts ★ NOW CO-LOCATED HERE
│   ├── implement.md          # scout → planner → worker
│   ├── scout-and-plan.md     # scout → planner (no implementation)
│   └── implement-and-review.md  # worker → reviewer → worker
└── README.md                 # This file

Sibling links:
  ~/.pi/agent/agents/*.md    → pi-config/subagent/agents/*.md
  ~/.pi/agent/prompts/*.md   → pi-config/subagent/prompts/*.md
```

## Agent Definitions

Agents are markdown files with YAML frontmatter. Key fields:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls, bash, lsp_diagnostics, project_report
model: openrouter/anthropic/claude-sonnet-4.5
---

System prompt for the agent goes here.
```

### `tools` field

Controls which tools the subagent can call. Available tools include built-ins (`read`, `bash`, `edit`, `write`, etc.) and pi-lens code intelligence tools (`lsp_diagnostics`, `project_report`, `module_report`, `symbol_search`, etc.). See the agent definitions in `agents/` for per-agent tool assignments.

### `model` field

When omitted, the subagent inherits the dispatching session's active model and thinking level. When set, overrides per-agent (e.g., Haiku for fast scouts, Sonnet for heavy analysis).

### New frontmatter fields

| Field | Type | Effect |
| ----- | ---- | ------ |
| `timeoutMs` | number | Kill the subagent after this many ms (SIGTERM → SIGKILL). Per-call `timeoutMs` overrides. |
| `thinking` | string | Request a specific thinking level (e.g. `high`). Pushed via `--thinking` when the agent has no explicit `model`. |
| `temperature` | number | Advisory only — pi has no CLI flag, so it becomes a prompt-level directive. |
| `env` | map | Extra environment variables merged over `process.env` when spawning. |
| `readonly` | boolean | Instructs the agent not to create/modify/delete files (prompt-level constraint). |
| `contextFiles` | list/string | Files (relative to cwd) whose contents are injected into the system prompt. Per-call `contextFiles` overrides. |

**Locations:**

- `~/.pi/agent/agents/*.md` — User-level (always loaded, now symlinked to `pi-config/subagent/agents/`)
- `.pi/agents/*.md` — Project-level (only with `agentScope: "project"` or `"both"`)

## Workflow Prompts

| Prompt | Flow | Description |
| -------- | ------ | --------------- |
| `/implement <query>` | scout → planner → worker | scout finds code, planner creates plan, worker implements **test-first (TDD)** |
| `/scout-and-plan <query>` | scout → planner | Understand codebase before deciding on changes |
| `/implement-and-review <query>` | worker → reviewer → worker | worker implements **test-first (TDD)** → reviewer checks → worker fixes issues |

## Proactive triggering

`subagent`, `run_workflow`, and `list_agents` carry `promptSnippet` (so they appear in the
default system prompt's "Available tools" summary — custom tools without one are omitted
from it entirely) and `subagent`/`run_workflow` carry `promptGuidelines` (delegate/don't-delegate
heuristics appended to the system prompt's Guidelines section whenever this extension is
loaded). This is what makes the model reach for a subagent on its own — without it, the only
"when to delegate" guidance lived in `skills/subagents/SKILL.md`, and per Pi's own skill docs
models don't reliably self-load full skill content ("models don't always do this; use
prompting or `/skill:name` to force it" — see `pi`'s `docs/skills.md`). Keep both fields in
sync with the `subagents` skill's "Decide: delegate or not?" section if that guidance changes.

## Usage

### Single agent

```
Use scout to find all authentication code
```

### Parallel execution

```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow

```
Use a chain: first have scout find the session store, then have planner suggest improvements
```

### Workflow prompts

```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
| ------ | ----------- | ------------- |
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |
| Workflow | `workflow` / `run_workflow` | Steps with conditions, error handlers, approval gates, parallel groups, per-step timeout |

Per-call options on single/parallel/chain items and workflow steps:

- `timeoutMs` — kill the subagent after this many ms
- `contextFiles` — inject file contents into the agent's system prompt
- `expect: { jsonSchema, description }` — validate the agent's final message against a JSON Schema (failed contracts fail the step/chain)

Workflow steps additionally support:

- `parallelGroup` — consecutive steps with the same id run concurrently (bounded by 4)
- `condition` — `outputContains` / `exitCodeEquals` gate on the previous output
- `errorHandler` — `retry` / `skip` / `fallback` / `abort` strategies
- `requiresApproval` — pause for manual confirmation

## Workflows: persistence & resume

Workflows persist every state transition via `pi.appendEntry("subagent-workflow", ...)`:

- `get_workflow` — inspect the latest (or a specific) workflow's step statuses/outputs
- `resume_workflow` — resume a paused/failed workflow from the first incomplete step (or `fromStep`); previously completed steps keep their results
- On session restart, running/paused workflows hydrate as **paused** (never auto-resume)

## TUI

- `/agents` — screen listing available agents + currently running subagent processes
- `/runs` — screen listing persistent run records (historical + live); `r` = refresh, `Esc` = close
- A `subagents` status/widget shows running subagent count and in-flight tasks

## Run Store (persistent, trackable sessions)

Every subagent dispatch is recorded durably on disk so runs can be audited and replayed later:

```text
<storeRoot>/subagents/<runId>/
  <timestamp>_<sessionId>.jsonl   # the child's own pi session (--session-dir) — crash-safe, replayable
                                # (code discovers the single/latest *.jsonl in the run dir)
  record.json                   # SubagentRunRecord — atomic tmp+rename rewrites, never torn
```

- **Store location** (resolution order): `PI_SUBAGENT_SESSION_DIR` env override → `<dirname(dirname(session dir))>/subagents` (next to pi's own `sessions/`) → `~/.pi/agent/subagents` for in-memory sessions.
- **Recorded per run**: agent, task, model, mode (single/parallel/chain/workflow), workflowId/step, parent session linkage, pid, status, timing, exit code, error, token/cost usage, turns, and the final output summary.
- **Statuses**: `running`, `completed`, `failed`, `timed_out`, `aborted`, `orphaned`.
- **Tracking surfaces**: `list_subagent_sessions` (store-wide query: agent/status/mode/workflow filters) and `get_subagent_session` (full record + transcript tail) as tools; `/runs` as a TUI screen. Each run also leaves one compact `subagent-session` pointer entry in the parent session so `/resume` of the session shows the run history inline.
- **Hydration**: on `session_start` the extension rebuilds the in-session run map from parent-session pointers, reconciles orphans (stale `running` records whose pid died → `orphaned`), and prunes old runs.
- **Shutdown**: on `/quit`, live subagent processes are killed via a synchronous SIGTERM (+bounded ~200ms SIGKILL escalation) and their records marked `aborted`; `reload`/`new`/`resume`/`fork` leave children running.
- **Retention**: `pruneStore` deletes runs older than 14 days (or `PI_SUBAGENT_RETENTION_DAYS`) and beyond 500 runs; live runs are never pruned.

## Agent Messaging

- `send_message` — send from one agent to another (persisted via session entries)
- `get_messages` — retrieve by `sent` / `received` / `all`, with delivery status (pending/delivered/failed)
- When an agent with pending messages is spawned, those messages are injected into its task prompt; after the run they are marked delivered (or failed)

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.
