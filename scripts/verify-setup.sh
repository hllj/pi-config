#!/usr/bin/env bash
#
# verify-setup.sh — confirm a personal pi-config installation is fully wired:
# the extensions symlink, the per-file agents/prompts/skills symlinks from
# setup-agent-links.sh, and the node_modules type-checking symlinks from
# setup-links.sh. Read-only — never creates or modifies anything.
#
# Usage: bash scripts/verify-setup.sh [--live]
#   --live   also spawn one real, non-interactive `pi --print` turn to confirm
#            the extension pack loads cleanly end-to-end. Costs a small amount
#            of real tokens against your configured provider, so it's opt-in.
#
set -uo pipefail

cd "$(dirname "$0")/.." # repo root
ROOT="$(pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

PASS=0
FAIL=0

ok() {
	echo "  [ok] $*"
	PASS=$((PASS + 1))
}
bad() {
	echo "  [FAIL] $*" >&2
	FAIL=$((FAIL + 1))
}

echo "== pi on PATH =="
if command -v pi >/dev/null 2>&1; then
	ok "pi -> $(command -v pi) ($(pi --version 2>/dev/null || echo unknown))"
else
	bad "'pi' not found on PATH"
fi

echo "== extensions symlink =="
EXT_LINK="$AGENT_DIR/extensions"
if [ -L "$EXT_LINK" ] && [ "$(readlink "$EXT_LINK")" = "$ROOT" ]; then
	ok "extensions -> $ROOT"
else
	bad "$EXT_LINK does not point at $ROOT (got: $(readlink "$EXT_LINK" 2>/dev/null || echo '<missing>')) — run 'npm run setup:agent'"
fi

check_dir_links() {
	local src_dir="$1" dest_dir="$2" label="$3"
	local f name target found=0
	for f in "$src_dir"/*; do
		[ -e "$f" ] || continue
		found=1
		name="$(basename "$f")"
		target="$dest_dir/$name"
		if [ -L "$target" ] && [ "$(readlink "$target")" = "$f" ]; then
			ok "$label/$name"
		else
			bad "$label/$name missing or not linked to $f — run 'npm run setup:agent'"
		fi
	done
	if [ "$found" -eq 0 ]; then
		ok "$label: nothing to link (source dir empty)"
	fi
}

echo "== agent definitions (subagent/agents -> $AGENT_DIR/agents) =="
check_dir_links "$ROOT/subagent/agents" "$AGENT_DIR/agents" "agents"

echo "== bundled prompts (subagent/prompts -> $AGENT_DIR/prompts) =="
check_dir_links "$ROOT/subagent/prompts" "$AGENT_DIR/prompts" "prompts"

echo "== skills (skills/ -> $AGENT_DIR/skills) =="
check_dir_links "$ROOT/skills" "$AGENT_DIR/skills" "skills"

echo "== node_modules type-checking symlinks =="
for pair in \
	"node_modules/@earendil-works/pi-coding-agent" \
	"node_modules/@earendil-works/pi-ai" \
	"node_modules/@earendil-works/pi-tui" \
	"node_modules/@earendil-works/pi-agent-core" \
	"node_modules/typebox" \
	"node_modules/@types/node"; do
	if [ -L "$ROOT/$pair" ] && [ -e "$ROOT/$pair" ]; then
		ok "$pair"
	else
		bad "$pair missing or broken — run 'npm run setup'"
	fi
done

if [ "${1:-}" = "--live" ]; then
	echo "== live pi smoke test =="
	OUT="$(cd "$ROOT" && pi --print --no-session "Reply with exactly: PI_CONFIG_OK" 2>&1)" || true
	if echo "$OUT" | grep -q "PI_CONFIG_OK"; then
		ok "pi --print completed and loaded the extension pack without error"
	else
		bad "pi --print did not return the expected reply — output:"
		echo "$OUT" | sed 's/^/    /' >&2
	fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
	echo "All $PASS checks passed."
	exit 0
else
	echo "$FAIL check(s) failed, $PASS passed."
	exit 1
fi
