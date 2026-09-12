---
name: subagents
description: >-
  How to delegate work to subagents in Pi well — when it's worth it, which
  agent to pick, how to write a task, and how to run single / parallel /
  chain / workflow modes with handoffs, structured outputs, and review gates.
  Use whenever delegating research, implementation, review, or parallelizable
  work to the subagent tool (scout / planner / reviewer / worker / general /
  evidence-auditor), or before hand-assembling a multi-agent run_workflow.
---

# Using Subagents Well

A subagent is a separate `pi` process with its **own isolated context window**:
it reads/executes/edits on your behalf and returns only a condensed result. The
main conversation is never polluted by the subagent's raw exploration, tool
outputs, or dead ends. This is the single biggest win: you trade a little
scheduling/token overhead for a **clean main context** — and context is the
currency that keeps the whole session sharp.

Subagents **cannot coordinate with each other** — they report only to you, the
parent. Coordination happens here: by running them in parallel, or by chaining
handoffs step-by-step.

The harness ships these agents (see the live catalog with `list_agents`):

| Agent | Model | Role | Edits? |
| ----- | ----- | ---- | ------ |
| `scout` | deepseek-v4-flash | Fast read-only recon w/ pi-lens | No |
| `planner` | glm-5.3 | Implementation plan (no changes) | No |
| `worker` | deepseek-v4-flash | Test-first (TDD) implementation | Yes |
| `reviewer` | glm-5.3 | Code review w/ `lsp_diagnostics` | No (read-only bash) |
| `general` | session model | All-rounder fallback | Yes |
| `evidence-auditor` | glm-5.3 | Audits one claim against sources — supported/contradicted/unclear/missing-evidence | No |

## 1. Decide: delegate or not?

**Delegate when the work is research-heavy, independent, parallelizable, or a
fresh perspective is wanted.** Strong signals:

- **Context isolation.** Gathering context means reading dozens of files, or a
  task would flood your main window with logs/search/file contents you won't
  reference again. → scout / general.
- **Independent parallel tasks.** Sub-tasks have no dependencies on each other
  (different files, different subsystems, multiple failing tests). → parallel.
  `parallelGroup` on run_workflow steps for concurrency (bounded 4).
- **Fresh perspective.** Verification, review, or a second opinion on an
  implementation — a clean slate without your conversation's assumptions. →
  reviewer.
- **Verification gate.** A second, unbiased pass before declaring done: have a
  subagent check the diff/tests so the author isn't grading its own work.
- **Pipeline with clear handoffs.** Distinct phases (design → implement →
  test/review) that benefit from focused attention. → chain / workflow.
- **Research as a prerequisite to coding.** "Explore X first, return a summary,
  then I'll plan" keeps the implementation discussion informed, not exploratory.

**Do NOT delegate (do it inline):**

- **Small / tightly sequential tasks.** A quick fix, a focused question, or a
  chain where step 3 needs every earlier step's output — one context is cleaner
  than a relay.
- **Edits to the same files in parallel.** Two subagents editing the same file
  is a recipe for conflict; keep tightly coupled changes in one context.
- **Simple enough that delegation overhead exceeds the work.** If you could do
  it in one `bash` command, just do it.
- **Flooding with specialists.** Keep to a handful of well-scoped agents; a
  sprawling roster makes automatic routing worse, not better.

Rule of thumb (Anthropic): ~**10+ files** to explore, ~**3+ independent pieces
of work**, or a **second opinion on correctness** → subagents are worth it.

## 2. Pick the agent (call `list_agents` first)

- Understand / find code → **scout** (add `thoroughness`: quick / medium / thorough).
- Design an approach without touching code → **planner** (LM is stronger at architecture).
- Implement a defined task with tests → **worker** (mandatory TDD; returns `## Test Evidence`).
- Independent quality/security pass on a diff → **reviewer**.
- Check one specific claim against its sources (not open-ended research) →
  **evidence-auditor** — narrower than reviewer: one claim in, one verdict out.
- Something that fits no specialized role (investigate + small fixes + docs +
  verify end-to-end) → **general**.
- For project-local agents (`.pi/agents/*.md`), pass `agentScope: "both"` — it
  prompts for confirmation unless `confirmProjectAgents: false`.

## 3. Write a good task prompt

The task prompt is the whole contract — the subagent starts with zero context
from your conversation. Be explicit. A well-formed task:

1. **States the objective and success criteria** ("a check it can run" — tests,
   build, diff). Vague goals produce vague results.
2. **Scopes it tightly.** "Explore how payments work" beats "explore everything."
3. **Injects the essential context** via `contextFiles` (relative paths, contents
   go straight into the system prompt) or names the files/functions to look at.
4. **Names the output format** — a summary, a plan, findings as a list, or JSON
   via `expect: { jsonSchema, description }`. Structured handoffs are far more
   usable downstream.
5. **Declares independence** when true ("these can run in parallel") or the
   handoff ("return file paths + what changed so the next step can build on it").
6. **Works autonomously** — instruct: don't ask clarifying questions unless truly
   blocked; state assumptions and proceed.

Good: `Explore src/auth/ and src/oauth/ — how do we handle token refresh today?
Find reusable OAuth utilities. Return a ~200-word summary listing the key files,
functions, and the current refresh flow. Do not modify anything.`

Poor: `"Help with auth"`.

## 4. Choose the mode

| Mode | Shape | Use when |
| ---- | ----- | -------- |
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Independent tasks, concurrently (cap 8, 4 at once) |
| Chain | `{ chain: [...] }` | Sequential, pass prior output via `{previous}` |
| Workflow | `run_workflow({ steps })` | Gated multi-step: conditions, error handlers, approvals, parallel groups, per-step resume |

**Per-run/step options:**

- `timeoutMs` — kill runaway agents (SIGTERM → SIGKILL).
- `contextFiles` — inject file contents into the agent's system prompt (relative
  to `cwd`).
- `expect: { type: "json", jsonSchema, description }` — validate the agent's
  final message against a JSON Schema; a failed contract fails the step.
- Cwd per task/step (default: session working directory).

**Chain handoffs.** Use `{previous}` to chain output into the next task's prompt:

```jsonc
chain: [
  { agent: "scout",  task: "Map the auth flow in src/auth/ ..." },
  { agent: "planner", task: "Plan the OAuth change. Context: {previous} ..." },
  { agent: "worker",  task: "Implement the plan test-first (TDD). Context: {previous} ..." }
]
```

**Workflow steps additionally support:**

- `parallelGroup` — consecutive steps sharing an id run concurrently (bounded 4).
- `condition: { type: "outputContains" | "exitCodeEquals", value }` — gate on the
  previous step's output.
- `errorHandler: { strategy: "retry" | "skip" | "fallback" | "abort", maxRetries?, fallbackAgent?, fallbackTask? }`.
- `requiresApproval` — pause for manual confirmation before the step runs.
- Persistence + resume: interrupted workflows hydrate as **paused**; inspect with
  `get_workflow`, continue with `resume_workflow` (`fromStep` to jump in). Run
  records are always persisted — audit via `list_subagent_sessions` /
  `get_subagent_session` / `/runs`.

## 5. Design the handoff contract

Because subagents return only a summary, **the handoff is the product.** Demand:

- **Condensed, self-contained output.** A ~1–2k-token distillation of what was
  explored/found/changed — enough that the next step (or you) can act without
  re-reading everything.
- **File paths + what changed.** For implementation handoffs: exact paths, key
  functions/types touched, and whether the full suite is green.
- **Test evidence for worker.** The `worker` agent's contract includes a
  `## Test Evidence` section (RED then GREEN results, commands run). Hand it to
  the reviewer.
- **Structured output when machine-readable matters.** `expect` JSON-Schema
  contracts (e.g. planner emits `{plan, files, risks}`) let downstream steps (or
  `run_dev_workflow`) consume results programmatically and gate on shape.

## 6. Use subagents as a review/verification gate

The reviewer exists to see the *diff and the criteria*, not your reasoning.

- After nontrivial work, dispatch `reviewer` (or `general`) in a fresh context:
  give it the changed files, the plan/requirements it should check against, and
  what counts as a finding. "Report gaps that affect correctness or the stated
  requirements; treat style as optional." — otherwise reviewers over-report and
  you over-engineer chasing findings.
- Pass `worker`'s `## Test Evidence` so the reviewer checks the RED/GREEN claims,
  not just the diff.
- Re-review after fixes; the reviewer subagent makes the loop cheap.
- `reviewer` filters findings on evidence (repro / source-line contradiction /
  contract violation), not vibes, and always ends with a `Merge verdict: BLOCK
  | OK | OK with notes` line. Gate programmatically on that line (or via
  `expect: { jsonSchema: { verdict, findings } }` if you need structured
  output) instead of eyeballing severity labels — `BLOCK` means don't merge
  until the Critical findings are addressed.

## 7. Sit on top of `run_dev_workflow` for whole pipelines

For end-to-end feature / bugfix / refactor / exploration work, prefer the preset
`run_dev_workflow` (or `/dev <type> <topic>`) over hand-assembling the same chain
— it assembles scout → planner → worker (TDD) → verify → reviewer → fixes with
gates. Use this skill when you're orchestrating single/mid-size delegations by
hand; the `dev-workflows` skill covers the presets.

## Pitfalls to avoid

- **Same-file parallel edits** → merge into one context.
- **Sequential work forced through parallel mode** → use chain/{previous}.
- **Vague tasks** → scope + output format, or accept noisy results.
- **Over-delegating tiny work** → delegation overhead isn't free.
- **Trusting the implementing agent to be its own reviewer** → always get an
  independent pass before calling it done.
- **Handing a subagent a kitchen-sink task** → split into one focused task each.
- **Forgetting `contextFiles`** → a subagent re-derives what you already know;
  hand it the relevant file paths/content up front.

## Verify the wiring

- Agents live in `pi-config/subagent/agents/*.md` (symlinked to
  `~/.pi/agent/agents`). Frontmatter: `name`, `description`, `tools`,
  `model`. Per-call overrides: `timeoutMs`, `thinking`, `readonly`,
  `contextFiles`.
- After editing agents/prompt files, `/reload` inside a live session.
- Confirm the agent you want is discoverable: `list_agents`.
