#!/usr/bin/env bash
# Unit-test runner for subagent/timeout.ts (per-call vs frontmatter timeout
# resolution). timeout.ts is dependency-free, so like run-watchdog.sh this
# needs NO @earendil-works modules - it runs in a bare workspace. Copy CURRENT
# files so nothing is cached.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$SCRIPT_DIR/../timeout.ts" "$WORK/timeout.ts"
cp "$SCRIPT_DIR/timeout.test.mjs" "$WORK/timeout.test.mjs"

cd "$WORK"
printf "testing %s\n" "$SCRIPT_DIR/../timeout.ts"
node timeout.test.mjs
