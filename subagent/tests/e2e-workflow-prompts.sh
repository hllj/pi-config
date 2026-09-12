#!/usr/bin/env bash
# OPT-IN live end-to-end test: the three bundled workflow prompt templates
# (/scout-and-plan, /implement, /implement-and-review), invoked by prompt.
#
# Spawns REAL pi subprocesses (needs ~/.pi/agent/auth.json + network).
# See TESTING-PLAN.md Section B.
#
# Slash-command expansion in one-shot -p mode is an untested assumption
# (TESTING-PLAN.md "Known gaps") - this script tries `/name <args>` first,
# and if that produces no chain dispatch at all, falls back to sending the
# prompt template's literal expanded text instead, noting which path it used.
#
# Usage:
#   ./e2e-workflow-prompts.sh                # cleans up after
#   ./e2e-workflow-prompts.sh --no-cleanup    # keep scratch dirs for inspection
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPTS_DIR="$SCRIPT_DIR/../prompts"
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

# Strip YAML frontmatter and substitute $@ with the query, mirroring how pi
# expands a prompt template (per pi's docs/skills-adjacent prompt-template
# mechanism): everything between the first pair of `---` lines is frontmatter.
expand_template() {
	template="$1"; query="$2"
	awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$template" | sed "s/\$@/$query/g"
}

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

# Order run dirs under a store by startedAt (embedded as the runId's 2nd
# hyphen-delimited field: sg-<epochms>-<rand>) — split the BASENAME only,
# not the full path, since the store dir itself may contain hyphens (e.g.
# "subagents-scout-and-plan-slash") that would otherwise pollute the split.
ordered_run_dirs() {
	store="$1"
	for d in "$store"/sg-*/; do
		[ -d "$d" ] || continue
		base="$(basename "$d")"
		ts="$(echo "$base" | cut -d- -f2)"
		echo "$ts $d"
	done | sort -n | awk '{print $2}'
}

# run_and_count <label> <store_dir> <prompt_text>
# echoes: "<count> <agent1>,<agent2>,..." (ordered by startedAt) on success
run_and_count() {
	label="$1"; store="$2"; prompt="$3"
	mkdir -p "$store"
	( cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$WORK/parent-$label" "$PI" --name "e2e-$label" -p "$prompt" ) >"$WORK/$label.out" 2>&1
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "0 "
		return
	fi
	dirs=$(ordered_run_dirs "$store")
	count=$(echo "$dirs" | grep -c . || true)
	agents=""
	for d in $dirs; do
		a=$(grep -o '"agent": "[a-z-]*"' "$d/record.json" | sed 's/"agent": "//;s/"//')
		agents="$agents,$a"
	done
	echo "$count ${agents#,}"
}

check_chain() {
	label="$1"; expected_order="$2"; store="$3"
	result="$4"
	count="$(echo "$result" | awk '{print $1}')"
	agents="$(echo "$result" | awk '{print $2}')"
	expected_count=$(echo "$expected_order" | tr ',' '\n' | grep -c .)
	if [ "$count" -lt "$expected_count" ]; then
		return 1
	fi
	if [ "$agents" != "$expected_order" ]; then
		fail "$label: chain order mismatch — expected '$expected_order', got '$agents'"
		return 1
	fi
	# {previous} substitution sanity: no step's output should be trivially
	# short (a placeholder that didn't get filled tends to produce a
	# degenerate, very short response).
	for d in $(ordered_run_dirs "$store"); do
		child=$(ls "$d"/*.jsonl 2>/dev/null | head -1)
		[ -z "$child" ] && continue
		bytes=$(wc -c <"$child")
		if [ "$bytes" -lt 200 ]; then
			fail "$label: a chain step's session file is suspiciously small ($bytes bytes) — {previous} may not have carried content"
			return 1
		fi
	done
	echo "OK $label: chain executed in order [$agents], all steps non-trivial"
	return 0
}

run_prompt_test() {
	label="$1"; template="$2"; query="$3"; expected_order="$4"
	echo "--- $label ---"
	store1="$WORK/subagents-$label-slash"
	result=$(run_and_count "$label-slash" "$store1" "/$label $query")
	count="$(echo "$result" | awk '{print $1}')"
	if [ "${count:-0}" -ge 1 ]; then
		echo "  (slash-command expansion produced $count dispatch(es))"
		check_chain "$label" "$expected_order" "$store1" "$result" && return
	else
		echo "  (slash-command '/$label' produced no dispatch — falling back to literal expanded text)"
	fi
	store2="$WORK/subagents-$label-literal"
	expanded="$(expand_template "$template" "$query")"
	result2=$(run_and_count "$label-literal" "$store2" "$expanded")
	count2="$(echo "$result2" | awk '{print $1}')"
	if [ "${count2:-0}" -lt 1 ]; then
		fail "$label: neither slash-command nor literal-expanded-text form produced any dispatch"
		return
	fi
	check_chain "$label (via literal fallback)" "$expected_order" "$store2" "$result2"
}

run_prompt_test "scout-and-plan" "$PROMPTS_DIR/scout-and-plan.md" \
	"how divide() handles the b=0 case in calc.py" "scout,planner"

run_prompt_test "implement" "$PROMPTS_DIR/implement.md" \
	"make divide() in calc.py return None instead of raising when b=0, with a test" "scout,planner,worker"

run_prompt_test "implement-and-review" "$PROMPTS_DIR/implement-and-review.md" \
	"add input validation to add() in calc.py so non-numeric args raise TypeError, with a test" "worker,reviewer,worker"

echo ""
if [ "$FAILED" = "1" ]; then
	echo "E2E WORKFLOW PROMPTS: FAILED (see FAIL lines above)"
	exit 1
fi
echo "E2E WORKFLOW PROMPTS OK"
