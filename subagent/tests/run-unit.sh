#!/usr/bin/env bash
# Reusable unit-test runner for the subagent run-store module.
#
# Builds a throwaway workspace with the @earendil-works modules resolvable,
# copies the CURRENT session-store.ts, and runs unit.test.mjs against it.
# Always tests the latest source — nothing cached.
#
# Usage:
#   ./run-unit.sh                # run (needs Node >= 22; type-stripping)
#   PI_MODULES_ROOT=/path ./run-unit.sh   # override module install root
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/../session-store.ts"

# Real pi-coding-agent install. Overridable; default matches the standard
# Homebrew npm-global layout.
if [ -z "$PI_MODULES_ROOT" ]; then
	PI_MODULES_ROOT="/opt/homebrew/lib/node_modules/@earendil-works"
fi

if [ ! -f "$PI_MODULES_ROOT/pi-coding-agent/dist/index.js" ]; then
	echo "ERROR: pi-coding-agent not found under $PI_MODULES_ROOT"
	echo "Set PI_MODULES_ROOT to the @earendil-works directory containing pi-coding-agent."
	exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/node_modules/@earendil-works"

# pi-coding-agent transitively provides the @earendil-works/* submodules
# (pi-ai, pi-agent-core, pi-tui, ...). Symlink it in so pi-coding-agent's own
# internal resolution and the top-level re-export both work.
ln -s "$PI_MODULES_ROOT/pi-coding-agent" "$WORK/node_modules/@earendil-works/pi-coding-agent"
# session-store.ts has `import type { Message } from "@earendil-works/pi-ai"` —
# a type-only import erased by Node's type-stripping, but link it anyway for
# tools that typecheck rather than strip.
if [ -d "$PI_MODULES_ROOT/pi-ai" ]; then
	ln -s "$PI_MODULES_ROOT/pi-ai" "$WORK/node_modules/@earendil-works/pi-ai"
fi

cp "$SOURCE" "$WORK/session-store.ts"
cp "$SCRIPT_DIR/unit.test.mjs" "$WORK/unit.test.mjs"

cd "$WORK"
printf "testing %s\n" "$SOURCE"
node unit.test.mjs