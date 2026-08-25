#!/usr/bin/env bash
#
# setup-links.sh — create local type-checking symlinks into the globally
# installed pi package.
#
# The extensions import from @earendil-works/{pi-coding-agent, pi-ai, pi-tui,
# pi-agent-core} plus typebox and need @types/node. Rather than `npm install`
# a parallel copy of the whole pi dependency tree (which can drift from the
# exact version pi actually runs), we symlink straight into the global install
# that `pi` resolves at runtime. This guarantees TypeScript checks against the
# exact type surface pi uses.
#
# node_modules/ is gitignored, so on a fresh clone just run `npm run setup`
# (after `npm install` to fetch the typescript devDependency).
#
set -euo pipefail

cd "$(dirname "$0")/.." # repo root
ROOT="$(pwd)"

# Locate the real pi package root (resolves the `pi` symlink chain).
PI_BIN="$(command -v pi || true)"
if [ -z "$PI_BIN" ]; then
	echo "error: 'pi' not found on PATH. Install pi first, then re-run npm run setup." >&2
	exit 1
fi
REAL_BIN="$(readlink -f "$PI_BIN")"
# $REAL_BIN = <pkgroot>/dist/bundle/cli.js  ->  pkgroot is 3 dirs up
PKGROOT="$(dirname "$(dirname "$(dirname "$REAL_BIN")")")"

# The pi package hoists its runtime deps under its own node_modules.
NESTED="$PKGROOT/node_modules"
if [ ! -d "$NESTED/@earendil-works/pi-ai" ] || [ ! -d "$NESTED/typebox" ] || [ ! -d "$NESTED/@types/node" ]; then
	echo "error: unexpected pi layout — expected deps under: $NESTED" >&2
	exit 1
fi

NM="$ROOT/node_modules"
mkdir -p "$NM/@earendil-works" "$NM/@types"

link() {
	local target="$1"
	local name="$2"
	rm -rf "$name"
	ln -s "$target" "$name"
}

link "$PKGROOT" "$NM/@earendil-works/pi-coding-agent"
link "$NESTED/@earendil-works/pi-ai" "$NM/@earendil-works/pi-ai"
link "$NESTED/@earendil-works/pi-tui" "$NM/@earendil-works/pi-tui"
link "$NESTED/@earendil-works/pi-agent-core" "$NM/@earendil-works/pi-agent-core"
link "$NESTED/typebox" "$NM/typebox"
link "$NESTED/@types/node" "$NM/@types/node"

echo "Linked types from $PKGROOT"
echo "  pi-coding-agent @ $(node -e "console.log(require('$PKGROOT/package.json').version)")"
echo "  pi-ai          @ $(node -e "console.log(require('$NESTED/@earendil-works/pi-ai/package.json').version)")"
echo "  typebox        @ $(node -e "console.log(require('$NESTED/typebox/package.json').version)")"
echo "Done."
