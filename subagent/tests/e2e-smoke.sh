#!/usr/bin/env bash
# OPT-IN live end-to-end smoke test for the subagent run store.
#
# Spawns REAL pi subprocesses against your configured providers (requires
# ~/.pi/agent/auth.json + a reachable LLM provider), so this is NOT part of the
# offline unit suite. Run it deliberately to verify the full
# dispatch -> record -> cross-session query path.
#
# Usage:
#   ./e2e-smoke.sh                # cleans the isolated store after
#   ./e2e-smoke.sh --no-cleanup   # keep the isolated store dir for inspection
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
CLEANUP=1
if [ "$1" = "--no-cleanup" ]; then CLEANUP=0; fi

export PI_SUBAGENT_SESSION_DIR="$WORK/subagents"
export PI_CODING_AGENT_SESSION_DIR="$WORK/parent-sessions"

PI="${PI_BIN:-/opt/homebrew/bin/pi}"

if [ ! -f "$HOME/.pi/agent/auth.json" ]; then
	echo "SKIP: ~/.pi/agent/auth.json not found - live E2E needs provider credentials."
	if [ "$CLEANUP" = "1" ]; then rm -rf "$WORK"; fi
	exit 0
fi

cd "$ROOT"

echo "=== [1/5] single dispatch ==="
"$PI" --session-dir "$WORK/parent-sessions" --name e2e-single -p \
	"You MUST call the subagent tool exactly once with agent 'worker' and task 'Reply with exactly the token SMOKE_A1_42 and nothing else'. Wait for it, then report the returned token verbatim." || exit 1

RUN_DIR="$(ls -dt "$WORK/subagents"/*/ 2>/dev/null | head -1)"
REC="$RUN_DIR/record.json"
if [ ! -f "$REC" ]; then echo "FAIL: no record.json under $RUN_DIR"; exit 1; fi
grep -q '"status": "completed"' "$REC" || { echo "FAIL: run not completed"; exit 1; }
grep -q '"exitCode": 0' "$REC" || { echo "FAIL: exitCode != 0"; exit 1; }
CHILD="$(ls "$RUN_DIR"/*.jsonl 2>/dev/null | head -1)"
if [ -z "$CHILD" ]; then echo "FAIL: no child session file"; exit 1; fi
echo "OK single dispatch: $(grep -o '"runId": "[^"]*"' "$REC")"

echo "=== [2/5] parent pointer appended ==="
PS="$(ls "$WORK/parent-sessions"/*.jsonl 2>/dev/null | head -1)"
grep -q '"subagent-session"' "$PS" || { echo "FAIL: no subagent-session pointer in parent"; exit 1; }
echo "OK parent pointer"

echo "=== [3/5] cross-session query (fresh process) ==="
"$PI" --session-dir "$WORK/parent-sessions" --name e2e-query -p \
	"Call list_subagent_sessions. Take the newest runId, call get_subagent_session with includeTranscript=true. Reply with that run's status and the transcript message count. If either tool errors, say TOOL_ERROR." || exit 1
echo "OK cross-session query"

echo "=== [4/5] parallel dispatch (3 workers) ==="
"$PI" --session-dir "$WORK/parent-sessions" --name e2e-par -p \
	"Call the subagent tool with parallel tasks: 3 workers replying TOKEN_X1, TOKEN_X2, TOKEN_X3. After all finish, report each token." || exit 1
RUNS="$(ls -d "$WORK/subagents"/*/ 2>/dev/null | wc -l)"
if [ "$RUNS" -lt 4 ]; then echo "FAIL: expected >=4 run dirs, have $RUNS"; exit 1; fi
echo "OK parallel: $RUNS run dirs total"

echo "=== [5/5] orphan reconcile on session start ==="
ORPHAN_DIR="$WORK/subagents/sg-orphan-smoke"
mkdir -p "$ORPHAN_DIR"
cat > "$ORPHAN_DIR/record.json" <<JSON
{"runId":"sg-orphan-smoke","agent":"worker","agentSource":"user","task":"crashed","model":"m","mode":"single","parentSessionId":"p","parentSessionFile":"/p","status":"running","startedAt":$(($(date +%s%3N) - 5*60000)),"usage":{},"pid":4194304}
JSON
"$PI" --session-dir "$WORK/parent-sessions" --name e2e-orphan -p "Reply EXACTLY with ORPHAN_OK" || exit 1
grep -q '"status": "orphaned"' "$ORPHAN_DIR/record.json" || { echo "FAIL: orphan not reconciled"; exit 1; }
echo "OK orphan reconciled to 'orphaned'"

if [ "$CLEANUP" = "1" ]; then
	rm -rf "$WORK"
	echo "cleaned up $WORK"
fi
echo "E2E SMOKE OK: single + parent-pointer + cross-session query + parallel + orphan"