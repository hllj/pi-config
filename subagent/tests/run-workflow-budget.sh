#!/usr/bin/env bash
# Unit-test runner for the token-budget-nudge logic in subagent/workflow-engine.ts.
# workflow-engine.ts is dependency-free, so like run-widget.sh this needs NO
# @earendil-works modules - it runs in a bare workspace. Copies the CURRENT
# workflow-engine.ts so nothing is cached.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$SCRIPT_DIR/../workflow-engine.ts" "$WORK/workflow-engine.ts"
cp "$SCRIPT_DIR/workflow-budget.test.mjs" "$WORK/workflow-budget.test.mjs"

cd "$WORK"
printf "testing %s\n" "$SCRIPT_DIR/../workflow-engine.ts"
node workflow-budget.test.mjs
