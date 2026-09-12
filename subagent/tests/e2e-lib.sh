#!/usr/bin/env bash
# Shared helpers for the opt-in live E2E scripts (e2e-*.sh). Sourced, not
# executed directly.

# run_pi_retrying <pi_bin> <outfile> -- <pi args...>
#
# Runs pi once; if the output shows a known-transient, unrelated extension
# crash (observed live: session-memory's "ctx is stale after session
# replacement or reload" error killing the whole -p invocation before it
# even processes the prompt — a real bug in a different extension, not in
# subagent or in the test itself), retries exactly once. Writes combined
# stdout+stderr to outfile; returns pi's exit code from the LAST attempt.
run_pi_retrying() {
	pi_bin="$1"; outfile="$2"; shift 2
	"$pi_bin" "$@" >"$outfile" 2>&1
	status=$?
	if grep -q "ctx is stale after session replacement or reload" "$outfile" 2>/dev/null; then
		echo "  (transient unrelated-extension error detected, retrying once...)" >&2
		"$pi_bin" "$@" >"$outfile" 2>&1
		status=$?
	fi
	return $status
}

# Order run-store dirs under a store by startedAt (embedded as the runId's
# 2nd hyphen-delimited field: sg-<epochms>-<rand>) — split the BASENAME
# only, not the full path, since the store dir itself may contain hyphens
# (e.g. "subagents-scout-and-plan-slash") that would otherwise pollute the
# split.
ordered_run_dirs() {
	store="$1"
	for d in "$store"/sg-*/; do
		[ -d "$d" ] || continue
		base="$(basename "$d")"
		ts="$(echo "$base" | cut -d- -f2)"
		echo "$ts $d"
	done | sort -n | awk '{print $2}'
}
