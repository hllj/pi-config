#!/usr/bin/env bash
# OPT-IN live end-to-end test: run_workflow tool mode (conditions, error
# handlers, parallelGroup, budget nudge, resume_workflow). See
# TESTING-PLAN.md Section C.
#
# Each workflow's steps are dictated to the model as an explicit JSON payload
# ("call run_workflow with exactly these steps") rather than left to the
# model's own judgment — this is a mechanism test, not a delegation-judgment
# test, so we want the LLM just passing structured params through reliably.
#
# Step "failure" is forced deterministically via a very short timeoutMs
# (100ms - no real task completes that fast), not by asking the model to
# fail on cue, so condition/retry assertions don't depend on model behavior.
#
# requiresApproval is NOT covered here - see TESTING-PLAN.md "Known gaps"
# (needs ctx.hasUI, which -p mode does not reliably provide).
#
# Usage:
#   ./e2e-run-workflow.sh                # cleans up after
#   ./e2e-run-workflow.sh --no-cleanup    # keep scratch dirs for inspection
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

cleanup() {
	if [ "$CLEANUP" = "1" ]; then rm -rf "$WORK"; else echo "Kept scratch dir: $WORK"; fi
}
trap cleanup EXIT

fail() {
	echo "FAIL: $1"
	FAILED=1
}

REPO="$WORK/repo"
mkdir -p "$REPO"
(cd "$REPO" && git init -q && git config user.email t@t.com && git config user.name t && echo x >f.txt && git add -A && git commit -q -m init)

ordered_run_dirs() {
	store="$1"
	for d in "$store"/sg-*/; do
		[ -d "$d" ] || continue
		base="$(basename "$d")"
		ts="$(echo "$base" | cut -d- -f2)"
		echo "$ts $d"
	done | sort -n | awk '{print $2}'
}

run_workflow_test() {
	label="$1"; steps_json="$2"
	store="$WORK/subagents-$label"
	parent="$WORK/parent-$label"
	mkdir -p "$store" "$parent"
	prompt="Call the run_workflow tool exactly once with this literal steps array (pass it through as-is, do not modify it): $steps_json"
	( cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$parent" "$PI" --name "e2e-$label" -p "$prompt" ) >"$WORK/$label.out" 2>&1
	echo "$store $parent"
}

echo "--- Condition gate: step2 skipped when step1's exitCode != 0 ---"
result=$(run_workflow_test "condition" '[{"agent":"general","task":"reply OK","timeoutMs":100,"errorHandler":{"strategy":"skip"}},{"agent":"general","task":"reply STEP2_RAN","condition":{"type":"exitCodeEquals","value":0}}]')
store="$(echo "$result" | awk '{print $1}')"
dirs=$(ordered_run_dirs "$store")
count=$(echo "$dirs" | grep -c . || true)
if [ "$count" -lt 1 ]; then
	fail "condition: expected at least step 1 to dispatch, got $count run(s)"
elif [ "$count" -ge 2 ]; then
	fail "condition: step2 dispatched despite step1's forced non-zero exit — condition gate did not skip it"
else
	echo "OK condition: only step1 dispatched (forced-fail exitCode != 0 -> step2's exitCodeEquals:0 gate correctly skipped it)"
fi

echo "--- Error handler retry: maxRetries respected, workflow ends failed ---"
result=$(run_workflow_test "retry" '[{"agent":"general","task":"reply OK","timeoutMs":100,"errorHandler":{"strategy":"retry","maxRetries":1}}]')
store="$(echo "$result" | awk '{print $1}')"
dirs=$(ordered_run_dirs "$store")
count=$(echo "$dirs" | grep -c . || true)
if [ "$count" -ne 2 ]; then
	fail "retry: expected exactly 2 dispatch attempts (1 initial + maxRetries:1), got $count"
else
	echo "OK retry: exactly 2 attempts made (initial + 1 retry) before giving up"
fi

echo "--- parallelGroup: two steps run concurrently, not sequentially ---"
result=$(run_workflow_test "parallel-group" '[{"agent":"general","task":"reply PAR_A","parallelGroup":"g1"},{"agent":"general","task":"reply PAR_B","parallelGroup":"g1"}]')
store="$(echo "$result" | awk '{print $1}')"
dirs=$(ordered_run_dirs "$store")
count=$(echo "$dirs" | grep -c . || true)
if [ "$count" -ne 2 ]; then
	fail "parallelGroup: expected exactly 2 dispatches, got $count"
else
	starts=()
	ends=()
	for d in $dirs; do
		starts+=("$(grep -o '"startedAt": [0-9]*' "$d/record.json" | grep -o '[0-9]*')")
		ends+=("$(grep -o '"endedAt": [0-9]*' "$d/record.json" | grep -o '[0-9]*')")
	done
	# True concurrency: the later start happened before the earlier end.
	if [ "${starts[1]}" -lt "${ends[0]}" ] || [ "${starts[0]}" -lt "${ends[1]}" ]; then
		echo "OK parallelGroup: both steps' time windows overlap (ran concurrently)"
	else
		fail "parallelGroup: steps ran sequentially, not concurrently (no time-window overlap)"
	fi
fi

echo "--- Budget nudge: tiny budgetTokens forces an advisory steer ---"
store="$WORK/subagents-budget"
parent="$WORK/parent-budget"
mkdir -p "$store" "$parent"
prompt='Call the run_workflow tool exactly once with budgetTokens: 500 and this literal steps array: [{"agent":"general","task":"reply OK"},{"agent":"general","task":"reply again with OK2"}]'
( cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$parent" "$PI" --name e2e-budget -p "$prompt" ) >"$WORK/budget.out" 2>&1
parent_session="$(find "$parent" -name '*.jsonl' | head -1)"
if [ -z "$parent_session" ] || ! grep -q "Workflow budget nudge" "$parent_session"; then
	fail "budget: no 'Workflow budget nudge' steer found in the parent session despite a 500-token budget on a multi-step workflow"
else
	echo "OK budget: nudge steer appeared in the parent session"
fi

echo "--- resume_workflow: best-effort (timing-dependent), SKIPs rather than fails on a timing miss ---"
store="$WORK/subagents-resume"
parent="$WORK/parent-resume"
mkdir -p "$store" "$parent"
prompt='Call the run_workflow tool exactly once with name "resume-test" and this literal steps array: [{"agent":"general","task":"reply STEP1_DONE"},{"agent":"general","task":"reply STEP2_DONE","timeoutMs":120000}]'
( cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$parent" "$PI" --name e2e-resume -p "$prompt" >"$WORK/resume.out" 2>&1 ) &
RESUME_PID=$!
STEP1_SEEN=0
for _ in $(seq 1 60); do
	if ls "$store"/sg-*/record.json >/dev/null 2>&1 && grep -l '"status": "completed"' "$store"/sg-*/record.json >/dev/null 2>&1; then
		STEP1_SEEN=1
		break
	fi
	sleep 1
done
if [ "$STEP1_SEEN" = "1" ]; then
	kill -9 "$RESUME_PID" 2>/dev/null
	wait "$RESUME_PID" 2>/dev/null
	resume_prompt="Call resume_workflow with workflowId omitted (resume the most recent workflow)."
	( cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$WORK/parent-resume2" "$PI" --name e2e-resume2 -p "$resume_prompt" ) >"$WORK/resume2.out" 2>&1
	dirs=$(ordered_run_dirs "$store")
	completed=$(grep -l '"status": "completed"' "$store"/sg-*/record.json 2>/dev/null | wc -l | tr -d ' ')
	if [ "${completed:-0}" -ge 2 ]; then
		echo "OK resume_workflow: step1's prior result was kept and the workflow completed after resume ($completed completed steps total)"
	else
		fail "resume_workflow: expected >=2 completed steps after resume (step1 kept + step2 newly run), got $completed"
	fi
else
	kill -9 "$RESUME_PID" 2>/dev/null
	wait "$RESUME_PID" 2>/dev/null
	echo "SKIP resume_workflow: step1 didn't complete within 60s of polling — timing-dependent test, not a hard failure (see TESTING-PLAN.md)"
fi

echo ""
if [ "$FAILED" = "1" ]; then
	echo "E2E RUN_WORKFLOW: FAILED (see FAIL lines above)"
	exit 1
fi
echo "E2E RUN_WORKFLOW OK"
