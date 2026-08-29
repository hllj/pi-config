/**
 * Failure-learning — pure logic (no file I/O).
 *
 * The "self-evolving" core of the learning extension: failures captured from
 * tool executions and subagent runs are fingerprinted, merged into one record
 * per distinct failure *pattern*, and analyzed so a repeat across sessions
 * promotes a pattern to a skill recommendation.
 *
 * Kept free of `ExtensionAPI`/filesystem so it can be unit-tested directly
 * (`node learning/failure-store.test.ts`); `index.ts` owns storage and wiring.
 */

import { createHash } from "node:crypto";

/* ------------------------------- types -------------------------------- */

export type FailureKind = "tool" | "subagent";

/** Dev-workflow types a recurring failure can be mapped to (R3). */
export type WorkflowHint = "swat" | "bugfix" | "refactor" | "explore";

export type FailureStatus =
	| "new" // first seen; documented in the report
	| "recommended" // repeated across sessions; a skill is worth creating
	| "skill-created" // a skill now exists for this pattern (terminal)
	| "resolved" // no longer a problem (terminal)
	| "false-positive"; // not a real recurring failure (terminal);

/** A bounded snapshot of what was happening when a failure occurred. */
export interface TraceSnapshot {
	at: number;
	sessionId: string;
	lines: string[];
}

/** One record per distinct failure pattern (fingerprint). */
export interface FailurePattern {
	fingerprint: string;
	kind: FailureKind;
	/** Tool name for tool failures, agent name for subagent failures. */
	source: string;
	/** Normalized one-line error message (lowercased, numbers/paths scrubbed). */
	message: string;
	/** Original first error line, truncated — for humans. */
	detail: string;
	/** Working directory where the failure was recorded. */
	cwd: string;
	/** Total times this fingerprint was observed. */
	occurrences: number;
	/** Distinct sessions that hit this pattern (retry loops count once). */
	sessions: string[];
	/** Most recent traces, capped; identical traces are deduped. */
	traces: TraceSnapshot[];
	firstSeenAt: number;
	lastSeenAt: number;
	/** Subagent run id when this came from the run store (informational, last seen). */
	runId?: string;
	/** All subagent run ids already ingested for this pattern (ingest dedupe key). */
	runIds?: string[];
	status: FailureStatus;
	/** Skill name when status === "skill-created". */
	skillName?: string;
	/** When the pattern was closed as skill-created/resolved (resolution capture). */
	resolvedAt?: number;
	/** Optional human note on how the pattern was resolved (from `learn mark`). */
	resolution?: string;
	/**
	 * Suggested dev workflow when this pattern recurs (stamped at /learn
	 * promotion from `suggestWorkflow`; data-driven by kind/source, not text).
	 */
	workflow?: WorkflowHint;
}

/** A single observed failure event fed to the store. */
export interface OccurrenceInput {
	kind: FailureKind;
	source: string;
	/** Original error text (first line is used for the fingerprint). */
	detail: string;
	/** Context lines leading up to the failure (bounded at merge time). */
	trace: string[];
	cwd: string;
	sessionId: string;
	at: number;
	/** Subagent run id — when set, re-ingesting the same run is a no-op. */
	runId?: string;
}

/** A failure pattern with computed repeat/session counters. */
export interface PatternAnalysis {
	pattern: FailurePattern;
	sessions: number;
	occurrences: number;
	/** True when this pattern is a skill candidate (repeat + not terminal). */
	repeat: boolean;
}

export interface StoreShape {
	meta: {
		/** Repeat threshold in distinct sessions (default DEFAULT_THRESHOLD). */
		threshold?: number;
		updatedAt?: number;
	};
	failures: FailurePattern[];
}

/* ------------------------------ constants ----------------------------- */

export const DEFAULT_THRESHOLD = 2; // appears in >= 2 sessions → recommend skill
export const MAX_TRACE_LINES = 8;
export const MAX_TRACE_CHARS = 160;
export const MAX_TRACES = 3;
export const MAX_PATTERNS = 1000;
export const MAX_MESSAGE_CHARS = 120;
export const MAX_DETAIL_CHARS = 200;

/** Statuses that stop a pattern from being re-recommended. */
export const TERMINAL_STATUSES: readonly FailureStatus[] = [
	"skill-created",
	"resolved",
	"false-positive",
];

/* ------------------------------ helpers ------------------------------- */

export function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

export function firstLine(s: string): string {
	const idx = s.indexOf("\n");
	return idx === -1 ? s : s.slice(0, idx);
}

/** One-line timestamp, e.g. "2026-08-28 15:04". */
export function iso(at: number): string {
	return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function slugify(x: string): string {
	return x
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Normalize an error message so the same underlying problem maps to the same
 * fingerprint: lowercase, scrub timestamps / hex / absolute paths / bare
 * numbers (line numbers, ports, exit codes), collapse whitespace, truncate.
 */
export function normalizeMessage(msg: string): string {
	return truncate(
		msg
			.toLowerCase()
			.replace(/0x[0-9a-f]{4,}/g, "<hex>")
			.replace(/\/[^\s"']*\/([^\s/]+)/g, "<path>/$1")
			.replace(/\b\d{4}[-/]\d{2}[-/]\d{2}[t ]\d{2}:\d{2}(:\d{2})?\b/g, "<ts>")
			.replace(/\b\d+\b/g, "<n>")
			.replace(/\s+/g, " ")
			.trim(),
		MAX_MESSAGE_CHARS,
	);
}

export function fingerprintKey(input: {
	kind: FailureKind;
	source: string;
	message: string;
}): string {
	return `${input.kind}|${input.source}|${normalizeMessage(input.message)}`;
}

export function fingerprint(input: {
	kind: FailureKind;
	source: string;
	message: string;
}): string {
	return createHash("sha1")
		.update(fingerprintKey(input))
		.digest("hex")
		.slice(0, 16);
}

/** Keep recent snapshots, dropping any identical to a newer one. */
function dedupeTraces(
	traces: TraceSnapshot[],
	snapshot: TraceSnapshot,
	cap: number,
): TraceSnapshot[] {
	const key = snapshot.lines.join("\n");
	const others = traces.filter((t) => t.lines.join("\n") !== key);
	return [...others, snapshot].slice(-cap);
}

function dropOldest(patterns: FailurePattern[]): FailurePattern[] {
	return patterns
		.slice()
		.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
		.slice(1);
}

/* ------------------------------- merge -------------------------------- */

/**
 * Merge a failure occurrence into the pattern list, returning a NEW array (and
 * new pattern object when anything changed). No-op when the occurrence's
 * subagent runId was already ingested.
 */
export function mergeOccurrence(
	patterns: FailurePattern[],
	occ: OccurrenceInput,
): FailurePattern[] {
	const fp = fingerprint({
		kind: occ.kind,
		source: occ.source,
		message: occ.detail,
	});
	const idx = patterns.findIndex((p) => p.fingerprint === fp);
	const existing = idx >= 0 ? patterns[idx] : undefined;

	// Subagent runs are keyed by runId — re-ingesting an already-seen run is a
	// no-op so repeated /learn scans never inflate counts.
	if (occ.runId) {
		const seen = existing?.runIds ?? [];
		if (existing && seen.includes(occ.runId)) return patterns;
	}

	const snapshot: TraceSnapshot = {
		at: occ.at,
		sessionId: occ.sessionId,
		lines: occ.trace
			.map((l) => truncate(l, MAX_TRACE_CHARS))
			.filter(Boolean)
			.slice(-MAX_TRACE_LINES),
	};

	if (!existing) {
		const next = [
			...patterns,
			{
				fingerprint: fp,
				kind: occ.kind,
				source: occ.source,
				message: normalizeMessage(occ.detail || occ.source),
				detail: truncate(firstLine(occ.detail), MAX_DETAIL_CHARS),
				cwd: occ.cwd,
				occurrences: 1,
				sessions: [occ.sessionId],
				traces: [snapshot],
				firstSeenAt: occ.at,
				lastSeenAt: occ.at,
				runId: occ.runId,
				runIds: occ.runId ? [occ.runId] : undefined,
				status: "new" as const,
			},
		];
		return next.length > MAX_PATTERNS ? dropOldest(next) : next;
	}

	const updated: FailurePattern = {
		...existing,
		occurrences: existing.occurrences + 1,
		sessions: existing.sessions.includes(occ.sessionId)
			? existing.sessions
			: [...existing.sessions, occ.sessionId],
		traces: dedupeTraces(existing.traces, snapshot, MAX_TRACES),
		lastSeenAt: occ.at,
		runId: occ.runId ?? existing.runId,
		runIds: occ.runId
			? [...(existing.runIds ?? []), occ.runId].slice(-50)
			: existing.runIds,
	};
	const next = patterns.slice();
	next[idx] = updated;
	return next;
}

/* ------------------------------ analysis ------------------------------ */

/**
 * Classify patterns: repeat is true when the pattern appeared in >= threshold
 * distinct sessions and is not already terminal (skill-created / resolved /
 * false-positive). Sorted: repeat candidates first, then by session count,
 * then recency.
 */
export function analyze(
	patterns: FailurePattern[],
	threshold: number,
): PatternAnalysis[] {
	return patterns
		.map((p) => {
			const sessions = p.sessions.length;
			return {
				pattern: p,
				sessions,
				occurrences: p.occurrences,
				repeat: sessions >= threshold && !TERMINAL_STATUSES.includes(p.status),
			};
		})
		.sort(
			(a, b) =>
				Number(b.repeat) - Number(a.repeat) ||
				b.sessions - a.sessions ||
				b.pattern.lastSeenAt - a.pattern.lastSeenAt,
		);
}

/**
 * Map a failure pattern to a suggested dev workflow type, or null.
 *
 * Data-driven by kind/source only — never inspects message text (the
 * keyword-detection heuristic was removed).
 *   - failed subagent runs → bugfix (delegated work usually failed on a bug)
 *   - run_test tool failures → bugfix (failing test expresses the bug)
 *   - everything else → null (no suggestion; leave the choice to the model)
 */
export function suggestWorkflow(p: {
	kind: FailureKind;
	source: string;
}): WorkflowHint | null {
	if (p.kind === "subagent") return "bugfix";
	if (p.source === "run_test") return "bugfix";
	return null;
}

/** Pure stamp: attach a workflow hint to a fingerprint, return a new array. */
export function stampWorkflow(
	patterns: FailurePattern[],
	fp: string,
	workflow: WorkflowHint,
): FailurePattern[] {
	const idx = patterns.findIndex((p) => p.fingerprint === fp);
	if (idx === -1) return patterns;
	const next = patterns.slice();
	next[idx] = { ...patterns[idx], workflow };
	return next;
}

/** A stored pattern that is a repeat candidate, with a workflow hint. */
export interface RepeatHit {
	pattern: FailurePattern;
	/** Suggested workflow (stamped or derived); may be null. */
	workflow: WorkflowHint | null;
}

/**
 * Pure lookup: does this fingerprint exist in the store AND qualify as a
 * repeat candidate (>= threshold sessions, non-terminal)? Used by the
 * dev-workflows auto-nudge to turn recurring failures into workflow hints.
 */
export function lookupRepeat(
	patterns: FailurePattern[],
	kind: FailureKind,
	source: string,
	detail: string,
	threshold: number = DEFAULT_THRESHOLD,
): RepeatHit | null {
	const fp = fingerprint({ kind, source, message: detail });
	const p = patterns.find((f) => f.fingerprint === fp);
	if (!p) return null;
	const sessions = p.sessions.length;
	if (sessions < threshold || TERMINAL_STATUSES.includes(p.status)) return null;
	return {
		pattern: p,
		workflow: p.workflow ?? suggestWorkflow(p),
	};
}

/**
 * Pure status update: mark a fingerprint and return a new array. When the new
 * status is a resolution (skill-created / resolved), also record WHEN it was
 * resolved plus an optional human note about the fix (`resolution`) — that is
 * the resolution-capture that lets a later reviewer see *what fixed it*, not
 * just what failed.
 */
export function markStatus(
	patterns: FailurePattern[],
	fp: string,
	status: FailureStatus,
	skillName?: string,
	resolution?: string,
	at: number = Date.now(),
): FailurePattern[] {
	const idx = patterns.findIndex((p) => p.fingerprint === fp);
	if (idx === -1) return patterns;
	const next = patterns.slice();
	const resolved =
		status === "skill-created" || status === "resolved"
			? { resolvedAt: at, resolution: resolution ?? patterns[idx].resolution }
			: {};
	next[idx] = {
		...patterns[idx],
		status,
		skillName: skillName ?? patterns[idx].skillName,
		...resolved,
	};
	return next;
}

/** Pure removal: drop a fingerprint from the list. */
export function forgetPattern(
	patterns: FailurePattern[],
	fp: string,
): FailurePattern[] {
	return patterns.filter((p) => p.fingerprint !== fp);
}

/* ------------------------------- report ------------------------------- */

/** Render the full learning report (first-time failures + repeat candidates). */
export function buildReport(
	analysis: PatternAnalysis[],
	threshold: number,
): string {
	const total = analysis.length;
	const occurrences = analysis.reduce((s, a) => s + a.occurrences, 0);
	const sessions = new Set<string>();
	for (const a of analysis) for (const s of a.pattern.sessions) sessions.add(s);

	const repeats = analysis.filter((a) => a.repeat);
	const reported = analysis.filter(
		(a) => !a.repeat && !TERMINAL_STATUSES.includes(a.pattern.status),
	);
	const closed = analysis.filter((a) =>
		TERMINAL_STATUSES.includes(a.pattern.status),
	);

	const out: string[] = [
		`# Failure Learning Report`,
		``,
		`Generated ${iso(Date.now())} · repeat threshold: ${threshold} sessions`,
		``,
		`**Summary:** ${total} pattern(s), ${occurrences} occurrence(s), across ${sessions.size} session(s) — ${repeats.length} repeat candidate(s), ${reported.length} reported, ${closed.length} closed.`,
		``,
	];

	const patternBlock = (a: PatternAnalysis): string[] => {
		const p = a.pattern;
		const last = p.traces[p.traces.length - 1];
		return [
			`### \`${p.fingerprint}\` — ${p.source} (${p.kind})`,
			``,
			`- **Message:** ${p.message}`,
			`- **Detail:** ${p.detail || "(none)"}`,
			`- **Seen:** ${a.occurrences}× in ${a.sessions} session(s) · first ${iso(p.firstSeenAt)} · last ${iso(p.lastSeenAt)}`,
			`- **Status:** ${p.status}${p.skillName ? ` · skill: \`${p.skillName}\`` : ""}`,
			...(p.workflow
				? [`- **When it recurs:** run the \`${p.workflow}\` dev workflow`]
				: []),
			`- **cwd:** ${p.cwd || "(unknown)"}`,
			...(p.sessions.length > 1
				? [`- **Sessions:** ${p.sessions.join(", ")}`]
				: []),
			``,
			...(last && last.lines.length
				? [`Latest trace (${iso(last.at)}):`, ``, "```", ...last.lines, "```", ``]
				: []),
		];
	};

	if (repeats.length) {
		out.push(`## 🧠 Repeat candidates — consider a skill (${repeats.length})`);
		out.push(
			``,
			`Mark with the \`learn\` tool: \`learn {action:"mark", fingerprint, mark:"skill-created"|"resolved"|"false-positive"}\` — creating a skill stops the recommendation.`,
			``,
		);
		for (const a of repeats) out.push(...patternBlock(a));
	}

	if (reported.length) {
		out.push(`## 📄 Reported (${reported.length})`);
		out.push(
			``,
			`First-time or single-session failures — documented, not yet repeated.`,
			``,
		);
		for (const a of reported) out.push(...patternBlock(a));
	}

	if (closed.length) {
		out.push(`## ✅ Closed (${closed.length})`);
		out.push(``);
		for (const a of closed) out.push(...patternBlock(a));
	}

	return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/* ---------------------------- skill drafting -------------------------- */

/** Deterministic skill name from source + message, e.g. "bash-command-not-found". */
export function skillSlug(source: string, message: string): string {
	const s = slugify(`${source} ${message}`);
	return s ? truncate(s, 48) : "learned-skill";
}

/** Deterministic draft SKILL.md the agent refines before publishing. */
export function skillDraft(name: string, a: PatternAnalysis): string {
	const p = a.pattern;
	const last = p.traces[p.traces.length - 1];
	const traceLines =
		last && last.lines.length ? last.lines : ["(no trace captured)"];
	return [
		"---",
		`name: ${name}`,
		"description: >-",
		"  Learned from " +
			`${a.occurrences} failure(s) across ${a.sessions} session(s): ` +
			`"${p.source}" kept failing with "${p.message}". ` +
			"Use this skill to avoid repeating the mistake.",
		"---",
		``,
		`# Avoiding "${p.message}" (${p.source})`,
		``,
		"## What went wrong",
		``,
		`- **Source:** \`${p.source}\` (kind: ${p.kind})`,
		`- **First seen:** ${iso(p.firstSeenAt)} · last: ${iso(p.lastSeenAt)} (${a.occurrences}×, ${a.sessions} session(s))`,
		``,
		"Latest trace:",
		``,
		"```",
		...traceLines,
		"```",
		``,
		"## Guardrails to follow",
		``,
		"- *(fill in: what to do instead — derive from the failure and your session knowledge; " +
			"keep it concrete and actionable)*",
		``,
	].join("\n");
}

/* ------------------------------- index -------------------------------- */

/**
 * Render the persistent cross-session `INDEX.md`: every pattern grouped by
 * repeat / reported / closed, each with its sessions back-linked to that
 * session's notes (when `noteForSession` resolves one). Pure string building;
 * the storage layer supplies the note-path resolver.
 */
export function buildIndex(
	analysis: PatternAnalysis[],
	threshold: number,
	noteForSession: (sessionId: string) => string | null = () => null,
): string {
	const total = analysis.length;
	const occurrences = analysis.reduce((s, a) => s + a.occurrences, 0);
	const allSessions = new Set<string>();
	for (const a of analysis)
		for (const s of a.pattern.sessions) allSessions.add(s);

	const repeats = analysis.filter((a) => a.repeat);
	const reported = analysis.filter(
		(a) => !a.repeat && !TERMINAL_STATUSES.includes(a.pattern.status),
	);
	const closed = analysis.filter((a) =>
		TERMINAL_STATUSES.includes(a.pattern.status),
	);

	const block = (a: PatternAnalysis): string => {
		const p = a.pattern;
		const wf = p.workflow ? ` · when it recurs → \`${p.workflow}\` workflow` : "";
		const skill = p.skillName ? ` · skill: \`${p.skillName}\`` : "";
		const sessionLines = p.sessions
			.map((s) => {
				const note = noteForSession(s);
				return note ? `  - \`${s}\` — [notes](${note})` : `  - \`${s}\``;
			})
			.join("\n");
		return [
			`### \`${p.fingerprint}\` — ${p.source} (${p.kind}) · ${p.status}${skill}${wf}`,
			``,
			`${p.occurrences}× in ${p.sessions.length} session(s) · first ${iso(p.firstSeenAt)} · last ${iso(p.lastSeenAt)}`,
			`- **Message:** ${p.message}`,
			...(p.resolution ? [`- **Resolution:** ${p.resolution}`] : []),
			...(p.resolvedAt ? [`- **Resolved:** ${iso(p.resolvedAt)}`] : []),
			`- **Sessions / notes:**`,
			sessionLines,
			``,
		].join("\n");
	};

	const group = (items: PatternAnalysis[], heading: string): string[] => {
		if (items.length === 0) return [];
		return [heading, ``, ...items.flatMap((a) => block(a)), ``];
	};

	const header = [
		"# Failure Learning Index",
		``,
		`Generated ${iso(Date.now())} · threshold: ${threshold} session(s) · ${total} pattern(s), ${occurrences} occurrence(s), ${allSessions.size} session(s)`,
		``,
		`🧠 ${repeats.length} repeat candidate(s) · 📄 ${reported.length} reported · ✅ ${closed.length} closed`,
		``,
	];

	return (
		[
			...header,
			...group(repeats, `## 🧠 Repeat candidates (${repeats.length})`),
			...group(reported, `## 📄 Reported (${reported.length})`),
			...group(closed, `## ✅ Closed (${closed.length})`),
		]
			.join("\n")
			.replace(/\n{3,}/g, "\n\n") + "\n"
	);
}

/* --------------------------- trace extraction ------------------------- */

/**
 * Build a bounded context trace for a tool failure from the session entries —
 * the last user prompt + the tool calls that led up to the failure.
 * Entry shape is defensive: any entry object with a message is safe.
 */
export function buildToolTrace(
	entries: unknown[],
	toolName: string,
	result: unknown,
	argsSummary: string,
): string[] {
	const lines: string[] = [];

	// Last user prompt (first line).
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		const msg = e?.message;
		if (msg && msg.role === "user" && Array.isArray(msg.content)) {
			const text = (msg.content as { type?: string; text?: string }[])
				.filter((b) => typeof b === "object" && b !== null && b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n")
				.replace(/\s+/g, " ")
				.trim();
			if (text) {
				lines.push(`user: ${truncate(text, 160)}`);
				break;
			}
		}
	}

	// Recent tool executions that preceded (or include) the failure.
	const seen: string[] = [];
	for (let i = entries.length - 1; i >= 0 && seen.length < 3; i--) {
		const e = entries[i] as {
			type?: string;
			message?: { name?: string; content?: unknown };
		};
		const msg = e?.message;
		if (!msg) continue;
		const name = (msg as { name?: string }).name;
		if (!name || seen.includes(name)) continue;
		const content = Array.isArray(msg.content)
			? (msg.content as { type?: string; text?: string }[])
					.filter((b) => typeof b === "object" && b !== null && b.type === "text")
					.map((b) => b.text ?? "")
					.join(" ")
					.replace(/\s+/g, " ")
					.trim()
			: typeof msg.content === "string"
				? msg.content
				: "";
		seen.push(name);
		lines.push(`tool: ${name}${content ? ` → ${truncate(content, 90)}` : ""}`);
	}

	lines.push(`failed: ${toolName}${argsSummary ? ` ${argsSummary}` : ""}`);
	const resultText =
		typeof result === "string"
			? result
			: typeof result === "object" && result !== null
				? JSON.stringify(result)
				: "";
	if (resultText) lines.push(`error: ${truncate(firstLine(resultText), 240)}`);

	return lines.slice(-MAX_TRACE_LINES);
}

/** Truncated one-line summary of tool call arguments (for the trace). */
export function summarizeArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string")
		return truncate(args.replace(/\s+/g, " ").trim(), 160);
	try {
		const s = JSON.stringify(args);
		return truncate(s, 160);
	} catch {
		return String(args);
	}
}
