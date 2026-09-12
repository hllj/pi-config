/**
 * Watchdog — a live, in-session second-model review.
 *
 * Post-hoc review (dispatch `reviewer` manually after the fact) misses two
 * things pi-bench's own SWE-bench run surfaced: a *semantic* loop (varying
 * commands, same unproductive direction — e.g. chasing version tags across a
 * repo) that a literal tool-repeat guard doesn't catch, and config/scope
 * drift that only gets checked once, at the very end. The watchdog runs the
 * `reviewer` agent *during* the session, at natural boundaries, looking
 * specifically for those blind spots (see subagent/IMPROVEMENT-PLAN.md, Gap 1).
 *
 * Pure trigger/state-machine logic lives here (unit-tested, no I/O, no pi
 * dependency). The actual subagent dispatch (`runSingleAgent`) and
 * `pi.on`/`pi.registerCommand` wiring live in index.ts, which already owns
 * agent discovery and the run store.
 */

/** Tools that count as "the turn mutated the repo" — mirrors pi-bench's own definition. */
export const WATCHDOG_MUTATION_TOOLS = new Set(["edit", "write"]);

/* ------------------------------ trigger state ------------------------------ */

export interface WatchdogTriggerState {
	toolCallsSinceReview: number;
	mutatedSinceReview: boolean;
}

export function newWatchdogTriggerState(): WatchdogTriggerState {
	return { toolCallsSinceReview: 0, mutatedSinceReview: false };
}

/** Call once per observed tool call (e.g. from tool_execution_start). */
export function recordWatchdogTool(
	state: WatchdogTriggerState,
	toolName: string,
): void {
	state.toolCallsSinceReview++;
	if (WATCHDOG_MUTATION_TOOLS.has(toolName)) state.mutatedSinceReview = true;
}

/**
 * Decide whether to run a watchdog review at turn_end. A turn that mutated
 * the repo triggers immediately (boundary trigger); otherwise a cadence
 * trigger fires every `cadence` tool calls (floor 5) to catch unproductive
 * read-only streaks between edits. Caller must call
 * resetWatchdogTriggerState() after a review actually runs.
 */
export function shouldRunWatchdog(
	state: WatchdogTriggerState,
	cadence = 8,
): boolean {
	if (state.mutatedSinceReview) return true;
	return state.toolCallsSinceReview >= Math.max(5, cadence);
}

export function resetWatchdogTriggerState(state: WatchdogTriggerState): void {
	state.toolCallsSinceReview = 0;
	state.mutatedSinceReview = false;
}

/* ------------------------------ findings ------------------------------ */

export type WatchdogSeverity = "high" | "medium" | "low";
export type WatchdogCategory =
	| "correctness"
	| "test-gap"
	| "loop-risk"
	| "scope-drift"
	| "unsafe-change";

export interface WatchdogFinding {
	severity: WatchdogSeverity;
	category: WatchdogCategory;
	evidence: string;
	recommendedAction: string;
}

/** Narrow, defensive parse of the reviewer's structured output — never throws. */
export function parseWatchdogFindings(structuredOutput: unknown): WatchdogFinding[] {
	if (!structuredOutput || typeof structuredOutput !== "object") return [];
	const findings = (structuredOutput as { findings?: unknown }).findings;
	if (!Array.isArray(findings)) return [];
	const out: WatchdogFinding[] = [];
	for (const f of findings) {
		if (!f || typeof f !== "object") continue;
		const { severity, category, evidence, recommendedAction } = f as Record<string, unknown>;
		if (
			typeof severity === "string" &&
			typeof category === "string" &&
			typeof evidence === "string" &&
			typeof recommendedAction === "string"
		) {
			out.push({
				severity: severity as WatchdogSeverity,
				category: category as WatchdogCategory,
				evidence,
				recommendedAction,
			});
		}
	}
	return out;
}

export function buildWatchdogReviewTask(cwd: string): string {
	return [
		"You are running as an automatic in-session watchdog — a fast, narrow safety-net pass, NOT a full code review.",
		`Run \`git diff\` (and \`git status\`/\`git log -3\` if useful) in ${cwd} to see the most recent uncommitted change and recent history.`,
		"Look ONLY for these five categories:",
		"1. correctness - a concrete bug the diff introduces.",
		"2. test-gap - new/changed logic with no corresponding test.",
		"3. loop-risk - signs recent work is going in unproductive circles (e.g. edits reverting each other, the same files explored repeatedly with no forward progress, chasing something across unrelated versions/tags).",
		"4. scope-drift - changes unrelated to what the commit/diff context suggests was actually asked.",
		"5. unsafe-change - a deletion, rename, or config/dependency-pin edit made without checking what references it or why it's there.",
		"If nothing genuinely fits one of these five categories, return an EMPTY findings array. Do not invent minor style nits or restate the reviewer agent's normal Critical/Warning format - this call only wants the JSON output contract.",
	].join("\n");
}

export function formatWatchdogSteer(findings: WatchdogFinding[]): string {
	const lines = findings.map(
		(f) => `- [${f.severity}/${f.category}] ${f.evidence} -> ${f.recommendedAction}`,
	);
	return [
		"Watchdog (automatic in-session review) flagged something:",
		...lines,
		"This is advisory, event-driven, and never blocks - use judgment on whether/when to act. Disable with /watchdog.",
	].join("\n");
}

/* ------------------------------ stalemate detection ------------------------------ */

export interface WatchdogStalemateState {
	lastHash: string | null;
	streak: number;
}

export function newWatchdogStalemateState(): WatchdogStalemateState {
	return { lastHash: null, streak: 0 };
}

/** Order/whitespace-insensitive fingerprint of a finding set for repeat detection. */
export function hashWatchdogFindings(findings: WatchdogFinding[]): string {
	return findings
		.map((f) => `${f.category}|${f.evidence}`.trim().toLowerCase())
		.sort()
		.join("\n");
}

/**
 * Track repeated identical finding sets across dispatched reviews. Returns
 * true when the current findings should be SUPPRESSED (already nagged about
 * `threshold` times in a row) rather than steered again. An empty findings
 * set always resets the streak and is never itself suppressed (there's
 * nothing to nag about).
 */
export function trackWatchdogStalemate(
	state: WatchdogStalemateState,
	hash: string,
	threshold = 3,
): boolean {
	if (hash === "") {
		state.lastHash = null;
		state.streak = 0;
		return false;
	}
	if (hash === state.lastHash) {
		state.streak++;
	} else {
		state.lastHash = hash;
		state.streak = 1;
	}
	return state.streak > threshold;
}
