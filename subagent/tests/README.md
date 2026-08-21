# Subagent Run-Store Tests

Reusable tests for the persistent subagent session store
(`subagent/session-store.ts` and its integration in `subagent/index.ts`).

## Quick start

```bash
cd pi-config/subagent/tests

# Offline unit tests (no network, no API keys) — recommended on every change:
./run-unit.sh
```

The unit suite is deterministic and fast. It requires **Node >= 22** (type-stripping
lets plain `node` run `.ts`), and needs to locate the installed `@earendil-works`
modules. The runner resolves the modules automatically — override if your layout
differs:

```sh
./run-unit.sh                 # default: /opt/homebrew/lib/node_modules/@earendil-works
PI_MODULES_ROOT=/custom/location ./run-unit.sh
```

## What the unit suite covers

`run-unit.sh` copies the **current** `../session-store.ts` next to `unit.test.mjs`
in a throwaway workspace (with the pi modules resolvable) so you always test the
latest source — nothing is cached.

| Section | Asserts |
| --- | --- |
| `resolveStoreDir` | env override > derived-from-session-dir > `~/.pi/agent/subagents` fallback |
| record + list + get + end | atomic tmp+rename rewrite, newest-first sort, status / mode / since filters |
| atomicity / corrupt skip | stray `.tmp` ignored, malformed `record.json` skipped |
| **normalization regression** | a record with `usage: {}` (the `toFixed` crash) reads as numeric, `listRuns` doesn't throw |
| `reconcileOrphans` | dead pid → `orphaned`; live pid stays; 10-min no-pid staleness; 24h hard window |
| `pruneStore` | >14d removed; >14d running-with-pid prunable (not "live"); live never pruned |
| `pruneStore` cap + override | maxRuns keeps 5 newest; `PI_SUBAGENT_RETENTION_DAYS` override; `0` rejected |
| `formatDuration` | ms / seconds / minutes / undefined dash |
| `readRunTranscript` | `SessionManager.open` gives messages + header; JSONL fallback parse |

## Live end-to-end smoke test (opt-in)

`e2e-smoke.sh` spawns **real** pi subprocesses against your configured LLM
providers (needs `~/.pi/agent/auth.json` + network). It verifies the full path:

1. single dispatch writes `record.json` (completed, exitCode 0) + a child session file
2. one compact `subagent-session` pointer lands in the parent session
3. a **separate** pi process queries the store (`list_subagent_sessions` / `get_subagent_session`)
4. a 3-worker parallel dispatch creates distinct run dirs, no crosstalk
5. a stale planted `running` record is reconciled to `orphaned` on session start

Run it deliberately — it consumes provider tokens and needs credentials:

```sh
./e2e-smoke.sh                # auto-cleans its isolated store at the end
./e2e-smoke.sh --no-cleanup   # keep the isolated store dir for inspection
```

It uses isolated dirs (`PI_SUBAGENT_SESSION_DIR`, `PI_CODING_AGENT_SESSION_DIR`
point into a temp dir), so it touches neither your real run store nor your real
session history.

## Housekeeping

- `run-unit.sh` / `e2e-smoke.sh` clean up their temp workspaces on exit.
- The unit suite uses `os.tmpdir()` for its scratch stores and removes them.
- Nothing in `tests/` is loaded by the extension — it is instrumentation only.
