#!/usr/bin/env bash
#
# verify-setup.sh — confirm a personal pi-config installation is fully wired:
# the extensions symlink, the per-file agents/prompts/skills symlinks and the
# AGENTS.md fetch from setup-agent-links.sh, the node_modules type-checking
# symlinks from setup-links.sh, and — by default — that every single extension
# in the repo actually loads under the real, installed `pi`. Read-only — never
# creates or modifies anything in the repo or in $AGENT_DIR.
#
# Usage: bash scripts/verify-setup.sh [--fast] [--live]
#   --fast   skip the per-extension load check (structural checks only; fast,
#            no `pi` subprocesses spawned).
#   --live   also spawn one real, non-interactive `pi --print` turn against
#            the full pack (not isolated) to confirm an actual model turn
#            completes end-to-end. Costs a small amount of real tokens
#            against your configured provider, so it's opt-in.
#
# The per-extension load check (default, not --fast) is free: it spawns each
# extension alone (`pi --no-extensions -e <file>`) against a disposable,
# auth-less agent dir. pi fails extension discovery *before* ever resolving a
# model or making a network call, so "no 'Failed to load extension' error" is
# a reliable, zero-cost, zero-token signal that the extension loaded — every
# run here reliably stops at "No API key found" instead, never at a real
# completion.
#
set -uo pipefail

cd "$(dirname "$0")/.." # repo root
ROOT="$(pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

FAST=0
LIVE=0
for arg in "$@"; do
	case "$arg" in
	--fast) FAST=1 ;;
	--live) LIVE=1 ;;
	*)
		echo "verify-setup.sh: unknown argument: $arg" >&2
		exit 2
		;;
	esac
done

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

echo "== global operating manual (not repo-managed) =="
AGENTS_MD="$AGENT_DIR/AGENTS.md"
if [ -s "$AGENTS_MD" ]; then
	ok "AGENTS.md present at $AGENTS_MD"
else
	bad "$AGENTS_MD missing or empty — run 'npm run setup:agent' to fetch it, or create it yourself"
fi

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

if [ "$FAST" -ne 1 ]; then
	echo "== every extension loads (isolated, no auth/tokens needed) =="
	SCRATCH_AGENT_DIR="$(mktemp -d)"
	trap 'rm -rf "$SCRATCH_AGENT_DIR"' EXIT

	# The two shapes pi auto-discovers: a root-level *.ts file, or a */index.ts
	# bundled extension one directory down. Discovered dynamically (not a
	# hardcoded list) so this stays correct as extensions are added or removed.
	list_extensions() {
		find "$ROOT" -maxdepth 1 -type f -iname "*.ts"
		find "$ROOT" -mindepth 2 -maxdepth 2 -type f -iname "index.ts" \
			-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.claude/*"
	}

	while IFS= read -r ext; do
		[ -n "$ext" ] || continue
		rel="${ext#"$ROOT"/}"
		OUT="$(PI_CODING_AGENT_DIR="$SCRATCH_AGENT_DIR" pi --no-extensions -e "$ext" --print --no-session "hi" </dev/null 2>&1)"
		if echo "$OUT" | grep -q "Failed to load extension"; then
			REASON="$(echo "$OUT" | grep "Failed to load extension" | head -1 | sed -E 's/\x1b\[[0-9;]*m//g')"
			bad "$rel — $REASON"
		else
			ok "$rel"
		fi
	done < <(list_extensions | sort)
fi

if [ "$LIVE" -eq 1 ]; then
	echo "== live pi smoke test (full pack, real completion) =="
	# A throwaway --session-id, not --no-session: session-memory's session_shutdown
	# hook currently throws on --no-session's ephemeral session teardown (a real,
	# separate bug — see the extension's own issue tracker, not a setup problem).
	# A real, persisted session exercises the same "does a full turn complete"
	# property without tripping that unrelated edge case. Deleted below either way.
	LIVE_SESSION_ID="pi-config-verify-$$-$(date +%s)"
	OUT="$(cd "$ROOT" && pi --print --session-id "$LIVE_SESSION_ID" "Reply with exactly: PI_CONFIG_OK" 2>&1)" || true
	find "$AGENT_DIR/sessions" -type f -iname "*$LIVE_SESSION_ID*" -exec rm -f {} + 2>/dev/null || true
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
