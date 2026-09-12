#!/usr/bin/env bash
# Unit-test runner for subagent/watchdog.ts (trigger/stalemate state machine).
# watchdog.ts is dependency-free, so like run-widget.sh this needs NO
# @earendil-works modules - it runs in a bare workspace. Copy CURRENT files
# so nothing is cached.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$SCRIPT_DIR/../watchdog.ts" "$WORK/watchdog.ts"
cp "$SCRIPT_DIR/watchdog.test.mjs" "$WORK/watchdog.test.mjs"

cd "$WORK"
printf "testing %s\n" "$SCRIPT_DIR/../watchdog.ts"
node watchdog.test.mjs
