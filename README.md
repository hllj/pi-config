# pi-config

Personal extension pack for the [Pi coding agent](https://github.com/earendil-works/pi) — subagents, workflows, and dev-loop tooling on top of the `@earendil-works/pi-coding-agent` extension API.

`~/.pi/agent/extensions` is a symlink to this repo, so everything here is auto-discovered and loaded into every `pi` session. It ships no runtime of its own — pure extension code, executed via `jiti` (TypeScript runs without a build step).

> **Security note:** extensions run with full system permissions and can execute arbitrary code. Only load code you trust — treat this repo the way you'd treat anything else that runs unsandboxed on every session.

## Setup

Requirements: `pi` installed and on `PATH`, Node ≥ 22 (the test runners use Node's built-in TypeScript type-stripping).

Two independent pieces make up a full personal Pi setup: this repo (the extensions) and a global operating manual (`AGENTS.md`). Neither alone is the full picture — extensions add capability, `AGENTS.md` tells the agent when and how to use it.

### 1. Extensions — symlink this repo into place

```bash
ln -s /path/to/pi-config ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
npm install
npm run setup      # symlinks node_modules -> the global pi install, for type-checking
```

Changes take effect after `/reload` inside a running `pi` session.

### 2. Global operating manual (`~/.pi/agent/AGENTS.md`)

`~/.pi/agent/AGENTS.md` is loaded into **every** `pi` session, regardless of project — it's where the agent's always-on rules live: who it is, the engineering loop (plan → test → implement → review → verify → remember → improve), tool-selection heuristics, and the definition of done. It's personal and machine-specific, not code, so it isn't part of this repo; my current copy is published as a [gist](https://gist.github.com/hllj/53666c537f54a6769157939d90cb7ceb) for reference.

```bash
mkdir -p ~/.pi/agent
curl -fsSL https://gist.githubusercontent.com/hllj/53666c537f54a6769157939d90cb7ceb/raw/AGENTS.md \
  -o ~/.pi/agent/AGENTS.md
```

Treat it as a starting point, not a drop-in — it names this repo's own agents and extensions directly (`subagent`, `verify-guard`, `watchdog`, `run_dev_workflow`, ...), so adapt the tool references if your extension set differs. Project-specific conventions (build/test commands, architecture, gotchas) belong in each project's own `AGENTS.md` instead of here — Pi layers them: global → parent directories → the current directory, all concatenated.

## What's here

### Subagents & workflows (`subagent/`)

The flagship extension — delegate work to isolated child `pi` processes:

| Agent | Role |
| --- | --- |
| `scout` | Fast, read-only recon |
| `planner` | Implementation plans (no edits) |
| `worker` | Test-first (TDD) implementation |
| `reviewer` | Evidence-based review, ends with a `Merge verdict: BLOCK \| OK \| OK with notes` line |
| `evidence-auditor` | Audits one claim against its sources — `supported`/`contradicted`/`unclear`/`missing-evidence` |
| `general` | All-rounder fallback |

- **Dispatch modes**: single, parallel, chain (`{previous}` handoff), and `run_workflow` — with conditions, error handlers (retry/skip/fallback/abort), `parallelGroup` concurrency, approval gates, and crash-safe `resume_workflow`.
- **Persistent run store**: every dispatch is a real, replayable `pi` session (`/runs`, `list_subagent_sessions`, `get_subagent_session`).
- **Watchdog** (`/watchdog`, opt-in, off by default): a live in-session reviewer that fires on a mutating turn or every few tool calls — independent of whether the main model thinks to ask for a review itself.
- **Budget nudges & spawn ceiling**: an optional whole-workflow token budget surfaces one advisory steer at 60%/85% usage; a soft session-wide spawn ceiling catches runaway fan-out.
- Cross-agent messaging (`send_message`/`get_messages`) and structured `expect` (JSON-Schema) output contracts.

See `subagent/README.md` for the full feature list, `subagent/IMPROVEMENT-PLAN.md` for the design rationale and what was deliberately left out, and `subagent/tests/TESTING-PLAN.md` for the live end-to-end test suite covering every agent and workflow path by prompt.

### Dev loop

- **`dev-workflows.ts`** — preset multi-agent pipelines (`swat`/`bugfix`/`refactor`/`explore`) launched with one call via `run_dev_workflow` or `/dev <type> <topic>`; `/dev-auto` (opt-in) adds event-driven nudges toward using it.
- **`verify-guard.ts`** — advisory nudge (opt-in, `/verify-guard`) when a turn edits files but runs no verification (`run_test`/`lsp_diagnostics`/`lens_diagnostics`/a check command).
- **`plan-mode/`** — `/plan`, `/plan-todos`, Ctrl+Alt+P: plan-then-code mode.
- **`learning/`** — captures and fingerprints tool/subagent failures across sessions; `/learn` promotes patterns that repeat across ≥2 sessions into drafted skills.

### Context & memory

- **`session-memory/`** — a living, structured notes file per session (state, files, errors, learnings, worklog), re-injected on resume.
- **`custom-compact.ts`** / **`trigger-compact.ts`** — custom context-compaction behavior and a `/trigger-compact` command.

### Tools

- **`bash-tools/`** — `file_sizes`, `run_test`, `capture_output`: context-economical read-decision, targeted-verification, and spill-to-disk helpers.
- **`web-tools.ts`** — `web_search` / `web_fetch`.
- **`background-tasks/`** — `task_run`/`task_stop`/`task_status`/`task_wait` + an interactive `/tasks` TUI for long-running processes (dev servers, builds).
- **`monitor/`** — pattern-watch a command or WebSocket stream (own `package.json` — `ws` dependency).

### UX

- **`todo.ts`** — a `todo` tool + `/todos` command.
- **`question.ts`** / **`questionnaire.ts`** — structured ways for the agent to ask the user something instead of guessing.
- **`custom-footer.ts`** — footer widget (e.g. current git branch).

### Skills (`skills/`)

Loaded on-demand when a task matches their description, not always in context:

- **`subagents`** — when it's worth delegating, which agent to pick, single vs. parallel vs. chain vs. workflow, handoff design, review gates.
- **`dev-workflows`** — when to reach for a whole preset pipeline instead of hand-assembling a subagent chain.

## Repository layout

```
pi-config/                   (= ~/.pi/agent/extensions)
├── package.json             setup / typecheck / lint / test / check scripts
├── tsconfig.json            ESM, noEmit, strict:false
├── scripts/setup-links.sh   symlinks node_modules -> the global pi install
│
├── custom-compact.ts        root-level extensions (one file = one module)
├── custom-footer.ts
├── dev-workflows.ts
├── question.ts
├── questionnaire.ts
├── todo.ts
├── trigger-compact.ts
├── verify-guard.ts
├── web-tools.ts
│
├── background-tasks/        bundled extensions (index.ts = entry point)
├── bash-tools/
├── learning/
├── monitor/                 own package.json (ws dependency)
├── plan-mode/
├── session-memory/
├── subagent/
│   ├── agents/*.md          agent definitions (frontmatter: name/tools/model)
│   ├── prompts/*.md         bundled chain prompts (/implement, /scout-and-plan, /implement-and-review)
│   └── tests/               unit suites + opt-in live E2E (see TESTING-PLAN.md)
├── todo/                    todo-widget.ts, shared with todo.ts
│
├── skills/                  on-demand deep-dive docs
└── tests/                   root-level unit tests (dev-workflows, verify-guard)
```

Two extension shapes are both auto-discovered: a single `*.ts` file directly in the extensions dir, or a `*/index.ts` inside a subdirectory for a bundled extension with helper modules.

## Development

```bash
npm run setup       # (re)link node_modules -> the global pi install
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # every offline unit suite
npm run check        # setup + lint + typecheck + test — the definition of done
```

`subagent/tests/e2e-smoke.sh` and `subagent/tests/e2e-*.sh` are opt-in, **live** tests — they spawn real `pi` subprocesses against your configured provider (need `~/.pi/agent/auth.json`, cost real tokens, take real wall time). Run them deliberately; they are never part of `npm test`.

After editing any extension, run `/reload` inside a live `pi` session to pick it up.

## Conventions

This repo's own `AGENTS.md` (at the repo root — distinct from the global `~/.pi/agent/AGENTS.md` covered in Setup above) is the operating manual for working *on* this repo: extension shapes, type-pinning against the exact installed `pi` version, testing conventions, and the `npm run check` definition-of-done gate. Start there before making structural changes.
