# Subagent Extension — with pi-lens Code Intelligence

Delegate tasks to specialized subagents with isolated context windows. Enhanced with **pi-lens** code intelligence tools (`lsp_diagnostics`, `project_report`, `module_report`, `symbol_search`, etc.).

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **pi-lens integration**: Every agent has access to relevant pi-lens tools for code analysis
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Per-agent/step timeout**: `timeoutMs` kills runaway subagents (SIGTERM → SIGKILL)
- **Context files**: Inject file contents into an agent's system prompt via `contextFiles`
- **Structured output**: `expect` JSON-Schema contracts validated after completion
- **Cross-agent messaging**: `send_message`/`get_messages` with delivery status; pending messages are injected into the next spawn of the recipient
- **Running-subagents widget + `/agents`** screen showing live subagent processes
- **Workflow persistence**: per-step `appendEntry`; interrupted workflows can be inspected via `get_workflow` and resumed via `resume_workflow`
- **Parallel workflow steps**: consecutive `parallelGroup` members run concurrently

## Structure

```
pi-config/subagent/          # Symlinked to ~/.pi/agent/extensions/subagent
├── index.ts                  # The extension (entry point)
├── agents.ts                 # Agent discovery + frontmatter parsing
├── expect.ts                 # Structured-output (JSON Schema) contract validation
├── messaging.ts              # Cross-agent message store + delivery status
├── workflow-engine.ts        # Workflow state machine (conditions, errors, resume)
├── workflow-renderer.ts      # Workflow TUI rendering
├── agents/                   # Agent definitions ★ NOW CO-LOCATED HERE
│   ├── scout.md              # Fast codebase recon with pi-lens
│   ├── planner.md            # Implementation plans with pi-lens
│   ├── reviewer.md           # Code review with pi-lens diagnostics
│   └── worker.md             # General-purpose with pi-lens verification
├── prompts/                  # Workflow prompts ★ NOW CO-LOCATED HERE
│   ├── implement.md          # scout → planner → worker
│   ├── scout-and-plan.md     # scout → planner (no implementation)
│   └── implement-and-review.md  # worker → reviewer → worker
└── README.md                 # This file

Sibling links:
  ~/.pi/agent/agents/*.md    → pi-config/subagent/agents/*.md
  ~/.pi/agent/prompts/*.md   → pi-config/subagent/prompts/*.md
```

## Enhanced Agents with pi-lens Tools

Each agent definition now includes pi-lens tools relevant to its role:

| Agent | pi-lens Tools | Why |
| ------- | -------------- | ----- |
| **scout** | `project_report`, `module_report`, `symbol_search`, `lsp_diagnostics`, `lsp_navigation`, `ast_grep_search`, `read_enclosing`, `read_symbol` | Project orientation → symbol discovery → file drill-down → error checking |
| **planner** | `project_report`, `module_report`, `symbol_search`, `lsp_diagnostics`, `read_enclosing`, `read_symbol` | Verify structure, check pre-existing issues, understand dependencies |
| **reviewer** | `lsp_diagnostics`, `lens_diagnostics`(full), `project_report`, `module_report`, `symbol_search`, `ast_grep_search` | Auto-detect type/lint errors, security patterns, circular deps, dead code |
| **worker** | `lsp_diagnostics`, `lens_diagnostics`, `module_report`, `symbol_search`, `read_symbol` | Post-edit verification — catch errors immediately |

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

Controls which tools the subagent can call. pi-lens tools are:

- `pi_lens_activate_tools` — **must be included** if the agent uses `lsp_navigation` or `ast_grep_search`/`ast_grep_replace` (those need activation first)
- `lsp_diagnostics` — type/lint errors (server scope)
- `lens_diagnostics` — broader scan (dead-code, circular deps, secrets, CVEs)
- `project_report` — project-level orientation
- `module_report` — file-level outline + who-uses-this
- `symbol_search` — rank-based identifier search
- `read_enclosing` — read around a line number
- `read_symbol` — read one symbol body
- `lsp_navigation` — go-to-def/references (requires `pi_lens_activate_tools` too)
- `ast_grep_search` — semantic AST search (requires `pi_lens_activate_tools` too)
- `ast_grep_replace` — AST-aware code rewrite
- `ast_grep_outline` — syntax-only file structure
- `lens_diagnostic_mark` — record disposition for a diagnostic

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

| Prompt | Flow | pi-lens Value |
| -------- | ------ | --------------- |
| `/implement <query>` | scout → planner → worker | scout uses `project_report`+`symbol_search`, planner uses `module_report`, worker uses `lsp_diagnostics` for verification |
| `/scout-and-plan <query>` | scout → planner | Understand codebase before deciding on changes |
| `/implement-and-review <query>` | worker → reviewer → worker | Worker implements → reviewer runs `lsp_diagnostics`+`lens_diagnostics` → worker fixes issues |

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
- A `subagents` status/widget shows running subagent count and in-flight tasks

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
