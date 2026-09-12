#!/usr/bin/env bash
# OPT-IN live end-to-end test: natural-language proactive triggering, with
# NO agent named explicitly. See TESTING-PLAN.md Section D.
#
# INFORMATIONAL ONLY - always exits 0. Per the 2026-09-12 live-verification
# findings, the default model (deepseek-v4-flash-0731) does not reliably
# self-trigger delegation from prose guidance alone, even for tasks matching
# our own documented trigger conditions verbatim. A "did not delegate"
# result here is the expected baseline, not a build-breaking regression -
# record it, don't gate on it. Re-run after a model swap or a
# promptGuidelines change to see if the signal moves.
#
# Usage:
#   ./e2e-proactive.sh                # cleans up after
#   ./e2e-proactive.sh --no-cleanup   # keep scratch dirs for inspection
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./e2e-lib.sh
. "$SCRIPT_DIR/e2e-lib.sh"

WORK="$(mktemp -d)"
CLEANUP=1
if [ "$1" = "--no-cleanup" ]; then CLEANUP=0; fi

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

REPO="$WORK/repo"
mkdir -p "$REPO/src"
for f in a b c d e f g h i j k; do
	printf '// module %s\nfunction %s() { return "%s"; }\nmodule.exports = { %s };\n' "$f" "$f" "$f" "$f" >"$REPO/src/$f.js"
done
(cd "$REPO" && git init -q && git config user.email t@t.com && git config user.name t && git add -A && git commit -q -m init)

check_dispatched() {
	label="$1"; prompt="$2"; expected_mode="$3"
	store="$WORK/subagents-$label"
	parent="$WORK/parent-$label"
	mkdir -p "$store" "$parent"
	(cd "$REPO" && PI_SUBAGENT_SESSION_DIR="$store" PI_CODING_AGENT_SESSION_DIR="$parent" run_pi_retrying "$PI" "$WORK/$label.out" --name "e2e-$label" -p "$prompt")
	count=$(ls -d "$store"/sg-*/ 2>/dev/null | wc -l | tr -d ' ')
	if [ "${count:-0}" -ge 1 ]; then
		modes="$(grep -oh '"mode": "[a-z]*"' "$store"/sg-*/record.json 2>/dev/null | sort -u | tr '\n' ',')"
		echo "DELEGATED  $label: $count dispatch(es), modes seen: ${modes%,} (expected shape: $expected_mode)"
	else
		echo "NOT-DELEGATED  $label: 0 dispatches — task done entirely inline"
	fi
}

echo "=== Proactive-trigger signal (informational — see header) ==="
echo ""

check_dispatched "explore-all" \
	"Explore this whole repo and give me a one-paragraph summary of every function in src/ — read every file's full body, don't skip any." \
	"single scout, or several"

check_dispatched "second-opinion" \
	"I just added src/l.js with a new function (go check what's there). Before I call this done, check my change over for correctness." \
	"single reviewer"

check_dispatched "parallel-shaped" \
	"Run 3 independent checks in parallel on this repo: (1) are there any obvious syntax errors, (2) is naming consistent across src/, (3) is there any dead code. Report all 3 results." \
	"parallel"

echo ""
echo "E2E PROACTIVE: informational run complete (always exits 0 — see TESTING-PLAN.md Section D)"
exit 0
