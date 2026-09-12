#!/usr/bin/env bash
# OPT-IN live end-to-end test: every packaged agent, dispatched by prompt.
#
# Spawns REAL pi subprocesses (needs ~/.pi/agent/auth.json + network). Two
# checks per agent: (1) a deterministic token-reply mechanical smoke test,
# (2) a realistic task against a shared fixture repo, asserted against that
# agent's OWN documented output contract (subagent/agents/<name>.md) — not
# just "didn't crash". See TESTING-PLAN.md Section A.
#
# Unlike e2e-smoke.sh this does NOT fail-fast: every agent is tried and every
# failure is collected, so one bad agent doesn't hide the rest of the report.
#
# Usage:
#   ./e2e-agents.sh                # cleans the isolated store after
#   ./e2e-agents.sh --no-cleanup   # keep the scratch repo + store for inspection
set -o pipefail

WORK="$(mktemp -d)"
CLEANUP=1
if [ "$1" = "--no-cleanup" ]; then CLEANUP=0; fi
FAILED=0

export PI_SUBAGENT_SESSION_DIR="$WORK/subagents"
export PI_CODING_AGENT_SESSION_DIR="$WORK/parent-sessions"

PI="${PI_BIN:-/opt/homebrew/bin/pi}"

if [ ! -f "$HOME/.pi/agent/auth.json" ]; then
	echo "SKIP: ~/.pi/agent/auth.json not found - live E2E needs provider credentials."
	[ "$CLEANUP" = "1" ] && rm -rf "$WORK"
	exit 0
fi

cleanup() {
	if [ "$CLEANUP" = "1" ]; then rm -rf "$WORK"; else echo "Kept scratch dir: $WORK"; fi
}
trap cleanup EXIT

fail() {
	echo "FAIL: $1"
	FAILED=1
}

# ---- fixture repo: gives every agent something non-trivial to do ----
REPO="$WORK/repo"
mkdir -p "$REPO"
cat >"$REPO/calc.py" <<'PY'
def add(a, b):
    """Add two numbers."""
    return a + b

def divide(a, b):
    """Divide a by b. Handles b=0 by returning None."""
    return a / b
PY
cat >"$REPO/test_calc.py" <<'PY'
def test_add():
    from calc import add
    assert add(2, 3) == 5
PY
(cd "$REPO" && git init -q && git config user.email t@t.com && git config user.name t && git add -A && git commit -q -m init)

ORIGINAL_CALC="$(cat "$REPO/calc.py")"

# ---- helper: run one dispatch, echo the run's newest record dir (or nothing) ----
run_dispatch() {
	name="$1"; cwd="$2"; prompt="$3"
	( cd "$cwd" && "$PI" --name "e2e-$name" -p "$prompt" ) >"$WORK/$name.out" 2>&1
	status=$?
	if [ "$status" -ne 0 ]; then
		fail "$name: pi invocation exited $status (see $WORK/$name.out)"
		return
	fi
	run_dir="$(ls -dt "$WORK/subagents"/*/ 2>/dev/null | head -1)"
	if [ -z "$run_dir" ]; then
		fail "$name: no run directory created at all"
		return
	fi
	echo "$run_dir"
}

assert_record_ok() {
	name="$1"; run_dir="$2"
	rec="$run_dir/record.json"
	if [ ! -f "$rec" ]; then
		fail "$name: no record.json under $run_dir"
		return 1
	fi
	if ! grep -q '"status": "completed"' "$rec"; then
		fail "$name: record status is not 'completed' ($(grep -o '"status": "[a-z_]*"' "$rec"))"
		return 1
	fi
	if ! grep -q '"exitCode": 0' "$rec"; then
		fail "$name: record exitCode != 0"
		return 1
	fi
	return 0
}

assert_contains() {
	name="$1"; run_dir="$2"; pattern="$3"; label="$4"
	child="$(ls "$run_dir"/*.jsonl 2>/dev/null | head -1)"
	if [ -z "$child" ]; then
		fail "$name: no child session file to check for $label"
		return 1
	fi
	if ! grep -qE "$pattern" "$child"; then
		fail "$name: missing expected $label (pattern: $pattern)"
		return 1
	fi
	echo "  ok: $label present"
	return 0
}

echo "=== Mechanical smoke tests (token reply, all 6 agents) ==="
for agent in scout planner reviewer worker general evidence-auditor; do
	token="SMOKE_${agent//-/_}_$$"
	dir=$(run_dispatch "mech-$agent" "$REPO" "You MUST call the subagent tool exactly once with agent '$agent' and task 'Reply with exactly the token $token and nothing else'. Wait for it, then report the returned token verbatim.")
	[ -z "$dir" ] && continue
	assert_record_ok "mech-$agent" "$dir" || continue
	if ! grep -q "\"agent\": \"$agent\"" "$dir/record.json"; then
		fail "mech-$agent: record.json agent field mismatch"
		continue
	fi
	echo "OK mech-$agent: $(grep -o '"runId": "[^"]*"' "$dir/record.json")"
done

echo ""
echo "=== Realistic-task contract checks (dependency order matters) ==="

echo "--- evidence-auditor: audit the FALSE claim before any fix ---"
dir=$(run_dispatch "evidence-auditor" "$REPO" \
	"Use the evidence-auditor subagent. Claim to audit: \"divide() in calc.py handles b=0 by returning None.\" Sources: calc.py in this directory. Report back the auditor's full response.")
if [ -n "$dir" ]; then
	assert_record_ok "evidence-auditor" "$dir" && \
		assert_contains "evidence-auditor" "$dir" 'contradicted' "a 'contradicted' verdict (this claim is false - ZeroDivisionError, not None)"
fi

echo "--- scout: find the division code + its test coverage ---"
dir=$(run_dispatch "scout" "$REPO" \
	"Use the scout subagent to find where division is implemented in this repo and what tests exist for it.")
if [ -n "$dir" ]; then
	assert_record_ok "scout" "$dir" && \
		assert_contains "scout" "$dir" 'Files Retrieved' "the '## Files Retrieved' section"
fi

echo "--- planner: plan the b=0 fix (no edits) ---"
dir=$(run_dispatch "planner" "$REPO" \
	"Use the planner subagent to plan how to make divide() in calc.py handle b=0 safely by returning None instead of raising.")
if [ -n "$dir" ]; then
	assert_record_ok "planner" "$dir" && \
		assert_contains "planner" "$dir" '## Plan' "the '## Plan' section"
	CURRENT_CALC="$(cat "$REPO/calc.py")"
	if [ "$CURRENT_CALC" != "$ORIGINAL_CALC" ]; then
		fail "planner: calc.py was modified but planner must be read-only"
	else
		echo "  ok: calc.py untouched by planner"
	fi
fi

echo "--- worker: TDD the b=0 fix ---"
dir=$(run_dispatch "worker" "$REPO" \
	"Use the worker subagent, test-first (TDD): add a test for divide(a, 0) in test_calc.py and make divide() in calc.py return None when b=0 instead of raising.")
if [ -n "$dir" ]; then
	assert_record_ok "worker" "$dir" && \
		assert_contains "worker" "$dir" 'Test Evidence' "the '## Test Evidence' section"
	if (cd "$REPO" && git diff --quiet -- calc.py); then
		fail "worker: calc.py was NOT modified"
	else
		echo "  ok: calc.py modified by worker"
	fi
fi

echo "--- reviewer: review the worker's diff ---"
dir=$(run_dispatch "reviewer" "$REPO" \
	"Use the reviewer subagent to review the current uncommitted diff (git diff) for correctness.")
if [ -n "$dir" ]; then
	assert_record_ok "reviewer" "$dir" && \
		assert_contains "reviewer" "$dir" 'Merge verdict: (BLOCK|OK|OK with notes)' "the 'Merge verdict:' line"
fi

echo "--- general: unrelated small task end-to-end ---"
dir=$(run_dispatch "general" "$REPO" \
	"Use the general subagent to add input validation to add() in calc.py so non-numeric arguments raise a clear TypeError, with a test.")
if [ -n "$dir" ]; then
	assert_record_ok "general" "$dir" && \
		assert_contains "general" "$dir" 'Test Evidence' "the '## Test Evidence' section"
fi

echo ""
if [ "$FAILED" = "1" ]; then
	echo "E2E AGENTS: FAILED (see FAIL lines above; raw outputs at $WORK/*.out — rerun with --no-cleanup to keep them)"
	exit 1
fi
echo "E2E AGENTS OK: all 6 agents dispatched correctly and matched their output contracts"
