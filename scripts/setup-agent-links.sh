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
#
# Without the last three, pi's agent/prompt-template/skill loaders (which read
# straight from <agent dir>/{agents,prompts,skills}, never from the extensions
# dir) won't see anything this repo ships there — the extensions symlink alone
# only covers *.ts extension discovery.
#
# Safe to re-run: every link is created idempotently. A target path that
# already exists but isn't a symlink we manage is left untouched with a
# warning instead of being clobbered (e.g. a personal, non-repo agent file
# living alongside the repo's own).
#
set -euo pipefail

cd "$(dirname "$0")/.." # repo root
ROOT="$(pwd)"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

info() { echo "  $*"; }
warn() { echo "  warning: $*" >&2; }

mkdir -p "$AGENT_DIR"

# --- extensions dir: whole-repo symlink -------------------------------------
EXT_LINK="$AGENT_DIR/extensions"
if [ -L "$EXT_LINK" ] && [ "$(readlink "$EXT_LINK")" = "$ROOT" ]; then
	info "extensions -> $ROOT (already linked)"
elif [ -e "$EXT_LINK" ]; then
	warn "$EXT_LINK exists and isn't a symlink to $ROOT — leaving it alone (remove it and re-run to let pi-config own it)"
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

echo "Done. Run 'npm run verify' to confirm the full setup."
