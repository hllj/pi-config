#!/usr/bin/env bash
# Unit-test runner for subagent/expect.ts (structured-output "expect" contract).
# expect.ts imports typebox/value, so unlike run-widget.sh/run-watchdog.sh this
# needs typebox resolvable - symlink it in from the real pi-coding-agent
# install (same source `npm run setup` links into this repo's own
# node_modules). Copies CURRENT expect.ts so nothing is cached.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/../expect.ts"

if [ -z "$PI_MODULES_ROOT" ]; then
	PI_MODULES_ROOT="/opt/homebrew/lib/node_modules/@earendil-works"
fi

if [ ! -d "$PI_MODULES_ROOT/pi-coding-agent/node_modules/typebox" ]; then
	echo "ERROR: typebox not found under $PI_MODULES_ROOT/pi-coding-agent/node_modules"
	echo "Set PI_MODULES_ROOT to the @earendil-works directory containing pi-coding-agent."
	exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/node_modules"
ln -s "$PI_MODULES_ROOT/pi-coding-agent/node_modules/typebox" "$WORK/node_modules/typebox"

cp "$SOURCE" "$WORK/expect.ts"
cp "$SCRIPT_DIR/expect.test.mjs" "$WORK/expect.test.mjs"

cd "$WORK"
printf "testing %s\n" "$SOURCE"
node expect.test.mjs
