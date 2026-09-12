# Subagent extension improvement plan (informed by nicobailon/pi-subagents)

**Why this exists:** while reviewing `~/Projects/pi-bench/plans/improvement-plan.md` (a SWE-bench-verified-mini run analysis), three of that run's cross-cutting problems — tool-loop/scope-drift detection, judge/review reliability, and per-run telemetry — turned out to have close analogs in this extension's own weak points. `nicobailon/pi-subagents` (a comparable pi extension) has already built solutions to overlapping problems. This plan adapts the useful mechanisms into `pi-config/subagent`, skipping anything that's pitch-deck-only or redundant with what we already have (workflow persistence/resume, messaging, run store, structured `expect` output, parallel groups — all already shipped, see `README.md`).

**What we already have that pi-subagents doesn't need re-adding:** single/parallel/chain/workflow modes; agent frontmatter (`timeoutMs`, `thinking`, `env`, `readonly`, `contextFiles`); cross-agent messaging; a persistent run store with real pi session files + `record.json`; `/agents` and `/runs` TUI; `expect` JSON-Schema structured-output contracts; parallel workflow groups with condition/errorHandler/approval gates; resumable workflows.

## Gap 1 (highest value): no live, in-session reviewer — only post-hoc

Our `reviewer` agent is dispatched manually, after the fact, on a diff. pi-subagents' **watchdog** runs *during* a session: a second model reviews the diff at natural boundaries (after a turn that changed the repo, or every N tool calls) and looks explicitly for missed constraints, correctness risk, test gaps, **loop risk, and scope drift** — with a zero-cost LSP diagnostics pre-pass feeding in before any model call is spent. It has **stalemate detection**: after `stalemateRepeats` (default 3) identical warnings in a row, it stops nagging instead of looping forever nagging the same thing.

This maps directly to two SWE-bench findings: (1) our own `loop-guard.ts` (in pi-bench) only catches literal identical-tool-call repeats and a git-log/show/blame regex streak — a *semantic* loop (varying commands, same unproductive direction, e.g. chasing version tags across a repo) slips through entirely; (2) the config-file-pollution guard there only fires once, at the end. A live watchdog catches both classes the moment they happen, in-session, not just in the benchmark's own driver code.

- [ ] Design a `watchdog` capability as a new module (`pi-config/subagent/watchdog.ts`): boundary trigger on `turn_end` when the turn included a mutation (`edit`/`write`), plus an optional cadence trigger (every N tool calls, floor 5, configurable).
- [ ] Reuse the existing `reviewer` agent's model/tools as the default watchdog model, but make it overridable (a cheaper/faster model for continuous monitoring vs. the heavier one used for on-demand review).
- [ ] Structured findings only: `{ severity, category ("correctness"|"test-gap"|"loop-risk"|"scope-drift"|"unsafe-change"), evidence, recommendedAction }`, steered into the transcript only when non-empty — mirrors the `verify-guard.ts` pattern of "advisory, event-driven, never blocks."
- [ ] Stalemate guard: hash the finding set; after 3 identical hashes in a row, stop surfacing (same shape as `trackGitArchaeology`'s streak-then-reset in pi-bench's `loop-guard.ts` — steal the pattern, not the code).
- [ ] Persisted toggle `/watchdog`, default state file at `~/.pi/agent/watchdog/state.json`, following the exact `verify-guard.ts` / `dev-workflows.ts` nudge-state precedent already in this repo (one-time session hint, subagent children never trigger it).
- [ ] This is the most direct fix for two SWE-bench pain points — prioritize it first.

## Gap 2: reviewer has no evidence bar or verdict enum

Our `subagent/agents/reviewer.md` uses a loose Critical/Warning/Suggestion format with no requirement that a finding cite proof. pi-subagents' review-loop/parallel-review prompts require findings to be P0/P1/P2 **and** backed by a repro, a source citation, or a contract contradiction — "filter on evidence, not severity" — ending with a mandatory `Merge verdict: BLOCK / OK / OK with notes`.

This is the concrete fix for the SWE-bench judge problem: 3 of 15 fails were the judge saying "correct" when the container test disagreed (the RFC7231 `utcnow()` time-trap, the byte-diff false positive). A verdict-enum + evidence-gate contract, if applied to pi-bench's own judge prompt (see the companion plan `pi-bench/plans/2026-09-12-harness-improvements-round-2.md`, Task 7), and to our own `reviewer.md` for everyday dev work, stops rubber-stamp reviews in both places.

- [ ] Rewrite `subagent/agents/reviewer.md`'s output format section to require: each finding cites either a failing test/repro command, an exact source line contradicting the claim, or a stated contract violation — no finding admitted on "looks risky" alone.
- [ ] Add a mandatory closing line: `Merge verdict: BLOCK | OK | OK with notes`, with BLOCK requiring at least one evidenced P0/P1 finding.
- [ ] Update `skills/subagents/SKILL.md` §6 ("Use subagents as a review/verification gate") to reference the verdict enum so callers know to gate on it programmatically (e.g. via `expect` JSON schema: `{ verdict: "BLOCK"|"OK"|"OK with notes", findings: [...] }`).

## Gap 3: no structured "decision-consistency" or "evidence-audit" agent role

pi-subagents' **oracle** agent forks the parent's context, reconstructs inherited decisions/constraints, and reports Diagnosis / Drift-or-contradiction-check / Recommendation / Risks — explicitly refusing to become a second decision-maker. Its **evidence-auditor** checks specific claims against sources (`supported`/`contradicted`/`unclear`/`missing-evidence`) instead of re-researching from scratch.

We have `general` (all-rounder) and `reviewer` (diff review) but nothing that takes "here's what we decided and why, check it's still consistent" or "here's a claim, verify it against the source" as a first-class, narrowly-scoped task shape. Both would help catch exactly the class of error the SWE-bench judge missed: a claim ("this is algebraically equivalent to the reference") that's false on inspection of the actual frozen test.

- [ ] Add `subagent/agents/evidence-auditor.md`: read-only, tools `read, grep, find, ls`; given a claim + a set of source files/tests, report `supported | contradicted | unclear | missing-evidence` with the exact line(s) that decide it. No open-ended research — it audits, it doesn't investigate.
- [ ] Consider `oracle.md` only if a real need for cross-session decision-consistency checks shows up in practice (fork's context-inheritance trick is `pi`-runtime-specific to how pi-subagents forks; verify our own `fork`-mode subagent semantics support the same "inherit full context" trick before committing to this — lower priority than evidence-auditor, which needs no special runtime support).

## Gap 4: no budget-driven idle nudge for long-running goals

pi-subagents' "goal missions" pair a token budget with an idle-turn nudge ("here's the remaining budget and next ready action") until the budget exhausts or the goal closes. We have workflow persistence/resume (state survives crashes) but nothing that nudges *while a workflow is running long* the way pi-bench's own missing "elapsed-budget nudge" (see companion plan, Task 5) needed.

- [ ] Add an optional `budgetTokens` (or `budgetMs`) field to `run_workflow`/workflow steps; when a workflow's cumulative usage crosses 60%/85% of budget, surface one advisory message each via the existing workflow widget/status mechanism (`workflow-widget.ts` already renders live state — extend it, don't replace it).
- [ ] Skip cron-like scheduling (`docs/missions.md`'s `schedule.create`) — no evidence of a current need, and it's a meaningfully larger surface (recurring background execution, quiet-run semantics) than the rest of this plan's ROI justifies. Revisit only if a concrete recurring-task use case shows up.

## Gap 5: `/runs` has no live spend/activity view or spawn ceiling

pi-subagents' FleetView shows per-child token window/spend/duration/activity-freshness live, plus a hard `maxSubagentSpawnsPerRun` (default 64) spawn-budget ceiling separate from the concurrency cap. Our `/runs` is post-hoc audit only (agent/mode/status/duration/turns/cost columns, but not live-updating per-child spend while running) and `runSingleAgent`'s parallel cap (8 tasks, 4 concurrent) has no total-spawns-per-session ceiling.

- [ ] Lower priority — add a session-level spawn counter with a soft ceiling (e.g. 50/session) that warns rather than blocks, to catch a runaway workflow that keeps spawning fallback/retry agents without the user noticing token spend accumulating.
- [ ] Skip a full live activity-freshness view for now — `/runs` already covers the audit need; this is polish, not a correctness fix.

## Priority order

1. **Watchdog** (Gap 1) — directly fixes the semantic-loop and continuous-config-drift blind spots that hurt the SWE-bench run and would help everyday dev sessions too.
2. **Reviewer evidence bar + verdict enum** (Gap 2) — cheap (prompt-only change), directly targets the judge-reliability failure mode.
3. **evidence-auditor agent** (Gap 3) — cheap (one new agent file), narrow but useful for exactly the "is this claim actually true" check that was missing.
4. **Workflow budget nudge** (Gap 4) — moderate effort, lower urgency than 1-3 since no workflow has yet run long enough in practice to need it.
5. **Spawn ceiling / live FleetView polish** (Gap 5) — nice-to-have, do last if at all.

## Explicitly not adopting

- **Council mode** (multi-model bounded debate) — high implementation cost (supervisor-mediated multi-advisor protocol) for a need we haven't hit yet; our existing chain/parallel modes already cover "get a second opinion," just not a structured debate. Revisit only if a specific high-stakes-decision use case comes up.
- **Cron-like mission scheduling** — see Gap 4; out of scope until there's a concrete recurring-task need.
- **RPC inspection protocol for external hosts** — pi-subagents' FleetView inspector serves a plugin-host integration use case we don't have (`pi-config` is a personal extension set, not a hosted product).
