/**
 * Session Notes / Memory extension
 *
 * Keeps a living, structured markdown notes file for the CURRENT session — the
 * way a human keeps working notes while coding — with these sections:
 *
 *   Session Title, Current State, Task specification, Files and Functions,
 *   Workflow, Errors & Corrections, Codebase and System Documentation,
 *   Learnings, Key results, Worklog.
 *
 * Storage is PER-SESSION (not per-directory): each pi session has its own
 * working memory file, keyed by the session UUID. Resuming the same session
 * (pi -c, /resume) keeps its memory; a brand-new session starts fresh.
 *   ~/.pi/agent/memory/<session-id>/CURRENT.md        active notes
 *
 * Who writes it:
 *   - The pi coding agent updates it automatically (see "Auto-update").
 *   - The user views/edits it directly via `/notes edit`.
 * There is deliberately NO archive / new / seed lifecycle — the file is just
 * the working memory of the current session.
 *
 * Surfacing:
 *   - `note` tool (LLM): read / note / write / set_title
 *   - `/notes` command (user): status / edit / auto-log / auto-refresh
 *   - Auto-seed: on the first user turn of a session, if CURRENT.md exists for
 *     this session, a compact custom message (Title / Current State / Key
 *     results / Learnings / Errors) is injected into LLM context so a resumed
 *     session continues prior work.
 *   - TUI widget: a condensed Current State + recent Worklog is shown above the
 *     editor (like the todo list) whenever the notes have real content.
 *   - Session-close finalization: on quit/reload/new/resume/fork a timestamped
 *     worklog line marks the session boundary (so the notes track session ends).
 *   - Periodic auto-log: after each settled agent run, a one-line worklog entry
 *     summarizing the last assistant message is appended (deduped; on by
 *     default, toggle `/notes auto-log`).
 *   - Optional LLM refresh: `/notes auto-refresh` periodically nudges the agent
 *     to refresh every section via the note tool (off by default).
 *
 * Override the storage root with env PI_MEMORY_DIR.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	SECTION_HEADINGS,
	SECTION_IDS,
	appendSection,
	isAutoLoggable,
	autoRefreshStep,
	buildNotesStatus,
	buildNotesWidget,
	condense,
	extractTitle,
	prependWorklog,
	setSection,
	setTitle,
	summarizeMessage,
	template,
	worklogLine,
	type WidgetTheme,
} from "./lib.ts";

export const MEMORY_CUSTOM_TYPE = "session-notes";

/* ---------------- storage helpers ---------------- */

function memoryRoot(): string {
	return process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "memory");
}

/**
 * The memory key identifying THIS session's working notes: the session UUID
 * when one is available (persisted & in-memory sessions both carry an id).
 * Falls back to a per-cwd slug only if no session id is present.
 */
function sessionKey(ctx: {
	cwd: string;
	sessionManager?: { getSessionId?(): string };
}): string {
	const id = ctx.sessionManager?.getSessionId?.();
	if (id) return id;
	const base = ctx.cwd.split("/").filter(Boolean).pop() || "root";
	const h = createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 8);
	return `${base}-${h}`;
}

function memoryDir(key: string): string {
	return join(memoryRoot(), key);
}

function currentPath(key: string): string {
	return join(memoryDir(key), "CURRENT.md");
}

/**
 * Absolute CURRENT.md path for THIS session (session key + memory root).
 * Exported so the learning extension can mirror failures into the notes.
 */
export function sessionNotesPath(ctx: {
	cwd: string;
	sessionManager?: { getSessionId?(): string };
}): string {
	return currentPath(sessionKey(ctx));
}

/** Absolute CURRENT.md path for an explicit session id (index back-links). */
export function notesPathForSession(sessionId: string): string {
	return currentPath(sessionId);
}

function readCurrent(key: string): string | null {
	const p = currentPath(key);
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf8");
}

function writeCurrent(key: string, content: string): void {
	mkdirSync(memoryDir(key), { recursive: true });
	writeFileSync(currentPath(key), content, "utf8");
}

function ensureCurrent(key: string, title?: string): string {
	const existing = readCurrent(key);
	if (existing !== null) return existing;
	const content = template(title);
	writeCurrent(key, content);
	return content;
}

/* ---------------- auto-memory state (persisted toggles) ---------------- */

interface AutoMemoState {
	autoLog?: boolean;
	autoRefresh?: boolean;
	refreshEvery?: number;
	/** JSON parse guard: unknown fields are tolerated, not required. */
	autoRefreshPending?: number;
}

const AUTO_MEMO_STATE_FILE = () => join(memoryRoot(), "auto-state.json");

function readAutoState(): AutoMemoState {
	try {
		return JSON.parse(
			readFileSync(AUTO_MEMO_STATE_FILE(), "utf8"),
		) as AutoMemoState;
	} catch {
		return {};
	}
}

function writeAutoState(state: AutoMemoState): void {
	try {
		mkdirSync(memoryRoot(), { recursive: true });
		writeFileSync(AUTO_MEMO_STATE_FILE(), JSON.stringify(state, null, 2), "utf8");
	} catch {
		/* unwritable — keep in-memory for this session */
	}
}

/* ---------------- tool + command ---------------- */

const MemoryParams = Type.Object({
	action: StringEnum(["read", "note", "write", "set_title"] as const),
	section: Type.Optional(StringEnum(SECTION_IDS as [string, ...string[]])),
	content: Type.Optional(
		Type.String({ description: "Content to note or write to the given section" }),
	),
	title: Type.Optional(Type.String({ description: "New session title" })),
});

const NOTE_PROMPT_SNIPPET =
	"Keep structured session notes: read/note/write section content. Log work, learnings, key results, and errors as you go.";

const NOTE_PROMPT_GUIDELINES = [
	'Maintain an ongoing structured notes file for this conversation using the note tool with action = "read" to view it first.',
	'Use action "note" with a section to append a short bullet (a Worklog timestamp is added automatically).',
	'Log completed outcomes under "results", key discoveries under "learnings", and blocking problems under "errors".',
];

export default function (pi: ExtensionAPI) {
	// Notes are maintained ONLY in the main session. Subagent children spawn
	// `pi --mode json` with the same cwd and load this extension too; guard every
	// hook so they don't seed/auto-log from child processes (which would race the
	// parent's read-modify-write of CURRENT.md).
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";

	// TUI widget: show condensed notes (Current State + recent Worklog) above the
	// editor, mirrored in the footer. Uses a distinct key so it sits alongside
	// todo/plan widgets. Rebuilt whenever notes change or the session restarts.
	const refreshWidget = (ctx: {
		cwd: string;
		hasUI: boolean;
		ui: any;
		sessionManager?: { getSessionId?(): string };
	}) => {
		if (!ctx.hasUI) return;
		const key = sessionKey(ctx);
		const md = readCurrent(key);
		// SAFETY: WidgetTheme only needs fg(color,text), which ctx.ui.theme (Theme)
		// provides with the same shape as the todo widget theme.
		const theme = ctx.ui.theme as unknown as WidgetTheme;
		const lines = md ? buildNotesWidget(md, theme) : [];
		ctx.ui.setWidget("session-notes", lines.length ? lines : undefined);
		const status = md ? buildNotesStatus(md, theme) : undefined;
		ctx.ui.setStatus("session-notes", status);
	};

	// Auto-seed: inject a condensed brief into context on the first user turn of a
	// session if notes exist for this session. Sent as a hidden custom message.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (isSubagentChild) return; // never seed from subagent children
		refreshWidget(ctx);
		const md = readCurrent(sessionKey(ctx));
		if (!md) return;
		const brief = condense(md);
		if (!brief) return;
		return {
			message: {
				customType: MEMORY_CUSTOM_TYPE,
				content: brief,
				display: false,
			},
		};
	});

	// Show the widget as soon as a (TUI) session starts, not only on the first turn.
	pi.on("session_start", (_event, ctx) => {
		refreshWidget(ctx);
	});

	// Session-close finalization: when an extension runtime is torn down (quit,
	// reload, new, resume, fork) append a timestamped worklog line marking the
	// boundary, so the notes file reflects that the session ended. Sync write so
	// it always lands even during shutdown.
	pi.on("session_shutdown", (event, ctx) => {
		if (isSubagentChild) return;
		const key = sessionKey(ctx);
		const md = readCurrent(key);
		if (!md) return;
		const line = worklogLine(new Date(), `session closed (${event.reason})`);
		writeCurrent(key, prependWorklog(md, line));
		refreshWidget(ctx);
	});

	// Periodic auto-log: after each settled agent run, append a one-line worklog
	// entry summarizing the last assistant message. Deduped per message id so a
	// turn is logged exactly once; skips empty/trivial outputs. This keeps the
	// notes updating on its own, not only when the model happens to call `note`.
	let lastAutoLogKey: string | undefined;
	// Auto-memory state, hydrated from the persisted state file so toggles and
	// the refresh cadence survive session restarts. Auto-show both on by default:
	// auto-log keeps a worklog line per settled run; auto-refresh nudges the agent
	// to refresh all sections every `refreshEvery` settled runs (bounded).
	const autoState = readAutoState();
	const DEFAULT_REFRESH_EVERY = 5;
	let autoLogEnabled = autoState.autoLog ?? true; // /notes auto-log
	let autoRefreshEnabled = autoState.autoRefresh ?? true; // auto section refresh
	let autoRefreshPending = autoState.autoRefreshPending ?? DEFAULT_REFRESH_EVERY;
	let autoRefreshEvery = autoState.refreshEvery ?? DEFAULT_REFRESH_EVERY;
	const persistAutoState = () =>
		writeAutoState({
			autoLog: autoLogEnabled,
			autoRefresh: autoRefreshEnabled,
			refreshEvery: autoRefreshEvery,
			autoRefreshPending,
		});

	pi.on("agent_settled", (_event, ctx) => {
		if (isSubagentChild) return; // never write notes from subagent children
		const key = sessionKey(ctx);
		// Self-bootstrap: if no notes exist yet, create them now so auto-memory
		// always has a file to update — even when the model never calls `note`.
		const md = ensureCurrent(
			key,
			ctx.sessionManager.getSessionName() ?? undefined,
		);
		const entries = ctx.sessionManager.getEntries();
		// Find the newest assistant message.
		let lastKey: string | undefined;
		let lastText = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as {
				type?: string;
				id?: string;
				message?: unknown;
			};
			if (entry.type !== "message") continue;
			const msg = entry.message as
				| { role?: string; content?: unknown[] }
				| undefined;
			if (!msg || msg.role !== "assistant") continue;
			lastKey = entry.id;
			lastText = (msg.content ?? [])
				.filter(
					(b): b is { type: string; text?: string } =>
						typeof b === "object" &&
						b !== null &&
						(b as { type?: string }).type === "text",
				)
				.map((b) => b.text ?? "")
				.join("\n");
			break;
		}

		let upgraded = false;

		// Auto-log: one deterministic worklog line per settled run (on by default).
		if (autoLogEnabled && lastKey && lastKey !== lastAutoLogKey) {
			const summary = summarizeMessage(lastText);
			if (isAutoLoggable(summary)) {
				lastAutoLogKey = lastKey;
				writeCurrent(key, prependWorklog(md, worklogLine(new Date(), summary)));
				upgraded = true;
			}
		}

		// Auto-refresh (on by default): every `autoRefreshEvery` settled runs,
		// queue a follow-up that nudges the agent to refresh ALL sections via the
		// note tool. Bounded by the countdown (persisted) so the refresh turn
		// itself cannot re-trigger immediately.
		if (autoRefreshEnabled) {
			const step = autoRefreshStep(autoRefreshPending, autoRefreshEvery);
			autoRefreshPending = step.pending;
			if (step.fire) {
				pi.sendUserMessage(
					"Session maintenance: refresh the session notes with the note tool — update Current State, Files and Functions, Workflow, Learnings, Key results, and Errors & Corrections from the recent turns, and set the session title. Keep each concise.",
					{ deliverAs: "followUp" },
				);
				upgraded = true;
			}
		}
		persistAutoState();
		if (upgraded) refreshWidget(ctx);
	});

	// Register the note tool the LLM can call to maintain notes.
	pi.registerTool({
		name: "note",
		label: "Session Notes",
		description:
			'Read or maintain a structured markdown memory of the current session. Actions: "read" (dump current notes), "note" (append a bullet note to a section), "write" (replace a whole section), "set_title" (set the session title). Sections: title, state, task, files, workflow, errors, codebase, learnings, results, worklog.',
		promptSnippet: NOTE_PROMPT_SNIPPET,
		promptGuidelines: NOTE_PROMPT_GUIDELINES,
		parameters: MemoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isSubagentChild) {
				return {
					content: [
						{
							type: "text",
							text: "Notes are maintained only in the main session.",
						},
					],
					details: { ok: false, error: "subagent child" },
				};
			}
			const key = sessionKey(ctx);
			// Auto-title: adopt the pi session's display name as the notes title
			// ("update the name by pi itself"), sourced live from the tool-call
			// context. This keeps the `# Title` in sync with the session name so the
			// model doesn't have to call `set_title` just to give the notes a name.
			// A fresh file (created below) starts with the session name directly;
			// an existing file is re-titled only while it's still the placeholder
			// "Untitled session" — a manual/previous explicit title is never
			// clobbered.
			const sessionName = ctx.sessionManager.getSessionName()?.trim() || undefined;
			const existing = readCurrent(key);
			if (
				existing !== null &&
				sessionName &&
				extractTitle(existing) === "Untitled session"
			) {
				writeCurrent(key, setTitle(existing, sessionName));
				refreshWidget(ctx);
			}

			switch (params.action) {
				case "read": {
					const md = readCurrent(key);
					if (!md) {
						writeCurrent(key, template(sessionName));
						refreshWidget(ctx);
						return {
							content: [
								{ type: "text", text: "No notes yet — started a fresh document." },
							],
							details: { ok: true, created: true },
						};
					}
					return { content: [{ type: "text", text: md }], details: { ok: true } };
				}

				case "note": {
					if (!params.content) {
						return {
							content: [{ type: "text", text: "note requires content" }],
							details: { ok: false, error: "content required" },
						};
					}
					const section = params.section ?? "state";
					writeCurrent(
						key,
						appendSection(ensureCurrent(key, sessionName), section, params.content),
					);
					refreshWidget(ctx);
					return {
						content: [
							{ type: "text", text: `Noted under "${SECTION_HEADINGS[section]}".` },
						],
						details: { ok: true, action: "note", section },
					};
				}

				case "write": {
					if (!params.content) {
						return {
							content: [{ type: "text", text: "write requires content" }],
							details: { ok: false, error: "content required" },
						};
					}
					const section = params.section ?? "state";
					writeCurrent(
						key,
						setSection(ensureCurrent(key, sessionName), section, params.content),
					);
					refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Set "${SECTION_HEADINGS[section]}".` }],
						details: { ok: true, action: "write", section },
					};
				}

				case "set_title": {
					const title = params.title?.trim() || sessionName || "Untitled session";
					writeCurrent(key, setTitle(ensureCurrent(key, title), title));
					refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Title set: "${title}"` }],
						details: { ok: true },
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

	// /notes command: status / edit (user edits the current working memory).
	pi.registerCommand("notes", {
		description:
			"Session notes: default shows path, `edit` opens the file in the editor, `auto-log` toggles periodic worklog lines, `auto-refresh` toggles periodic LLM section refresh (`auto-refresh N` sets the cadence).",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const sub = trimmed.toLowerCase();

			switch (sub) {
				case "auto-log": {
					autoLogEnabled = !autoLogEnabled;
					persistAutoState();
					ctx.ui.notify(
						autoLogEnabled
							? "Auto-log on: each settled run appends one worklog line."
							: "Auto-log off: settled runs no longer append worklog lines.",
						autoLogEnabled ? "info" : "warning",
					);
					return;
				}

				case "auto-refresh": {
					const everyArg = Number.parseInt(
						trimmed.replace(/^auto-refresh\s*/, ""),
						10,
					);
					if (Number.isFinite(everyArg) && everyArg >= 2) {
						// `/notes auto-refresh N` — set cadence and force it on.
						autoRefreshEvery = everyArg;
						autoRefreshEnabled = true;
						autoRefreshPending = everyArg;
					} else {
						autoRefreshEnabled = !autoRefreshEnabled;
					}
					persistAutoState();
					ctx.ui.notify(
						autoRefreshEnabled
							? `Auto-refresh on: every ${autoRefreshEvery} runs the agent refreshes all notes sections.`
							: "Auto-refresh off: notes update via note tool / auto-log / manual edit.",
						autoRefreshEnabled ? "info" : "warning",
					);
					return;
				}

				case "edit": {
					const key = sessionKey(ctx);
					const current = ensureCurrent(key);
					if (!ctx.hasUI) {
						ctx.ui.notify(`Notes at ${currentPath(key)}`, "info");
						return;
					}
					const edited = await ctx.ui.editor("Edit session notes", current);
					if (edited !== undefined) {
						writeCurrent(key, edited);
						refreshWidget(ctx);
						ctx.ui.notify("Session notes updated.", "info");
					}
					return;
				}

				default: {
					const md = readCurrent(sessionKey(ctx));
					ctx.ui.notify(
						md === null
							? `No session notes yet at ${currentPath(sessionKey(ctx))}. Auto-memory will create them on the next settled run. /notes edit | auto-log | auto-refresh`
							: `Session notes: ${currentPath(sessionKey(ctx))} (${md.length} chars). auto-log ${autoLogEnabled ? "on" : "off"} · auto-refresh ${autoRefreshEnabled ? `on every ${autoRefreshEvery}` : "off"}. /notes edit | auto-log | auto-refresh`,
						"info",
					);
					return;
				}
			}
		},
	});
}
