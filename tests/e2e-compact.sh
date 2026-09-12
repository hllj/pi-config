#!/usr/bin/env bash
# OPT-IN live end-to-end regression test for trigger-compact.ts + custom-compact.ts.
#
# Spawns REAL pi subprocesses against your configured provider (requires
# ~/.pi/agent/auth.json + network), so this is NOT part of the offline unit
# suite (see trigger-compact.test.ts for that). Run it deliberately.
#
# What it guards against: pi core's AgentSession.compact() keeps its
# in-flight abort controller in a single shared field with no reentrancy
# guard, so two overlapping ctx.compact() calls race on it and crash with
# "Cannot read properties of undefined (reading 'signal')". A fire-and-forget
# compact() call's onComplete/onError can also fire after its ctx has gone
# stale (a later turn already started), and touching that ctx throws "This
# extension ctx is stale after session replacement or reload...". Both are
# real, reproducible crashes in the pre-fix code (verified live while writing
# this test — see the PR/commit this test shipped with) and this test proves
# the current trigger-compact.ts + custom-compact.ts no longer hit either one
# when /trigger-compact fires twice back to back in the same process, which
# is exactly how a user can trigger it: the automatic turn_end trigger firing
# while a manual /trigger-compact from a prior turn is still summarizing, or
# vice versa.
#
# Isolation: a temp PI_CODING_AGENT_DIR (own auth.json copy + settings.json,
# so the real ~/.pi/agent is never touched) and a temp --session-dir. Only
# trigger-compact.ts and custom-compact.ts are loaded (--no-extensions plus
# explicit -e), so this is hermetic and not affected by other extensions in
# this repo.
#
# Usage:
#   ./e2e-compact.sh                # cleans the isolated work dir after
#   ./e2e-compact.sh --no-cleanup   # keep it for inspection
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
CLEANUP=1
if [ "$1" = "--no-cleanup" ]; then CLEANUP=0; fi

PI="${PI_BIN:-/opt/homebrew/bin/pi}"

if [ ! -f "$HOME/.pi/agent/auth.json" ]; then
	echo "SKIP: ~/.pi/agent/auth.json not found - live E2E needs provider credentials."
	if [ "$CLEANUP" = "1" ]; then rm -rf "$WORK"; fi
	exit 0
fi

# Isolated agent dir: real auth, real provider/model defaults, but a
# near-zero keepRecentTokens so even a couple of short seed turns give the
# compactor something real to cut (default is 20_000 tokens, which a tiny
# smoke-test session would never exceed).
mkdir -p "$WORK/agent-dir"
cp "$HOME/.pi/agent/auth.json" "$WORK/agent-dir/auth.json"
node -e '
const fs = require("fs");
const path = process.argv[1];
let settings = {};
try { settings = JSON.parse(fs.readFileSync(process.env.HOME + "/.pi/agent/settings.json", "utf8")); } catch {}
settings.compaction = { ...(settings.compaction ?? {}), keepRecentTokens: 1 };
fs.writeFileSync(path, JSON.stringify(settings));
' "$WORK/agent-dir/settings.json"

export PI_CODING_AGENT_DIR="$WORK/agent-dir"

EXT_ARGS=(--no-extensions -e "$ROOT/trigger-compact.ts" -e "$ROOT/custom-compact.ts")

echo "=== [1/2] seed two short turns (something for the compactor to cut) ==="
"$PI" --session-dir "$WORK/sessions" "${EXT_ARGS[@]}" --name seed -p \
	"Reply with exactly the token SEED_ONE and nothing else." \
	"Reply with exactly the token SEED_TWO and nothing else." >"$WORK/seed.log" 2>&1 || {
	echo "FAIL: seeding turns errored"
	cat "$WORK/seed.log"
	exit 1
}
SESSION_FILE="$(ls -t "$WORK/sessions"/*.jsonl 2>/dev/null | head -1)"
if [ -z "$SESSION_FILE" ]; then
	echo "FAIL: no session file created"
	exit 1
fi
echo "OK seeded: $SESSION_FILE"

echo "=== [2/2] double /trigger-compact in one process (the race) ==="
if "$PI" --session "$SESSION_FILE" --session-dir "$WORK/sessions" "${EXT_ARGS[@]}" --name double-compact -p \
	"/trigger-compact" "/trigger-compact" >"$WORK/double.log" 2>&1; then
	STATUS=0
else
	STATUS=$?
fi
cat "$WORK/double.log"

if [ "$STATUS" -ne 0 ]; then
	echo "FAIL: pi exited $STATUS"
	exit 1
fi
if grep -q "reading 'signal'" "$WORK/double.log"; then
	echo "FAIL: hit the AgentSession.compact() abort-controller race (reading 'signal' of undefined)"
	exit 1
fi
if grep -q "ctx is stale after session replacement or reload" "$WORK/double.log"; then
	echo "FAIL: hit a stale-ctx crash from an overlapping compaction callback"
	exit 1
fi
echo "OK: no crash from two overlapping /trigger-compact calls"

if [ "$CLEANUP" = "1" ]; then
	rm -rf "$WORK"
	echo "cleaned up $WORK"
fi
echo "E2E COMPACT OK: double /trigger-compact does not crash the session"
