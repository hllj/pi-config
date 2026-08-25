#!/usr/bin/env bash
# Unit-test runner for subagent/workflow-widget.ts (the live workflow TUI widget
# template rendering). workflow-widget.ts is dependency-free (only a type-only
# import of workflow-engine.ts), so unlike run-unit.sh this needs NO @earendil-works
# modules — it runs in a bare workspace. Copy CURRENT files so nothing is cached.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$SCRIPT_DIR/../workflow-widget.ts" "$WORK/workflow-widget.ts"
cp "$SCRIPT_DIR/../workflow-engine.ts" "$WORK/workflow-engine.ts"
cp "$SCRIPT_DIR/workflow-widget.test.mjs" "$WORK/workflow-widget.test.mjs"

cd "$WORK"
printf "testing %s\n" "$SCRIPT_DIR/../workflow-widget.ts"
node workflow-widget.test.mjs