---
name: dev-workflows
description: >-
  Preset multi-agent development workflows launched in one call via the
  run_dev_workflow tool or the /dev command. Use whenever a task fits a whole
  pipeline — implementing a feature, fixing a bug, deep refactoring, or
  exploring an unfamiliar codebase — instead of hand-assembling a subagent chain.
---

# Preset Dev Workflows

Launch a whole, gated multi-agent pipeline with **one tool call**. The steps run
through the same engine as `run_workflow` (per-step persistence, TUI widget,
`get_workflow` / `resume_workflow` for inspect & resume).

## Core invocations

```jsonc
// Tool (preferred — the model should use this directly)
run_dev_workflow({ "type": "swat", "topic": "add Redis caching to the session store" })
```

```bash
# Command (human)
/dev swat add Redis caching to the session store
```

There is no free-text `<type> <topic>` parsing inside the tool: `type` and `topic`
are separate required parameters. The `/dev` command does the splitting for humans.

## Choosing a pipeline

| type | When to use | Pipeline |
| ---- | ----------- | -------- |
| `swat` | Ship a new feature end-to-end | scout → planner (plan JSON) → worker (TDD) → verify (test suite + diagnostics) → reviewer → worker fixes |
| `bugfix` | Reproduce and fix a bug | scout (trace) → worker (failing test, RED) → worker (fix, GREEN) → reviewer |
| `refactor` | Deep structural change | planner (blast radius) → worker (suite green before/after) → reviewer → `lens_diagnostics` full sweep |
| `explore` | Map an unfamiliar codebase, no code changes | 3 parallel scouts → planner synthesis |

### How to pick

- **New feature / changes behavior** → `swat` (has a review gate; most complete).
- **Something is broken** → `bugfix` (test-first reproduction, no planning overhead).
- **Reorganizing code that already works** → `refactor` (design + full diagnostics net).
- **Learning / planning only** → `explore` (read-only recon, no writes).

## Optional parameters

- `agentScope`: `"user"` (default) | `"project"` | `"both"` — include project-local agents. Project agents prompt for confirmation unless disabled.
- `confirmProjectAgents` (tool): default `true`; `false` to skip the confirmation for project-local agents.

## After launching

- Inspect/resume any step: `get_workflow` then `resume_workflow` (`fromStep` to jump in).
- The final output is the last completed step's output; use `expect` contracts (planner emits `{plan, files, risks}` JSON) to gate downstream steps.
- Review every changed file (the `verify`/`reviewer` steps do this, but confirm `lens_diagnostics` is clean on return).

## Automatic nudges (`/dev-auto`)

By default the model decides on its own when to use a workflow. `/dev-auto` enables
**event-driven nudges** (persisted): when a dev workflow run fails, or a tool errors with a
pattern the failure-learning store already recognizes as a repeat, the agent is steered to
consider `run_dev_workflow` — but it still owns the type/topic decision. Advisory;
a recurring failure usually means the task is bigger than inline iteration.

## Customizing

The four pipelines are defined once in `pi-config/dev-workflows.ts` (`WORKFLOWS`).
To alter agent sequences, add/remove steps, or change an `expect` contract, edit
that table and `/reload`. For per-project variants (pinned agents/models/extra
gates) prefer a `.pi/prompts/*.md` template that calls `run_dev_workflow` with
fixed parameters rather than forking the global table.
