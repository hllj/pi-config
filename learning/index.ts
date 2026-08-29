/**
 * Failure Learning — self-evolving agent harness.
 *
 * Captures failures while working and turns repeated patterns into skills:
 *
 *   Capture (automatic, silent):
 *     - `tool_execution_end` with `isError` → fingerprinted failure + bounded
 *       trace (last user prompt + recent tool calls + args + error line).
 *     - Subagent/workflow failures are ingested from the subagent run store
 *       (record.json, status failed/timed_out) — the broker's own tool call
 *       succeeds, so parent tool hooks must NOT capture those (no double
 *       counting). Each run is deduped by runId.
 *
 *   Store:
 *     ~/.pi/agent/learning/failures.json — one record per fingerprint
 *       (kind|source|normalized message), with occurrences, distinct sessions,
 *       bounded traces, and a lifecycle status:
 *       new → recommended → skill-created | resolved | false-positive.
 *
 *   /learn (TUI command):
 *     1. re-scans the subagent run store (idempotent).
 *     2. writes reports/failure-learning-<ts>.md into the learning dir
 *        (first-time failures = reports; repeats across sessions = skill
 *        candidates).
 *     3. if there are repeat candidates, writes a deterministic draft
 *        SKILL.md and nudges the agent (via followUp user message) to refine
 *        it from session knowledge and publish it. Creating a skill marks the
 *        pattern skill-created (terminal), so /learn stops re-recommending.
 *
 *   learn tool (LLM): status / report / mark / forget — closes the loop
 *   programmatically.
 *
 * Bridges to session memory (session-memory extension) — so failures and
 * resolutions leave a trace in the session NOTES, not just in failures.json:
 *   - First occurrence of a tool failure → auto-appended as one line under
 *     the notes' Errors & Corrections (deduped by fingerprint: retry loops
 *     never spam the notes).
 *   - learn mark skill-created/resolved → resolution captured on the pattern
 *     (resolvedAt + optional resolution note) and a Learnings bullet with a
 *     back-link appended to the closing session's notes.
 *   - reports/INDEX.md — persistent cross-session index linking every pattern
 *     to its sessions' notes, refreshed on /learn and learn report/mark.
 *
 * Storage override: PI_LEARNING_DIR. Subagent store: PI_SUBAGENT_SESSION_DIR
 * (reused from the subagent extension).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_THRESHOLD,
	analyze,
	buildIndex,
	buildReport,
	buildToolTrace,
	fingerprint,
	firstLine,
	iso,
	lookupRepeat,
	mergeOccurrence,
	markStatus,
	forgetPattern,
	skillDraft,
	skillSlug,
	stampWorkflow,
	suggestWorkflow,
	summarizeArgs,
	truncate,
	type FailureKind,
	type FailurePattern,
	type FailureStatus,
	type PatternAnalysis,
	type StoreShape,
	type WorkflowHint,
} from "./failure-store.ts";
import {
	appendSection,
	template as notesTemplate,
} from "../session-memory/lib.ts";
import {
	notesPathForSession,
	sessionNotesPath,
} from "../session-memory/index.ts";
import { listRuns, resolveStoreDir } from "../subagent/session-store.ts";

export const LEARNING_CUSTOM_TYPE = "failure-learning-report";

/** Data-driven (kind/source) workflow hint for a failure pattern. */
export interface RepeatWorkflowHint {
	workflow: WorkflowHint | null;
	repeats: boolean;
}

/** Always-false stub used when the failure store is unavailable. */
const NO_HINT: RepeatWorkflowHint = { workflow: null, repeats: false };

/**
 * Look up whether this failure qualifies as a repeat candidate in the failure
 * store and whether a dev workflow is suggested (R3). Symmetric to the
 * learning extension's own store access (same file + keying). Reads the tiny
 * store file on each failing tool call — calls are deduped by the caller
 * (dev-workflows tracks nudged fingerprints), so this stays cheap.
 */
export function repeatWorkflowHint(
	kind: FailureKind,
	source: string,
	detail: string,
): RepeatWorkflowHint {
	try {
		const raw = JSON.parse(
			readFileSync(storePath(), "utf8"),
		) as Partial<StoreShape>;
		const patterns = Array.isArray(raw.failures) ? raw.failures : [];
		const hit = lookupRepeat(patterns, kind, source, detail);
		return { workflow: hit?.workflow ?? null, repeats: hit !== null };
	} catch {
		return NO_HINT;
	}
}

/* ------------------------------ storage ------------------------------ */

export function learningRoot(): string {
	return (
		process.env.PI_LEARNING_DIR ?? join(homedir(), ".pi", "agent", "learning")
	);
}

function storePath(): string {
	return join(learningRoot(), "failures.json");
}

function reportsDir(): string {
	return join(learningRoot(), "reports");
}

function draftsDir(): string {
	return join(learningRoot(), "drafts");
}

function readStore(): StoreShape {
	try {
		const raw = JSON.parse(
			readFileSync(storePath(), "utf8"),
		) as Partial<StoreShape>;
		const failures = Array.isArray(raw.failures) ? raw.failures : [];
		return {
			meta: {
				threshold: raw.meta?.threshold ?? DEFAULT_THRESHOLD,
				updatedAt: raw.meta?.updatedAt,
			},
			failures: failures.filter((f) => f && typeof f.fingerprint === "string"),
		};
	} catch {
		return { meta: { threshold: DEFAULT_THRESHOLD }, failures: [] };
	}
}

function writeStore(store: StoreShape): void {
	mkdirSync(learningRoot(), { recursive: true });
	writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

function saveReport(content: string): string {
	mkdirSync(reportsDir(), { recursive: true });
	const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
	const file = join(reportsDir(), `failure-learning-${ts}.md`);
	writeFileSync(file, content, "utf8");
	return file;
}

function saveDraft(name: string, content: string): string {
	mkdirSync(draftsDir(), { recursive: true });
	const file = join(draftsDir(), `${name}.md`);
	writeFileSync(file, content, "utf8");
	return file;
}

/**
 * Write the persistent cross-session `reports/INDEX.md`, linking every pattern
 * to its sessions' notes (session-memory). Derived artifact — refreshed by
 * /learn, learn report, and learn mark.
 */
function saveIndex(store: StoreShape): string {
	mkdirSync(reportsDir(), { recursive: true });
	const index = buildIndex(
		analyze(store.failures, store.meta.threshold ?? DEFAULT_THRESHOLD),
		store.meta.threshold ?? DEFAULT_THRESHOLD,
		(sessionId) => {
			try {
				const p = notesPathForSession(sessionId);
				return existsSync(p) ? p : null;
			} catch {
				return null;
			}
		},
	);
	const file = join(reportsDir(), "INDEX.md");
	writeFileSync(file, index, "utf8");
	return file;
}

/* ---------------- bridge: session-notes mirroring ---------------- */

/** Read a session's notes, creating the standard template if absent. */
function readOrCreateNotes(path: string): string {
	return existsSync(path)
		? readFileSync(path, "utf8")
		: notesTemplate("Session Notes");
}

/** Write a notes file. Sync write; errors are the caller's to swallow. */
function writeNotes(path: string, md: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, md, "utf8");
}

/**
 * Append a one-line Errors & Corrections entry for a tool failure that hit
 * THIS session for the first time. Fingerprint+session deduped — retry loops
 * and /learn re-scans never spam the notes. Silent no-op on any failure:
 * learning must never break the main session over a notes write.
 */
function mirrorFailureToNotes(
	ctx: { cwd: string; sessionManager: { getSessionId?(): string } },
	fp: string,
	source: string,
	detail: string,
): void {
	try {
		const path = sessionNotesPath(ctx);
		const line = `${iso(Date.now())} — auto-captured failure \`${fp}\` (${source}): ${truncate(firstLine(detail), 200)}`;
		writeNotes(path, appendSection(readOrCreateNotes(path), "errors", line));
	} catch {
		/* notes unavailable — the failure store still records it */
	}
}

/**
 * Resolution capture: when a pattern is closed as skill-created/resolved,
 * append a Learnings bullet with the fingerprint + a back-link to the session
 * that closed the loop, so the fix narrative survives in the notes too.
 */
function mirrorResolutionToNotes(
	ctx: { cwd: string; sessionManager: { getSessionId?(): string } },
	pattern: FailurePattern,
	status: FailureStatus,
	skillName: string | undefined,
): void {
	try {
		const path = sessionNotesPath(ctx);
		const closing = ctx.sessionManager.getSessionId?.() ?? "?";
		const skill = skillName ? ` · skill: \`${skillName}\`` : "";
		const fix = pattern.resolution
			? ` · fix: ${truncate(pattern.resolution.replace(/\s+/g, " "), 300)}`
			: "";
		const line = `Failure \`${pattern.fingerprint}\` (${pattern.source}) closed as **${status}** — ${pattern.occurrences}× / ${pattern.sessions.length} session(s) · closed in \`${closing}\`${skill}${fix}`;
		writeNotes(path, appendSection(readOrCreateNotes(path), "learnings", line));
	} catch {
		/* notes unavailable — resolution is still captured in the store */
	}
}

/* --------------------------- subagent ingest -------------------------- */

/**
 * Ingest failed/timed-out subagent runs from the run store into the failure
 * store. Idempotent: each run is recorded once (runIds dedupe), so scanning on
 * every /learn never double-counts. Returns how many new failure occurrences
 * were merged.
 */
function ingestSubagentFailures(): number {
	const store = readStore();
	let merged = 0;

	for (const rec of listRuns({ status: "failed" }, resolveStoreDir())) {
		// mergeOccurrence's runIds guard makes re-scanning the same run a no-op,
		// so repeated /learn runs never double-count. Count new patterns/updates
		// by list length before/after.
		const before = store.failures.length;
		const message =
			rec.error || `${rec.agent} run failed (exit ${rec.exitCode ?? "?"})`;
		const after = mergeOccurrence(store.failures, {
			kind: "subagent",
			source: rec.agent || "subagent",
			detail: message,
			trace: [
				...(rec.outputSummary ? [`summary: ${rec.outputSummary}`] : []),
				`task: ${rec.task?.split("\n")[0] ?? "?"}`,
			],
			cwd: process.cwd(),
			sessionId: rec.parentSessionId,
			at: rec.endedAt ?? rec.startedAt ?? Date.now(),
			runId: rec.runId,
		});
		merged += after.length - before;
		store.failures = after;
	}
	if (merged > 0) writeStore(store);
	return merged;
}

/* --------------------------- report/analyze --------------------------- */

function runAnalysis(): {
	store: StoreShape;
	analysis: ReturnType<typeof analyze>;
} {
	const store = readStore();
	return {
		store,
		analysis: analyze(store.failures, store.meta.threshold ?? DEFAULT_THRESHOLD),
	};
}

/* ------------------------------ tool -------------------------------- */

/**
 * Stamp a suggested dev workflow onto every repeat candidate (data-driven by
 * kind/source) and return a FRESH analysis so reports/drafts/nudges carry the
 * suggestion. Idempotent: only writes when a pattern lacks a workflow hint.
 */
function promoteWithWorkflow(store: StoreShape): PatternAnalysis[] {
	let analysis = analyze(
		store.failures,
		store.meta.threshold ?? DEFAULT_THRESHOLD,
	);
	const repeats = analysis.filter((a) => a.repeat);
	let changed = false;
	for (const a of repeats) {
		const wf = suggestWorkflow(a.pattern);
		if (wf && a.pattern.workflow !== wf) {
			store.failures = stampWorkflow(store.failures, a.pattern.fingerprint, wf);
			changed = true;
		}
	}
	if (changed) writeStore(store);
	analysis = analyze(store.failures, store.meta.threshold ?? DEFAULT_THRESHOLD);
	return analysis;
}

const LearnParams = Type.Object({
	action: StringEnum(["status", "report", "mark", "forget"] as const),
	fingerprint: Type.Optional(Type.String()),
	mark: Type.Optional(
		StringEnum(["skill-created", "resolved", "false-positive"] as const),
	),
	skillName: Type.Optional(Type.String()),
	resolution: Type.Optional(
		Type.String({
			description:
				"How the failure was fixed — captured (with resolvedAt) for skill-created/resolved marks and logged to session notes",
		}),
	),
});

const LEARN_SNIPPET =
	"Review past failures (/learn builds reports + a cross-session INDEX from captured errors) and close the loop: mark resolved/false-positive, or skill-created when you create a skill for a repeated failure. For skill-created/resolved, pass a short `resolution` so the fix is captured and a Learnings entry lands in this session's notes.";

export default function (pi: ExtensionAPI) {
	// Subagent children must never capture or nudge from child processes (they
	// race the parent and would duplicate every failure record).
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";

	// tool_execution_end carries no args — cache them from *_start by toolCallId.
	const pendingArgs = new Map<string, string>();
	const MAX_PENDING_ARGS = 512;

	pi.on("tool_execution_start", (event) => {
		if (isSubagentChild) return;
		if (pendingArgs.size > MAX_PENDING_ARGS) pendingArgs.clear();
		pendingArgs.set(event.toolCallId, summarizeArgs(event.args));
	});

	/* ---- capture: tool execution failures (main session only) ---- */
	pi.on("tool_execution_end", (event, ctx) => {
		if (isSubagentChild) return;
		if (!event.isError) return;
		// Subagent/workflow dispatches fail INSIDE the child; the broker tool
		// call itself succeeds, so no capture here. ingestSubagentFailures()
		// reads those from the run store instead.
		if (event.toolName === "subagent" || event.toolName === "run_workflow")
			return;

		const store = readStore();
		const entries = ctx.sessionManager.getEntries();
		const argsSummary = pendingArgs.get(event.toolCallId) ?? "";
		pendingArgs.delete(event.toolCallId);
		const trace = buildToolTrace(
			entries,
			event.toolName,
			event.result,
			argsSummary,
		);
		const message =
			typeof event.result === "string"
				? event.result
				: typeof event.result === "object" && event.result !== null
					? JSON.stringify(event.result)
					: String(event.result ?? "tool failed");

		const fp = fingerprint({ kind: "tool", source: event.toolName, message });
		const existing = store.failures.find((f) => f.fingerprint === fp);
		const firstInThisSession =
			!existing || !existing.sessions.includes(ctx.sessionManager.getSessionId());
		store.failures = mergeOccurrence(store.failures, {
			kind: "tool",
			source: event.toolName,
			detail: message,
			trace,
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			at: Date.now(),
		});
		writeStore(store);
		// Bridge: first time a pattern touches THIS session, mirror one line into
		// the session notes so the failure leaves an in-context narrative trace.
		if (firstInThisSession) {
			mirrorFailureToNotes(ctx, fp, event.toolName, message);
		}
	});

	// Drop cached args at turn end so the map never grows unbounded.
	pi.on("turn_end", () => {
		if (isSubagentChild) return;
		pendingArgs.clear();
	});

	/* ---- capture: subagent/workflow failures via run store. Runs once per
	 * session start so failures are recorded even if /learn is never called. */
	pi.on("session_start", (_event, _ctx) => {
		if (isSubagentChild) return;
		try {
			ingestSubagentFailures();
		} catch {
			/* run store missing/corrupt — nothing to learn from */
		}
	});

	/* ---- /learn command (TUI, human) ---- */
	pi.registerCommand("learn", {
		description:
			"Failure learning: scan past failures, write a learning report (reports/failure-learning-<ts>.md), refresh the cross-session reports/INDEX.md (patterns → session notes), and recommend skills for repeated failures. On repeat candidates, a draft skill is written and the agent is nudged to refine + publish it. Args: `report` (write report only) | `scan` (re-ingest subagent failures) | `status` (brief counts).",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "";
			if (sub === "scan") {
				const merged = ingestSubagentFailures();
				ctx.ui.notify(
					`Re-scanned subagent runs — ${merged} new failure occurrence(s) recorded.`,
					merged > 0 ? "info" : "warning",
				);
				return;
			}
			if (sub === "status") {
				const { analysis } = runAnalysis();
				const total = analysis.length;
				const occ = analysis.reduce((s, a) => s + a.occurrences, 0);
				const repeats = analysis.filter((a) => a.repeat).length;
				ctx.ui.notify(
					`Failure learning: ${total} pattern(s), ${occ} occurrence(s), ${repeats} repeat candidate(s). Store: ${storePath()}`,
					"info",
				);
				return;
			}

			// default (and "report"): scan first (idempotent), then write report.
			if (sub !== "report") {
				try {
					ingestSubagentFailures();
				} catch {
					/* ignore */
				}
			}
			const store = readStore();
			const analysis = promoteWithWorkflow(store);
			const report = buildReport(
				analysis,
				store.meta.threshold ?? DEFAULT_THRESHOLD,
			);
			saveReport(report);
			saveIndex(store);
			const repeats = analysis.filter((a) => a.repeat);

			if (repeats.length === 0) {
				ctx.ui.notify(
					`Failure report written (${analysis.length} pattern(s), no repeat candidates yet). See ${learningRoot()}/reports`,
					"info",
				);
				return;
			}

			// Skill candidates exist: write drafts + notify.
			const drafts: string[] = [];
			for (const a of repeats) {
				const name = skillSlug(a.pattern.source, a.pattern.message);
				drafts.push(saveDraft(name, skillDraft(name, a)));
			}
			ctx.ui.notify(
				`📚 ${repeats.length} repeated failure(s) → ${drafts.length} draft skill(s) written to ${draftsDir()}. Promoting the best candidate to the agent for refinement.`,
				"info",
			);

			// Nudge the agent to refine + publish the top candidate. FIRST time a
			// pattern is promoted, a draft SKILL.md is actually written to the
			// drafts dir; repeat /learn after confirmation keeps the skill.
			const top = repeats[0];
			const wfHint = top.pattern.workflow
				? ` Since it recurs, consider handling it via the \`${top.pattern.workflow}\` dev workflow (run_dev_workflow type="${top.pattern.workflow}") so it's fixed systematically rather than re-hit inline.`
				: "";
			pi.sendUserMessage(
				`Failure-learning: "${top.pattern.source}" failed ${top.occurrences}× across ${top.sessions} session(s): "${top.pattern.message}".` +
					wfHint +
					` A draft skill exists at ${draftsDir()}/${skillSlug(top.pattern.source, top.pattern.message)}.md — ` +
					`refine it from this session's knowledge into skills/${skillSlug(top.pattern.source, top.pattern.message)}/SKILL.md, ` +
					`then call the learn tool \`learn {action:"mark", fingerprint:"${top.pattern.fingerprint}", mark:"skill-created", skillName:"<name>"}\` so /learn stops recommending it. ` +
					`If it isn't a real recurring failure, mark it "resolved" or "false-positive" instead.`,
				{ deliverAs: "followUp" },
			);
			void report; // (report persisted; the briefing above is concise on purpose)
		},
	});

	/* ---- learn tool (LLM): status / report / mark / forget ---- */
	pi.registerTool({
		name: "learn",
		label: "Failure Learning",
		description:
			'Review captured failures and close the loop. Actions: "status" (brief counts), "report" (write failures-report.md + return the full report), "mark" (set a pattern terminal: skill-created/resolved/false-positive — stops /learn recommending it; pass `resolution` to capture the fix; appends a Learnings entry to this session\'s notes), "forget" (drop a fingerprint). Fingerprints appear in reports and in the "Failure Learning Report" custom message after /learn.',
		promptSnippet: LEARN_SNIPPET,
		parameters: LearnParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isSubagentChild) {
				return {
					content: [
						{ type: "text", text: "Learning is managed in the main session." },
					],
					details: { ok: false, error: "subagent child" },
				};
			}
			const { store, analysis } = runAnalysis();

			switch (params.action) {
				case "status": {
					const repeats = analysis.filter((a) => a.repeat).length;
					return {
						content: [
							{
								type: "text",
								text: `${analysis.length} pattern(s), ${analysis.reduce((s, a) => s + a.occurrences, 0)} occurrence(s), ${repeats} repeat candidate(s). Store: ${storePath()}`,
							},
						],
						details: { ok: true, patterns: analysis.length, repeats },
					};
				}

				case "report": {
					// Re-read + promote (stamps workflow hints onto repeat candidates)
					// so the briefing tells the LLM which workflow fits each pattern.
					const store = readStore();
					const promoted = promoteWithWorkflow(store);
					const report = buildReport(
						promoted,
						store.meta.threshold ?? DEFAULT_THRESHOLD,
					);
					saveReport(report);
					saveIndex(store);
					// Return the report as the briefing so the LLM can act on it; the
					// full copy is persisted next to the report file too.
					const bounded =
						report.length > 6000 ? report.slice(0, 6000) + "… (truncated)" : report;
					return {
						content: [{ type: "text", text: bounded }],
						details: {
							ok: true,
							patterns: promoted.length,
							repeats: promoted.filter((a) => a.repeat).length,
						},
					};
				}

				case "mark": {
					if (!params.fingerprint) {
						return {
							content: [{ type: "text", text: "mark requires fingerprint" }],
							details: { ok: false, error: "fingerprint required" },
						};
					}
					const status = (params.mark ?? "resolved") as FailureStatus;
					store.failures = markStatus(
						store.failures,
						params.fingerprint,
						status,
						params.skillName,
						params.resolution,
					);
					writeStore(store);
					// Resolution capture + keep the global index current.
					if (status === "skill-created" || status === "resolved") {
						const pattern = store.failures.find(
							(f) => f.fingerprint === params.fingerprint,
						);
						if (pattern) {
							mirrorResolutionToNotes(ctx, pattern, status, params.skillName);
						}
					}
					saveIndex(store);
					return {
						content: [
							{
								type: "text",
								text: `Marked ${params.fingerprint} as ${status}${params.skillName ? ` (skill: ${params.skillName})` : ""}${params.resolution ? ` — "${params.resolution}"` : ""}. Session notes + INDEX.md updated.`,
							},
						],
						details: { ok: true, fingerprint: params.fingerprint, status },
					};
				}

				case "forget": {
					if (!params.fingerprint) {
						return {
							content: [{ type: "text", text: "forget requires fingerprint" }],
							details: { ok: false, error: "fingerprint required" },
						};
					}
					store.failures = forgetPattern(store.failures, params.fingerprint);
					writeStore(store);
					return {
						content: [{ type: "text", text: `Forgot ${params.fingerprint}.` }],
						details: { ok: true, fingerprint: params.fingerprint },
					};
				}

				default:
					return {
						content: [
							{ type: "text", text: `Unknown action: ${String(params.action)}` },
						],
						details: { ok: false, error: `unknown action ${String(params.action)}` },
					};
			}
		},
	});
}
