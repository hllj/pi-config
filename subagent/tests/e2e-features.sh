#!/usr/bin/env bash
# OPT-IN live end-to-end test: watchdog trigger+dispatch+parse, and the
# session-wide spawn ceiling. See TESTING-PLAN.md Section E.
#
# Reviewer's and evidence-auditor's verdict-enum contracts are already
# asserted in e2e-agents.sh (Section A) - not repeated here.
#
# The watchdog test touches your REAL ~/.pi/agent/watchdog/state.json (there
# is no env-var override for this path, matching verify-guard.ts's sibling
# toggle). It is always saved and restored via a trap, including on failure
# or Ctrl+C.
#
# Usage:
#   ./e2e-features.sh                # cleans up after
#   ./e2e-features.sh --no-cleanup   # keep scratch dirs for inspection
set -o pipefail

WORK="$(mktemp -d)"
CLEANUP=1
if [ "$1" = "--no-cleanup" ]; then CLEANUP=0; fi
FAILED=0

PI="${PI_BIN:-/opt/homebrew/bin/pi}"

if [ ! -f "$HOME/.pi/agent/auth.json" ]; then
	echo "SKIP: ~/.pi/agent/auth.json not found - live E2E needs provider credentials."
	[ "$CLEANUP" = "1" ] && rm -rf "$WORK"
	exit 0
fi

WATCHDOG_STATE="$HOME/.pi/agent/watchdog/state.json"
WATCHDOG_BACKUP="$WORK/watchdog-state-backup.json"
WATCHDOG_EXISTED=0
if [ -f "$WATCHDOG_STATE" ]; then
	WATCHDOG_EXISTED=1
	cp "$WATCHDOG_STATE" "$WATCHDOG_BACKUP"
fi

cleanup() {
	# Always restore the real watchdog toggle to its pre-test state, even on
	# a failed assertion or an interrupt.
	if [ "$WATCHDOG_EXISTED" = "1" ]; then
		mkdir -p "$(dirname "$WATCHDOG_STATE")"
		cp "$WATCHDOG_BACKUP" "$WATCHDOG_STATE"
	else
		rm -f "$WATCHDOG_STATE"
	fi
	if [ "$CLEANUP" = "1" ]; then rm -rf "$WORK"; else echo "Kept scratch dir: $WORK"; fi
}
trap cleanup EXIT

fail() {
	echo "FAIL: $1"
	FAILED=1
}

ordered_run_dirs() {
	store="$1"
	for d in "$store"/sg-*/; do
		[ -d "$d" ] || continue
		base="$(basename "$d")"
		ts="$(echo "$base" | cut -d- -f2)"
		echo "$ts $d"
	done | sort -n | awk '{print $2}'
}

echo "--- Watchdog: trigger + dispatch + parse (regression for the expect.ts fix) ---"
REPO="$WORK/repo"
mkdir -p "$REPO"
echo '// scratch' >"$REPO/util.js"
(cd "$REPO" && git init -q && git config user.email t@t.com && git config user.name t && git add -A && git commit -q -m init)

mkdir -p "$(dirname "$WATCHDOG_STATE")"
echo '{"enabled": true}' >"$WATCHDOG_STATE"

store="$WORK/subagents-watchdog"
parent="$WORK/parent-watchdog"
mkdir -p "$store" "$parent"
(cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$parent" "$PI" --name e2e-watchdog -p "Add a function greet(name) that returns 'Hello, ' + name to util.js.") >"$WORK/watchdog.out" 2>&1

dirs=$(ordered_run_dirs "$store")
count=$(echo "$dirs" | grep -c . || true)
if [ "$count" -lt 1 ]; then
	fail "watchdog: no run-store record appeared at all - the watchdog never dispatched (check the mutation boundary trigger in subagent/index.ts)"
else
	watchdog_rec=""
	for d in $dirs; do
		if grep -q '"agent": "reviewer"' "$d/record.json"; then
			watchdog_rec="$d/record.json"
			break
		fi
	done
	if [ -z "$watchdog_rec" ]; then
		fail "watchdog: a run happened but none dispatched the 'reviewer' agent"
	elif grep -q '"status": "failed"' "$watchdog_rec"; then
		fail "watchdog: reviewer dispatch status is 'failed' — likely a structured-output parse regression in expect.ts ($(grep -o '"error": "[^"]*"' "$watchdog_rec"))"
	elif grep -q '"status": "completed"' "$watchdog_rec"; then
		echo "OK watchdog: triggered on the mutating turn and the reviewer dispatch completed cleanly"
	else
		fail "watchdog: reviewer dispatch in an unexpected state ($(grep -o '"status": "[a-z_]*"' "$watchdog_rec"))"
	fi
fi

echo "--- Spawn ceiling: PI_SUBAGENT_SPAWN_CEILING=1 warns on the 2nd dispatch ---"
store2="$WORK/subagents-ceiling"
parent2="$WORK/parent-ceiling"
mkdir -p "$store2" "$parent2"
(cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store2" PI_CODING_AGENT_SESSION_DIR="$parent2" PI_SUBAGENT_SPAWN_CEILING=1 "$PI" --name e2e-ceiling -p \
	'Call the subagent tool with parallel tasks: two general agents, one replying CEIL_A and one replying CEIL_B.') >"$WORK/ceiling.out" 2>&1

parent_session2="$(find "$parent2" -name '*.jsonl' | head -1)"
if [ -z "$parent_session2" ]; then
	fail "ceiling: no parent session file found to check for the warning"
elif ! grep -q "Subagent spawn ceiling" "$parent_session2"; then
	fail "ceiling: expected a 'Subagent spawn ceiling' advisory after exceeding PI_SUBAGENT_SPAWN_CEILING=1, none found"
else
	echo "OK ceiling: advisory steer appeared after exceeding the configured ceiling"
fi

echo ""
if [ "$FAILED" = "1" ]; then
	echo "E2E FEATURES: FAILED (see FAIL lines above)"
	exit 1
fi
echo "E2E FEATURES OK"
