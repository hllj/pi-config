#!/usr/bin/env bash
#
# setup-agent-links.sh — wire this repo into a local pi installation as the
# global extensions pack, plus per-file symlinks for the pieces pi's own
# discovery loads from fixed subdirectories of the agent dir rather than from
# the extensions dir itself:
#
#   ~/.pi/agent/extensions   -> this repo               (whole-dir symlink)
#   ~/.pi/agent/agents/*.md  -> subagent/agents/*.md     (per-file symlinks)
#   ~/.pi/agent/prompts/*.md -> subagent/prompts/*.md    (per-file symlinks)
#   ~/.pi/agent/skills/*     -> skills/*                 (per-dir symlinks)
#   ~/.pi/agent/AGENTS.md    -> fetched once from the operating-manual gist
#   npm:pi-lens              -> installed via `pi install` (settings.json)
#
# Without the middle three, pi's agent/prompt-template/skill loaders (which
# read straight from <agent dir>/{agents,prompts,skills}, never from the
# extensions dir) won't see anything this repo ships there — the extensions
# symlink alone only covers *.ts extension discovery.
#
# AGENTS.md is different: it's personal, machine-specific, not part of this
# repo, and meant to be hand-edited after the first fetch — so it's a
# plain copy, fetched only if the file doesn't already exist. Re-run with it
# already present and this script leaves it alone.
#
# Safe to re-run: every link is created idempotently. A target path that
# already exists but isn't a symlink we manage is left untouched with a
# warning instead of being clobbered (e.g. a personal, non-repo agent file
# living alongside the repo's own).
#
# NOT safe to run from a second checkout of this same repo while $AGENT_DIR
# is already wired to a different one (another clone, a worktree, a stale
# path) — so this script refuses outright rather than guessing. Without that
# guard, the per-file agents/prompts/skills symlinks (which have no natural
# "does this belong to the same checkout as extensions?" check of their own)
# would silently get repointed at whichever checkout happened to run last,
# corrupting the canonical one.
#
set -euo pipefail

cd "$(dirname "$0")/.." # repo root
ROOT="$(pwd)"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
AGENTS_MD_GIST_URL="${PI_AGENTS_MD_GIST_URL:-https://gist.githubusercontent.com/hllj/d716e5e0aa34d4971cef7fa459b2cffc/raw/AGENTS.md}"

info() { echo "  $*"; }
warn() { echo "  warning: $*" >&2; }

mkdir -p "$AGENT_DIR"

# --- extensions dir: whole-repo symlink -------------------------------------
# Everything after this point assumes $AGENT_DIR belongs to *this* checkout
# ($ROOT). If extensions already points somewhere else, stop here instead of
# proceeding to repoint the shared per-file agents/prompts/skills symlinks at
# the wrong checkout.
EXT_LINK="$AGENT_DIR/extensions"
if [ -L "$EXT_LINK" ] && [ "$(readlink "$EXT_LINK")" = "$ROOT" ]; then
	info "extensions -> $ROOT (already linked)"
elif [ -e "$EXT_LINK" ]; then
	echo "error: $EXT_LINK exists and does not point at $ROOT (got: $(readlink "$EXT_LINK" 2>/dev/null || echo '<not a symlink>'))." >&2
	echo "       Refusing to touch agents/prompts/skills too — this agent dir looks like it belongs" >&2
	echo "       to a different pi-config checkout. Remove $EXT_LINK first if $ROOT should own it," >&2
	echo "       or re-run this script from the checkout it already points at." >&2
	exit 1
else
	ln -s "$ROOT" "$EXT_LINK"
	info "extensions -> $ROOT (linked)"
fi

# --- per-entry symlinks for a source dir into a dest dir --------------------
link_dir_contents() {
	local src_dir="$1" dest_dir="$2" label="$3"
	mkdir -p "$dest_dir"
	local f name target linked=0 skipped=0
	for f in "$src_dir"/*; do
		[ -e "$f" ] || continue
		name="$(basename "$f")"
		target="$dest_dir/$name"
		if [ -L "$target" ] && [ "$(readlink "$target")" = "$f" ]; then
			linked=$((linked + 1))
			continue
		fi
		if [ -e "$target" ] && [ ! -L "$target" ]; then
			warn "$label/$name exists and isn't a symlink — leaving it alone"
			skipped=$((skipped + 1))
			continue
		fi
		# missing, or a stale symlink pointing elsewhere — safe to (re)create
		rm -f "$target"
		ln -s "$f" "$target"
		linked=$((linked + 1))
	done
	if [ "$skipped" -gt 0 ]; then
		info "$label: $linked linked, $skipped skipped"
	else
		info "$label: $linked linked"
	fi
}

link_dir_contents "$ROOT/subagent/agents" "$AGENT_DIR/agents" "agents"
link_dir_contents "$ROOT/subagent/prompts" "$AGENT_DIR/prompts" "prompts"
link_dir_contents "$ROOT/skills" "$AGENT_DIR/skills" "skills"

# --- global operating manual: fetch once, never overwrite -------------------
AGENTS_MD="$AGENT_DIR/AGENTS.md"
if [ -e "$AGENTS_MD" ]; then
	info "AGENTS.md already present (not repo-managed — edit it directly, or the gist, to update)"
elif curl -fsSL "$AGENTS_MD_GIST_URL" -o "$AGENTS_MD" 2>/dev/null; then
	info "AGENTS.md fetched -> $AGENTS_MD (edit it locally; re-running this script won't overwrite it)"
else
	rm -f "$AGENTS_MD" # remove a possible empty file left by a failed curl
	warn "could not fetch AGENTS.md from $AGENTS_MD_GIST_URL (offline?) — create $AGENTS_MD yourself when ready"
fi

# --- companion package: pi-lens ---------------------------------------------
# Not part of this repo — a separate `pi` package (LSP/lint/type-check
# diagnostics) that verify-guard.ts optionally recognizes: a `lens_diagnostics`
# tool call counts as verification alongside run_test/lsp_diagnostics. `pi
# install` is pi's own package manager — idempotent (no-ops once installed)
# and merges into settings.json without touching any other field, so it's
# safe to call unconditionally rather than hand-editing JSON ourselves.
PI_LENS_PKG="npm:pi-lens"
if PI_CODING_AGENT_DIR="$AGENT_DIR" pi list 2>/dev/null | grep -q "$PI_LENS_PKG"; then
	info "$PI_LENS_PKG already installed"
elif PI_CODING_AGENT_DIR="$AGENT_DIR" pi install "$PI_LENS_PKG" >/dev/null 2>&1; then
	info "$PI_LENS_PKG installed"
else
	warn "could not install $PI_LENS_PKG (offline?) — run 'pi install $PI_LENS_PKG' yourself when ready"
fi

echo "Done. Run 'npm run verify' to confirm the full setup."
