# Failure Learning (self-evolving agent harness)

A pi extension that **learns from its own failures**: captures errors while you
work, turns them into learning reports, and proposes **skills** when the same
failure pattern repeats across sessions — so the harness gets better over time.

```
failures happen ──► captured (tool_execution_end / subagent run store)
                        │   fingerprinted + deduped per pattern
                        ▼
              ~/.pi/agent/learning/failures.json
                        │
            /learn (TUI command) ──► reports/failure-learning-<ts>.md
                        │              (first-time failures = "reports")
                        │               │
                        │               ▼
                        │   repeat across ≥2 sessions? ── no ──► stays reported
                        │               │ yes
                        │               ▼
                        │   draft skill written to learning/drafts/<name>.md
                        │   agent nudged (followUp) ├─ user approves ─► publish
                        │   └───────────────────────┤    skills/<name>/SKILL.md
                        │                            └─ declines ──► learn tool:
                        ▼                                              mark resolved /
            learn tool (LLM): status / report / mark / forget           false-positive
                                                                        (terminal — no more
                                                                         recommendations)
```

## What gets captured

| Source | Where | Kind | Dedup |
| --- | --- | --- | --- |
| Any tool call that errors (`tool_execution_end` with `isError`) | hook, main session only | `tool` | fingerprint (kind\|source\|normalized message) |
| Subagent/workflow runs that failed/​timed out (`record.json`) | ingested from the subagent run store | `subagent` | by `runId` (idempotent re-scan) |

Subagent failures are **not** captured from parent tool hooks — the broker's own
`subagent` tool call succeeds while the *child* fails. They come from the run
store instead, so nothing is double-counted. Subagent children (`PI_SUBAGENT_CHILD=1`)
never capture/write, so child processes can't race the parent's store.

Each failure record carries a **fingerprint** (sha1 of `kind|source|normalized
message`, where the message has numbers/paths/timestamps scrubbed so the same
underlying problem maps to one pattern), **occurrences**, **distinct sessions**
(same-session retry loops count once), and up to 3 **trace snapshots** (last
user prompt, the tool calls that led up to the failure, args, and the error
line) — so a later reviewer can reconstruct *why* it failed.

### Bridges to session notes (session-memory)

Failures and resolutions also leave a trace in the **session notes**, so
nothing is siloed in `failures.json`:

| Bridge | When | Where |
| --- | --- | --- |
| Auto errors-mirror | first time a tool failure touches a session | one line under the notes' `Errors & Corrections` (fingerprint+session deduped — retry loops never spam) |
| Resolution capture | `learn mark` skill-created/resolved | `resolvedAt` + optional `resolution` note on the pattern, plus a Learnings bullet with a back-link to the closing session |
| `reports/INDEX.md` | `/learn`, `learn report`, `learn mark` | persistent cross-session index linking each pattern to its sessions' notes |

## Lifecycle / status

```
new ──(≥2 distinct sessions)──► recommended ──(skill published)──► skill-created
      (repeat: report + draft skill + agent nudge)      (or) ──► resolved
                                                         (or) ──► false-positive
```

`skill-created`, `resolved`, and `false-positive` are **terminal** — `/learn`
stops recommending a skill for those patterns. The store is capped (1000
patterns, oldest dropped).

## Commands / tools

| Surface | What it does |
| --- | --- |
| `/learn` | re-scan subagent runs (idempotent) → write report → if repeat candidates: write draft skills + nudge the agent to refine & publish one |
| `/learn report` | write the report only (no nudge) |
| `/learn scan` | re-ingest subagent run failures |
| `/learn status` | brief counts (patterns / occurrences / repeat candidates) |
| `learn` (LLM tool) | `status` / `report` (bounded brief) / `mark {fingerprint, mark:"skill-created" | "resolved" | "false-positive", skillName?}` / `forget {fingerprint}` |

## Storage (override root with `PI_LEARNING_DIR`)

```
~/.pi/agent/learning/
  failures.json                  the failure store (meta + patterns)
  reports/failure-learning-<ts>.md   learning reports (one per /learn run)
  reports/INDEX.md               persistent cross-session index → session notes
  drafts/<name>.md               deterministic skill drafts the agent refines
```

## Files

- `failure-store.ts` — pure logic (fingerprint, merge, analyze, report, skill draft); no I/O
- `failure-store.test.ts` — unit tests (`npm run test:learning`)
- `index.ts` — extension wiring: capture hooks, `/learn`, `learn` tool, ingestion

## Verification

```bash
npm run test:learning   # 41 assertions pass
npm run typecheck       # clean
npm run lint            # clean
```

## Ideas for the future (not yet built)

- **Auto-threshold per source** — some tools (bash probes) are noisier; tune the
  repeat threshold per fingerprint family.
- **Skill quality feedback** — track whether failures decline after a skill is
  published.
