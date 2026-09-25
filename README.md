# pi-config

Personal extension pack for the [Pi coding agent](https://github.com/earendil-works/pi) — subagents, workflows, and dev-loop tooling on top of the `@earendil-works/pi-coding-agent` extension API.

`~/.pi/agent/extensions` is a symlink to this repo, so everything here is auto-discovered and loaded into every `pi` session. It ships no runtime of its own — pure extension code, executed via `jiti` (TypeScript runs without a build step).

Three more pieces of pi's own discovery — subagent definitions, bundled prompts, and skills — are loaded straight from fixed subdirectories of `~/.pi/agent` (`agents/`, `prompts/`, `skills/`), not from the extensions dir. `npm run setup:agent` symlinks the repo's copies (`subagent/agents/*.md`, `subagent/prompts/*.md`, `skills/*`) into place per-file, so this repo stays the single source of truth instead of drifting from hand-copied duplicates. See [Setup](#setup) below.

> **Security note:** extensions run with full system permissions and can execute arbitrary code. Only load code you trust — treat this repo the way you'd treat anything else that runs unsandboxed on every session.

## Setup

Requirements: `pi` installed and on `PATH`, Node ≥ 22 (the test runners use Node's built-in TypeScript type-stripping).

### Quick start (one command line)

```bash
git clone https://github.com/hllj/pi-config.git ~/pi-config && cd ~/pi-config && npm install && npm run setup:all && npm run verify
```

That single line: clones the repo, installs dependencies (root + `monitor/`'s own, via `postinstall`), symlinks `~/.pi/agent/{extensions,agents/*,prompts/*,skills/*}` into place, fetches `~/.pi/agent/AGENTS.md` if it isn't already there, symlinks `node_modules` against the global `pi` install for type-checking, and then runs a read-only check confirming all of it worked — including, by default, that **every single extension in the repo actually loads** under the real installed `pi` (see [Development](#development) below for details; it's free, no tokens spent). It's idempotent — safe to run again on an already-set-up machine, or with `npm run verify:live` in place of `verify` on the end to also spawn one real `pi --print` turn as an end-to-end smoke test.

The rest of this section explains what that line does, step by step, and covers the one piece it doesn't touch: the global operating manual.

Two independent pieces make up a full personal Pi setup: this repo (the extensions) and a global operating manual (`AGENTS.md`). Neither alone is the full picture — extensions add capability, `AGENTS.md` tells the agent when and how to use it.

### 1. Extensions, agents, prompts & skills — link this repo into place

```bash
git clone https://github.com/hllj/pi-config.git /path/to/pi-config   # or wherever you keep it
cd /path/to/pi-config
npm install            # root deps + monitor/'s own (ws), via postinstall
npm run setup:agent    # symlinks ~/.pi/agent/{extensions,agents/*,prompts/*,skills/*} -> this repo, fetches AGENTS.md if missing, installs the pi-lens companion package
npm run setup          # symlinks node_modules -> the global pi install, for type-checking
```

(`npm run setup:all` runs the last two in order.) `setup:agent` is idempotent and safe to re-run any time — it only creates or replaces symlinks it owns, and leaves any unrelated file at those paths (e.g. a personal, non-repo agent definition) untouched with a warning. It reads `PI_CODING_AGENT_DIR` if set, otherwise defaults to `~/.pi/agent`. It also fetches `~/.pi/agent/AGENTS.md` the first time (see [below](#2-global-operating-manual-piagentagentsmd)) — only if that file doesn't already exist, so a re-run never overwrites your edits.

It also installs [`pi-lens`](https://www.npmjs.com/package/pi-lens) — a separate `pi` package (not part of this repo) providing real-time LSP/lint/type-check diagnostics via `pi install npm:pi-lens`. `verify-guard.ts` recognizes its `lens_diagnostics` tool as a verification signal (alongside `run_test`/`lsp_diagnostics`). `pi install` is pi's own package manager: it merges into `~/.pi/agent/settings.json`'s `packages` list without touching anything else there, and no-ops if `pi-lens` is already installed — so this step is safe to re-run too.

Then confirm everything is wired correctly:

```bash
npm run verify              # symlinks + pi-lens + node_modules + every extension loads (isolated, zero tokens)
npm run verify -- --fast    # skip the per-extension load check — structural checks only, no `pi` subprocesses
npm run verify:live         # + one real `pi --print` turn to confirm a full completion works end-to-end
```

The per-extension load check works because `pi` fails extension discovery *before* ever resolving a model or touching the network — so it spawns each extension alone (`pi --no-extensions -e <file>`) against a disposable, auth-less agent dir, and treats the absence of a "Failed to load extension" error as proof it loaded, at no cost. `verify:live` is the only piece that spends real tokens, and it's opt-in.

`monitor/` ships its own `package.json` (it needs the `ws` package, which isn't a root dependency) — `npm install` at the repo root installs it too via a `postinstall` hook, so a plain `npm install` is enough. Without it, `pi` refuses to start at all: it hard-fails extension discovery the moment any one extension can't load, not just that extension.

Changes to extension code take effect after `/reload` inside a running `pi` session. Changes to `subagent/agents/`, `subagent/prompts/`, or `skills/` (adding or removing a file) need `npm run setup:agent` re-run once to (re)create the corresponding symlink, then `/reload`.

### 2. Global operating manual (`~/.pi/agent/AGENTS.md`)

`~/.pi/agent/AGENTS.md` is loaded into **every** `pi` session, regardless of project — it's where the agent's always-on rules live: who it is, the engineering loop (plan → test → implement → review → verify → remember → improve), tool-selection heuristics, and the definition of done. It's personal and machine-specific, not code, so it isn't part of this repo (no symlink — unlike agents/prompts/skills, it's meant to be hand-edited after the first copy); my current copy (v3.1) is published as a [gist](https://gist.github.com/hllj/d716e5e0aa34d4971cef7fa459b2cffc) for reference. v3.1 adds a "Before your first code change" checklist at the top, which pairs with `start-of-task-gate.ts`.

`npm run setup:agent` fetches it into place automatically — **but only if `~/.pi/agent/AGENTS.md` doesn't already exist**, so it never overwrites local edits. To fetch it manually, or to pull the latest gist revision on top of a file that already exists:

```bash
mkdir -p ~/.pi/agent
curl -fsSL https://gist.githubusercontent.com/hllj/d716e5e0aa34d4971cef7fa459b2cffc/raw/AGENTS.md \
  -o ~/.pi/agent/AGENTS.md
```

Treat it as a starting point, not a drop-in — it names this repo's own agents and extensions directly (`subagent`, `verify-guard`, `watchdog`, `run_dev_workflow`, ...), so adapt the tool references if your extension set differs. Project-specific conventions (build/test commands, architecture, gotchas) belong in each project's own `AGENTS.md` instead of here — Pi layers them: global → parent directories → the current directory, all concatenated.

`npm run verify` checks that the file exists (not that it matches the gist — local edits are expected).

## What's here

16 extensions (this repo, auto-discovered) + 1 companion package (`pi-lens`, installed by `npm run setup:agent`, see [Setup](#setup)):

| Name | Kind | Tools / commands | What it does |
| --- | --- | --- | --- |
| `subagent/` | bundled extension | `dispatch_agent`, `run_workflow`, `resume_workflow`, `send_message`/`get_messages`, `list_subagent_sessions`, `get_subagent_session`, `/runs`, `/watchdog` | Delegate work to isolated child `pi` processes — 6 agent roles, single/parallel/chain/workflow dispatch, persistent run store, opt-in in-session watchdog |
| `dev-workflows.ts` | root extension | `run_dev_workflow`, `/dev <type> <topic>`, `/dev-auto` | Preset multi-agent pipelines: `swat`/`bugfix`/`refactor`/`explore` |
| `start-of-task-gate.ts` | root extension | `/start-gate` | Holds the session's first `edit`/`write` once (default on) with a skill-scan + delegation checklist, unless a `SKILL.md` was read or work was delegated first |
| `verify-guard.ts` | root extension | `/verify-guard` | Advisory nudge when a turn edits files but runs no verification (`run_test`/`lsp_diagnostics`/`lens_diagnostics`/a check command) |
| `plan-mode/` | bundled extension | `/plan`, `/plan-todos`, Ctrl+Alt+P | Plan-then-code mode |
| `learning/` | bundled extension | `learn` tool, `/learn` | Captures & fingerprints tool/subagent failures across sessions; promotes patterns repeating across ≥2 sessions into drafted skills |
| `session-memory/` | bundled extension | `note` tool, `/notes` | Living, structured per-session notes file (state, files, errors, learnings, worklog), re-injected on resume |
| `custom-compact.ts` | root extension | (hook only) | Custom context-compaction behavior |
| `trigger-compact.ts` | root extension | `/trigger-compact` | Manually trigger a compaction |
| `bash-tools/` | bundled extension | `file_sizes`, `run_test`, `capture_output` | Context-economical read-decision, targeted-verification, and spill-to-disk helpers |
| `web-tools.ts` | root extension | `web_search`, `web_fetch` | Web search / fetch tools |
| `background-tasks/` | bundled extension | `task_run`/`task_stop`/`task_status`/`task_wait`, `/tasks` | Run and monitor long-running background processes (dev servers, builds) |
| `monitor/` | bundled extension (own `package.json`, `ws` dep) | `monitor_*` tools | Pattern-watch a command or WebSocket stream |
| `todo.ts` | root extension | `todo` tool, `/todos` | Todo list tool + command |
| `question.ts` | root extension | `question` tool | Structured single-question prompt to the user, instead of guessing |
| `questionnaire.ts` | root extension | `questionnaire` tool | Structured multi-question (tabbed) prompt to the user |
| `custom-footer.ts` | root extension | (footer widget) | Status-line footer widget (e.g. current git branch) |
| [`pi-lens`](https://www.npmjs.com/package/pi-lens) (`npm:pi-lens`) | **package**, not part of this repo | `lens_diagnostics` and others | Real-time LSP/lint/type-check/structural-analysis diagnostics; installed via `npm run setup:agent` (`pi install npm:pi-lens`) |

Details on each, grouped by area:

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
- **`start-of-task-gate.ts`** — the firm half of `AGENTS.md`'s "Start of a task": the first `edit`/`write` of a session is held once (not applied) when no `SKILL.md` was read and nothing was delegated, and the block reason lists the loaded skills (with paths) and the delegation triggers, with the files-read count. It fires at most once per session, so it can't deadlock. On by default, so it also works in fresh environments such as benchmark containers; turn it off with `/start-gate`. Subagent children are never gated.
- **`verify-guard.ts`** — advisory nudge (opt-in, `/verify-guard`) when a turn edits files but runs no verification (`run_test`/`lsp_diagnostics`/`lens_diagnostics`/a check command). `lens_diagnostics` comes from the [`pi-lens`](https://www.npmjs.com/package/pi-lens) companion package, installed by `npm run setup:agent` (see [Setup](#setup)).
- **`plan-mode/`** — `/plan`, `/plan-todos`, Ctrl+Alt+P: plan-then-code mode.
- **`learning/`** — captures and fingerprints tool/subagent failures across sessions; `/learn` promotes patterns that repeat across ≥2 sessions into drafted skills.

### Context & memory

- **`session-memory/`** — a living, structured notes file per session (state, files, errors, learnings, worklog), re-injected on resume.
- **`custom-compact.ts`** / **`trigger-compact.ts`** — custom context-compaction behavior and a `/trigger-compact` command.

### Tools

- **`bash-tools/`** — `file_sizes`, `run_test`, `capture_output`: context-economical read-decision, targeted-verification, and spill-to-disk helpers.
- **`web-tools.ts`** — `web_search` / `web_fetch`.
- **`background-tasks/`** — `task_run`/`task_stop`/`task_status`/`task_wait` + an interactive `/tasks` TUI for long-running processes (dev servers, builds).
- **`monitor/`** — pattern-watch a command or WebSocket stream (own `package.json` — `ws` dependency, installed automatically via the root `postinstall` hook).

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
├── scripts/setup-links.sh       symlinks node_modules -> the global pi install
├── scripts/setup-agent-links.sh symlinks ~/.pi/agent/{extensions,agents/*,prompts/*,skills/*} -> this repo, fetches AGENTS.md if missing
├── scripts/verify-setup.sh      checks every symlink above + every extension loads (+ optional live smoke test)
│
├── custom-compact.ts        root-level extensions (one file = one module)
├── custom-footer.ts
├── dev-workflows.ts
├── question.ts
├── questionnaire.ts
├── todo.ts
├── trigger-compact.ts
├── start-of-task-gate.ts
├── verify-guard.ts
├── web-tools.ts
│
├── background-tasks/        bundled extensions (index.ts = entry point)
├── bash-tools/
├── learning/
├── monitor/                 own package.json (ws dependency, auto-installed via root postinstall)
├── plan-mode/
├── session-memory/
├── subagent/
│   ├── agents/*.md          agent definitions (frontmatter: name/tools/model)
│   ├── prompts/*.md         bundled chain prompts (/implement, /scout-and-plan, /implement-and-review)
│   └── tests/               unit suites + opt-in live E2E (see TESTING-PLAN.md)
├── todo/                    todo-widget.ts, shared with todo.ts
│
├── skills/                  on-demand deep-dive docs
└── tests/                   root-level unit tests (dev-workflows, verify-guard, start-of-task-gate, trigger-compact)
    └── e2e-compact.sh       opt-in live E2E for trigger-compact.ts + custom-compact.ts
```

Two extension shapes are both auto-discovered: a single `*.ts` file directly in the extensions dir, or a `*/index.ts` inside a subdirectory for a bundled extension with helper modules.

## Development

```bash
npm run setup        # (re)link node_modules -> the global pi install
npm run setup:agent  # (re)link ~/.pi/agent/{extensions,agents/*,prompts/*,skills/*} -> this repo
npm run setup:all    # both of the above, in order
npm run verify       # confirm every link is correct + every extension loads (add --live via `npm run verify:live` for a real pi smoke test, or --fast to skip the extension checks)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # every offline unit suite
npm run check        # setup + lint + typecheck + test — the definition of done
```

`subagent/tests/e2e-smoke.sh`, `subagent/tests/e2e-*.sh`, and `tests/e2e-compact.sh` are opt-in, **live** tests — they spawn real `pi` subprocesses against your configured provider (need `~/.pi/agent/auth.json`, cost real tokens, take real wall time). Run them deliberately; they are never part of `npm test`.

After editing any extension, run `/reload` inside a live `pi` session to pick it up.

## Conventions

This repo's own `AGENTS.md` (at the repo root — distinct from the global `~/.pi/agent/AGENTS.md` covered in Setup above) is the operating manual for working *on* this repo: extension shapes, type-pinning against the exact installed `pi` version, testing conventions, and the `npm run check` definition-of-done gate. Start there before making structural changes.
