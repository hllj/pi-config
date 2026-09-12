# Testing plan: every subagent and every workflow mechanism, called by prompt

**Goal:** verify — with real `pi` subprocesses, not code review — that every agent
(`scout`, `planner`, `reviewer`, `worker`, `general`, `evidence-auditor`) and every
workflow mechanism (single, parallel, chain, `run_workflow`, the three bundled
prompt templates) can actually be invoked correctly by a prompt and produces the
output its own contract promises.

**Why this exists:** the 2026-09-12 live-verification pass (documented in
`IMPROVEMENT-PLAN.md`) found that code review and unit tests miss real bugs —
the watchdog's structured-output parsing had a live defect that 24 passing unit
tests never caught, because no test used real, messy model output. This plan
generalizes that lesson into a repeatable suite covering every agent and
workflow path, not just the one that happened to get manually tested.

## Methodology

- **Isolated, never touches your real store.** Every script exports
  `PI_SUBAGENT_SESSION_DIR` and `PI_CODING_AGENT_SESSION_DIR` into a fresh
  `mktemp -d`, exactly like the existing `e2e-smoke.sh`. Nothing lands in
  `~/.pi/agent/subagents` or `~/.pi/agent/sessions`.
- **Deterministic mechanical checks first, realistic-task checks second.** Two
  tiers per agent: (a) a "reply with exactly token X" dispatch — proves the
  agent resolves, spawns, and returns, independent of task difficulty or model
  judgment; (b) a small realistic task against a shared fixture repo, checked
  against that agent's *own documented output contract* (not just "didn't
  crash") — e.g. worker's `## Test Evidence`, reviewer's `Merge verdict:` line,
  evidence-auditor's verdict enum.
- **Verify via the run store, not just stdout.** `record.json` per run
  (`status`, `exitCode`, `mode`, `agent`) is the objective signal; grep for
  format markers in the child's session transcript or the parent's final reply
  for the contract checks. This is the same technique that caught the
  `expect.ts` bug live — trust the artifact, not the eyeballed summary.
- **Skip gracefully without credentials.** Same gate as `e2e-smoke.sh`: no
  `~/.pi/agent/auth.json` → print `SKIP` and exit 0, never fail CI/hooks that
  don't have provider access.
- **A shared fixture repo**, not a trivial one-liner, so results are
  meaningful instead of vacuous:

  ```python
  # calc.py
  def add(a, b):
      """Add two numbers."""
      return a + b

  def divide(a, b):
      """Divide a by b. Handles b=0 by returning None."""
      return a / b   # FALSE CLAIM: this actually raises ZeroDivisionError

  # test_calc.py
  def test_add():
      from calc import add
      assert add(2, 3) == 5
  # no test for divide() at all — a real test-gap
  ```

  This single fixture gives every agent something non-trivial to do: a real
  test-gap for `reviewer`/`worker` to find, a false docstring claim for
  `evidence-auditor` to contradict, and a real function to trace for `scout`.

## Test matrix

### A. Per-agent explicit dispatch (`e2e-agents.sh`)

| Agent | Mechanical check | Realistic-task check | Contract asserted |
| --- | --- | --- | --- |
| `scout` | replies with exact token | "find where division is implemented and what tests exist for it" | `## Files Retrieved` with `calc.py`/`test_calc.py` line ranges |
| `planner` | replies with exact token | "plan how to make `divide()` handle b=0 safely" | `## Goal`, `## Plan`, `## Files to Modify` sections; no file mutation |
| `worker` | replies with exact token | "add a test for `divide(a, 0)` and make it return `None` on b=0, TDD" | `## Test Evidence` with a RED failure quote and a GREEN pass quote; `calc.py` actually changed |
| `reviewer` | replies with exact token | review the worker's diff above | evidence-cited findings + a `Merge verdict: BLOCK\|OK\|OK with notes` line (exact string) |
| `evidence-auditor` | replies with exact token | audit the claim "`divide()` handles b=0 by returning None" against `calc.py` **before** the worker's fix | `## Verdict` = `contradicted` (this is a known-false claim — a `supported`/`unclear` result is a real failure, not noise) |
| `general` | replies with exact token | "add input validation to `add()` so non-numeric args raise `TypeError`, with a test" | `## Completed`, `## Files Changed`, `## Test Evidence` sections; file mutated |

Each row's mechanical check mirrors `e2e-smoke.sh`'s existing single-dispatch
test (`record.json` status `completed`, exit code `0`, a child session file
exists) — this suite doesn't repeat that assertion set per agent, it *adds* the
contract-shape assertion on top.

### B. Workflow prompt templates (`e2e-workflow-prompts.sh`)

| Prompt | Expected chain (in order) | What's verified |
| --- | --- | --- |
| `/scout-and-plan <query>` | `scout` → `planner` | 2 run-store records, `mode: "chain"`, agents in that exact order; planner's output references something specific from scout's (not a generic plan — length/content check that `{previous}` actually carried real content forward, not an empty placeholder) |
| `/implement <query>` | `scout` → `planner` → `worker` | 3 chain records in order; worker's final output has `## Test Evidence` |
| `/implement-and-review <query>` | `worker` → `reviewer` → `worker` | 3 chain records in order; reviewer's step includes a `Merge verdict:` line; the final worker step's task text contains reviewer feedback (`{previous}` substitution check again) |

If `/name` command-expansion doesn't fire correctly in `-p` mode (untested
assumption — see Known gaps), fall back to pasting the prompt file's literal
expanded instruction text as the message instead of the `/name` shortcut, and
note the discrepancy.

### C. `run_workflow` tool mode (`e2e-run-workflow.sh`)

| Case | Setup | Verified |
| --- | --- | --- |
| Condition gate | 2-step workflow, step 2 has `condition: { type: "exitCodeEquals", value: 0 }` | step 2 runs when step 1 succeeds; re-run with a task that fails step 1 → step 2 status `skipped` |
| Error handler (retry) | step with `errorHandler: { strategy: "retry", maxRetries: 1 }` and a task designed to fail once (agent told to fail the first attempt, succeed the second is unreliable — instead assert `retryCount` semantics via a step that always fails and confirm exactly `maxRetries + 1` attempts before the workflow reports `failed`) | retry count matches `maxRetries` |
| `parallelGroup` | 2 steps sharing a `parallelGroup` id, each replying a distinct token | both complete, run-store shows both with the same `workflowId`, timestamps overlap (start of the later one before the end of the earlier one) |
| Budget nudge | `budgetTokens` set deliberately tiny (e.g. `500`) so a 2-3 step workflow crosses 60%/85% almost immediately | a `steer`-delivered message containing "Workflow budget nudge" appears in the parent transcript |
| `resume_workflow` | kill the parent process (`SIGKILL`) mid-workflow after step 1 completes, then start a fresh process and call `resume_workflow` | workflow state hydrates as `paused`, `resume_workflow` continues from the first incomplete step, previously-completed step results are kept |
| `requiresApproval` | step with `requiresApproval: true` | **manual/interactive only** — `ctx.hasUI` is commonly false in `-p` mode, so this can't be exercised headlessly; document as a known gap, verify by hand in an interactive session instead |

### D. Natural-language / proactive triggering (`e2e-proactive.sh`, informational)

These are **not pass/fail gates** — per the 2026-09-12 findings, the default
model (`deepseek-v4-flash-0731`) does not reliably self-trigger delegation
from prose guidance alone. Re-run as a standing regression *signal*, not a
required-green check:　if a future model swap or prompt change makes these
newly pass, that's useful information; a persistent fail is the expected
baseline, not a broken build.

| Prompt (no agent named) | Trigger condition it should match | What to record |
| --- | --- | --- |
| "Explore this whole repo and summarize every module — don't skip anything, including full file bodies" | 10+ files, results not needed again | whether `subagent` was called at all (tool name in the event stream) |
| "Before I call this done, check my change over for correctness" (after a real edit) | second-opinion / review gate | whether `reviewer` was dispatched vs. the model reviewing its own diff inline |
| "Run 3 independent checks in parallel: tests, lint, and a security pass" | explicit parallelizable, independent pieces | whether `parallel` mode was used vs. sequential inline `bash` calls |

### E. Feature regressions (`e2e-features.sh`)

Reviewer's and evidence-auditor's verdict-enum contracts are already asserted
in Section A (`e2e-agents.sh`) — not repeated here. This section covers what
Section A doesn't touch: the watchdog's full trigger→dispatch→parse path, and
the spawn ceiling.

| Feature | Test | Assertion |
| --- | --- | --- |
| Watchdog trigger + parse | save `~/.pi/agent/watchdog/state.json` if present, write `{"enabled":true}`, make one mutating edit, **always restore/remove the original state file afterward (trap on exit)** — there is no env-var override for this path (matches `verify-guard.ts`'s sibling toggle, which also has none) | a `reviewer` run-store record appears with `status: completed` (not `failed` — this is the exact regression the `expect.ts` fix targets) |
| Spawn ceiling | `PI_SUBAGENT_SPAWN_CEILING=1`, dispatch 2+ agents in one session (e.g. `parallel` mode with 2 tasks) | a steer message containing "Subagent spawn ceiling" appears in the parent session after the 2nd dispatch |

## Pass/fail criteria

- **Sections A, B, C, E are hard gates.** A failure means a real regression:
  investigate before merging further subagent changes.
- **Section D is informational only.** Record results in
  `IMPROVEMENT-PLAN.md`'s "Live verification" log; do not block on it.
- A script exits non-zero only on a Section A/B/C/E failure; Section D always
  exits 0 and prints its findings.

## Execution

```sh
cd pi-config/subagent/tests
./e2e-agents.sh            # ~6-12 live calls, Section A
./e2e-workflow-prompts.sh  # ~3 chains = ~8 live calls, Section B
./e2e-run-workflow.sh      # ~6 workflow runs, Section C
./e2e-features.sh          # ~3 live calls, Section E (watchdog + spawn ceiling)
./e2e-proactive.sh         # ~3 live calls, Section D (informational)
```

Rough cost: ~30-35 live LLM calls total across all five scripts, each
spawning a real subprocess (some spawning further children). Expect several
minutes of wall time and provider cost in the cents-to-low-dollars range
depending on model pricing. Run a single script to check one area cheaply;
run all five before/after a change that touches dispatch, agent prompts, or
the workflow engine.

## Run log

**2026-09-12, first full run:**

- `e2e-agents.sh`: **all 6 agents passed** — every mechanical check and every
  realistic-task contract check (worker's `## Test Evidence`, reviewer's
  `Merge verdict:` line, evidence-auditor correctly returning `contradicted`
  on the known-false claim, planner leaving `calc.py` untouched, etc.).
- `e2e-workflow-prompts.sh`: **all 3 prompts passed**, correct chain order in
  every case. Also resolved a "Known gaps" uncertainty: **slash-command
  expansion (`/scout-and-plan <query>`) does work correctly in one-shot `-p`
  mode** — the literal-text fallback path was never needed.
- `e2e-run-workflow.sh`: **found two real bugs on first run**, both fixed:
  1. A genuine, unrelated defect: the `session-memory` extension
     intermittently throws `"ctx is stale after session replacement or
     reload"`, crashing the entire `pi -p` invocation before it processes the
     prompt at all (observed once in ~30 live calls across the full suite —
     rare, but real). This is a bug in a different extension, not in
     `subagent` — flagged separately, not fixed here. Mitigated at the test
     level with `run_pi_retrying()` in the new `e2e-lib.sh` (shared by all
     five scripts): retry the `pi` invocation exactly once if this specific
     error string appears in the output.
  2. A bug in the test script itself: the condition/retry tests used
     `timeoutMs: 100` to force deterministic step failure, but
     `run_workflow`'s schema enforces a minimum of `1000`. The model
     sometimes noticed the validation error and self-corrected to a working
     value, sometimes didn't — non-deterministic pass/fail unrelated to the
     actual feature being tested. Fixed by passing a schema-valid `1200`ms
     up front, removing the self-correction dependency entirely.
  A third bug surfaced fixing the second: pairing `timeoutMs: 1200` with a
  bare "reply OK" task was *itself* non-deterministic — a trivial reply with
  no forced work can occasionally complete faster than a cold subprocess
  spawn "should" take, so step1 sometimes didn't fail at all and step2
  legitimately dispatched (correct behavior for a condition gate, but it
  meant the test's premise — "step1 always fails" — no longer held). Fixed
  by tying the step's duration to an explicit `bash "sleep 3 && echo OK"`
  instruction, decoupling forced failure from model/network speed entirely.
  After all three fixes: condition gate, retry count, `parallelGroup`
  concurrency, budget nudge, and `resume_workflow` all passed cleanly, with
  the `session-memory` transient crash caught and retried successfully 3
  times across the debugging runs (real but rare — worth fixing upstream in
  `session-memory` itself at some point, tracked here as a known issue since
  this plan's scope is `subagent`, not `session-memory`).
- `e2e-features.sh`: **both passed** — the watchdog's trigger→dispatch→parse
  path completed cleanly (confirms the `expect.ts` salvage fix from the
  prior session holds), and the spawn ceiling correctly warned once after
  exceeding `PI_SUBAGENT_SPAWN_CEILING=1`. The real
  `~/.pi/agent/watchdog/state.json` was correctly restored to its
  pre-test (absent) state afterward.
- `e2e-proactive.sh` (informational, always exits 0): **all 3 cases
  not-delegated** — including the "3 independent parallel checks" case,
  which is explicitly parallelizable and still ran entirely inline. This
  matches and reinforces the existing baseline in `IMPROVEMENT-PLAN.md`: the
  default model does not reliably self-trigger delegation from prose
  guidance alone, even when a task's shape matches a documented trigger
  condition closely. Expected, not a regression.

**Net result of the first full run:** every hard-gated section (A, B, C, E)
passed after fixing the three real bugs surfaced along the way — two in the
test scripts themselves (invalid `timeoutMs`, a non-deterministic forced
failure), one in a different extension (`session-memory`'s intermittent
stale-ctx crash, mitigated at the test-harness level via `e2e-lib.sh`'s
`run_pi_retrying`, not fixed at the source — that's a separate, standalone
issue outside this plan's scope). The `session-memory` bug is worth a
dedicated look at some point: it hit 3 times across roughly 35 live calls in
this run, always identical ("ctx is stale after session replacement or
reload"), always fully masked by one retry.

## Known gaps (not covered by this plan)

- **`requiresApproval` workflow gates** — need real interactive UI
  (`ctx.hasUI`); only manually testable in a live TUI session, not `-p` mode.
- ~~`/name` slash-command expansion in `-p` mode~~ — **resolved**: confirmed
  working correctly in the first live run (see "Run log"). Section B's
  literal-text fallback path is kept as a safety net but has never been
  needed.
- **A real, unrelated `session-memory` extension bug** — an intermittent
  `"ctx is stale after session replacement or reload"` crash, found live
  while running this suite (see "Run log"). Mitigated at the test-harness
  level (`e2e-lib.sh`'s `run_pi_retrying`, retry-once) but not fixed at the
  source; out of scope for this plan (which covers `subagent`, not
  `session-memory`) but worth a dedicated look.
- **True background/detached execution** — this extension always runs
  subagents as sessions inside the parent process (see `README.md`'s Security
  Model); there is no detached-runner equivalent to test, unlike
  pi-subagents' async background children.
- **Cross-agent messaging (`send_message`/`get_messages`) end-to-end** — not
  in this plan; would need two coordinated dispatches reading each other's
  mailbox, better suited to a dedicated follow-up script if it becomes a
  priority.
