# AGENTS.md — pi-config (Pi Coding Agent Extensions)

This repository is the **global extensions directory** for the Pi coding agent.
`~/.pi/agent/extensions` is a **symlink to this folder**, so everything here is
auto-discovered and loaded into every `pi` session. Any change takes effect after
running `/reload` inside a running pi session (extensions are executed via `jiti`,
TypeScript runs without a compile step).

> **Security note:** extensions run with your full system permissions and can
> execute arbitrary code. Source here is trusted; beat on correctness in review.

---

## What this repo is

`pi-config` = personal extensions, subagents, and prompts built on the
`@earendil-works/pi-coding-agent` extension API. It is **not** a standalone
app — it ships no runtime of its own. It hooks into the globally installed
`pi` package and type-checks against that exact installed version.

## Layout

```
pi-config/                 (= ~/.pi/agent/extensions)
├── package.json           scripts (setup / typecheck / test / check)
├── tsconfig.json          type-check config (ESM, noEmit, strict:false)
├── scripts/setup-links.sh symlinks node_modules -> global pi install (type surface)
│
├── custom-compact.ts      root-level extension module (default export fn)
├── custom-footer.ts       root-level extension module
├── question.ts            root-level extension: registers `question` tool
├── questionnaire.ts       root-level extension: `questionnaire` tool (multi-question tabs)
├── todo.ts                root-level extension: todo list tools (/todos)
├── trigger-compact.ts     root-level extension: /trigger-compact command
├── web-tools.ts           root-level extension: web_search / web_fetch tools
│
├── background-tasks/      extension (index.ts): task_run/task_stop/task_list/etc
├── monitor/               extension (index.ts): monitor_* tools; own package.json + node_modules (ws dep)
├── plan-mode/             extension (index.ts): /plan, /plan-todos, Ctrl+Alt+P
├── subagent/              extension (index.ts): scout/planner/reviewer/worker + run store + workflow engine
│   ├── agents/*.md        subagent definitions (YAML frontmatter: name/description/model/tools)
│   ├── prompts/*.md       bundled workflows (/implement, /scout-and-plan, /implement-and-review)
│   └── tests/             unit suites (run-unit.sh, run-widget.sh) + e2e-smoke.sh
└── todo/                  TUI widget + tests imported by root todo.ts
```

**Two extension shapes** are both valid (Pi auto-discovers both):

- `*.ts` directly in the extensions dir → one module, e.g. `web-tools.ts`
- `*/index.ts` subdirectory → a bundled extension, e.g. `subagent/index.ts`

---

## Tech stack

| Layer | Choice | Why |
| ------- | -------- | ----- |
| Language | **TypeScript** (ESM, `"type": "module"`) | Pi loads TS directly — no build step |
| Runtime | **jiti** (run by pi) | `noEmit`, executes TS in place |
| Types | `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core` | The pi extension surface |
| Schemas | **TypeBox** | Tool `parameters` are `Type.Object({...})` |
| Node types | `@types/node` | |
| Compiler | local `typescript` devDependency | `tsc --noEmit` only for checking |

**Type pinning:** `scripts/setup-links.sh` symlinks `node_modules/@earendil-works/*`,
`typebox`, and `@types/node` straight into the **global pi install**. Type-checking
therefore always runs against the exact pi type surface the installed `pi` uses —
never a drifted parallel copy. `node_modules/` is gitignored; recreate with `npm run
setup` after a fresh clone.

**tsconfig notes:** `strict: false`, tolerant. `include: ["**/*.ts"]`,
`exclude: ["node_modules", "**/*.test.ts"]` — tests are isolated from typecheck
(they run through Node directly). `isolatedModules`, `esModuleInterop`,
`skipLibCheck` are on. Don't strengthen `strict` casually; existing code relies on it.

---

## Commands

From repo root:

```bash
npm install              # fetch typescript devDependency only
npm run setup            # (re)create type-checking symlinks into global pi  [sh scripts/setup-links.sh]
npm run typecheck        # tsc --noEmit  (npm per-run setup first via pretypecheck)
npm test                 # all suites: test:subagent + test:subagent:widget + test:todo
npm run test:subagent    # bash subagent/tests/run-unit.sh
npm run test:subagent:widget  # bash subagent/tests/run-widget.sh
npm run test:todo        # node todo/todo-widget.test.ts
npm run check            # setup + typecheck + test  (definition of done for pi-config)
```

Pi-side (runtime, not in this repo):

- `/reload` — hot-reload changed extensions/tools/commands inside a live session
- `pi -e ./some.ts` — quick single-extension smoke test outside auto-discovery

---

## How Pi discovers & loads extensions

Auto-discovered locations (all load after the project dir is trusted):

| Location | Scope |
| ---------- | ------- |
| `~/.pi/agent/extensions/*.ts` | Global (this repo) |
| `~/.pi/agent/extensions/*/index.ts` | Global (this repo) |
| `.pi/extensions/*.ts` / `*.ts`, `*/index.ts` | Project-local |

Each module must have a **default export**: a function `(pi: ExtensionAPI) => void`
that registers tools/commands/handlers at load time.

### Extension capabilities (what you code against)

- `pi.registerTool({ name, label, description, parameters: Type.Object(...), async execute(toolCallId, params, signal, onUpdate, ctx) {...} })` → custom tool the LLM can call.
- `pi.registerCommand("myname", { description, handler: async (args, ctx) => {...} })` → `/myname`.
- `pi.on("event_name", async (event, ctx) => {...})` → lifecycle/agent/model/**tool**/session events (e.g. `tool_call` interception, `turn_end`, `session_before_compact`).
- `ctx.ui.*` — `notify`, `confirm`, `select`, `input`, `setFooter`, `custom()` (full TUI widgets).
- `pi.appendEntry(...)` — persist state that survives restarts.
- `ctx.compact(...)`, `ctx.getContextUsage()`, `ctx.model`/`ctx.sessionManager` — conversation/session access.

Referents in this repo are great starting templates — copy the pattern before
writing from memory:

- **Tool registration:** `web-tools.ts`, `question.ts`, `questionnaire.ts`
- **Command + TUI:** `custom-footer.ts` (footer widget, git branch hook)
- **Event interception + compaction:** `trigger-compact.ts`, `custom-compact.ts`
- **Full bundled extension with sub-processes + persistence:** `subagent/index.ts`

---

## Workflow / conventions

- **Discovery first:** use `module_report` / `symbol_search` / `read_symbol` to orient
  before editing a large file (see `subagent/index.ts`).
- **Missing read-before-edit:** `edit` requires reading first. Keep edits surgical —
  touch only what the request needs; don't reformat unrelated code.
- **Verification loop:** for any change run the targeted suite first, then the
  relevant full suite — **run them; don't report done without running them.**
- **`/reload` after edits** when validating against a live pi session.
- **Tests** live next to their code (e.g. `todo/todo-widget.test.ts`, `subagent/tests/`).
  Subagent tests are bash wrapper scripts; root `npm test` is the aggregate gate.
- Type changes land as **symlinks to the global install** — after upgrading pi, run
  `npm run setup` again so the type surface follows.

---

## Gotchas

- `node_modules/` is gitignored → fresh clones need `npm install` **and** `npm run setup`
  (setup fails loudly if `pi` isn't on PATH).
- `strict: false` — don't silently rely on it as an excuse for new type bugs, but don't
  churn to satisfy strict either.
- `monitor/` carries its **own** `package.json` (`ws` dep) + `install`; shared deps for
  a subdir should follow that pattern (nearest `node_modules` wins at jiti resolution).
- No build artifacts — everything runs from source. Don't commit `dist/`, `*.tsbuildinfo`,
  or lockfile churn outside the intended `package*.json`.
- `pretypecheck` runs `setup` automatically, so `npm run typecheck` stays self-contained.
