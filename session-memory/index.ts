/**
 * Session Notes / Memory extension
 *
 * Keeps a living, structured markdown notes file for the current conversation —
 * the way a human keeps working notes while coding — with these sections:
 *
 *   Session Title, Current State, Task specification, Files and Functions,
 *   Workflow, Errors & Corrections, Codebase and System Documentation,
 *   Learnings, Key results, Worklog.
 *
 * Storage (per working directory, survives restarts and /reload):
 *   ~/.pi/agent/memory/<cwd-slug>/CURRENT.md             active notes
 *   ~/.pi/agent/memory/<cwd-slug>/archives/<topic>.md    snapshots on archive/new
 *
 * Surfacing:
 *   - `note` tool (LLM): read / note / write / set_title / archive
 *   - `/notes` command (user): status / edit / new / edit / seed
 *   - Auto-seed: on the first user turn of a session, if CURRENT.md exists for
 *     this cwd, a compact custom message (Title / Current State / Key results /
 *     Learnings / Errors) is injected into LLM context so a new session
 *     continues prior work.
 *   - TUI widget: a condensed Current State + recent Worklog is shown above the
 *     editor (like the todo list) whenever the notes have real content.
 *   - Auto-archive on compact: when a session is compacted, the current notes
 *     are snapshotted to archives/ (so they are never lost to summarization).
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
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
	existsSync,
} from "node:fs";
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

function cwdSlug(cwd: string): string {
	const base = cwd.split("/").filter(Boolean).pop() || "root";
	const h = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
	return `${base}-${h}`;
}

function memoryDir(cwd: string): string {
	return join(memoryRoot(), cwdSlug(cwd));
}

function currentPath(cwd: string): string {
	return join(memoryDir(cwd), "CURRENT.md");
}

function archiveDir(cwd: string): string {
	return join(memoryDir(cwd), "archives");
}

function readCurrent(cwd: string): string | null {
	const p = currentPath(cwd);
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf8");
}

function writeCurrent(cwd: string, content: string): void {
	mkdirSync(memoryDir(cwd), { recursive: true });
	writeFileSync(currentPath(cwd), content, "utf8");
}

function ensureCurrent(cwd: string, title?: string): string {
	const existing = readCurrent(cwd);
	if (existing !== null) return existing;
	const content = template(title);
	writeCurrent(cwd, content);
	return content;
}

/** Archive CURRENT.md to archives/<slug>.md (deduped), returning the file path. */
function snapshotCurrent(cwd: string, topic?: string): string {
	const md = ensureCurrent(cwd);
	const dir = archiveDir(cwd);
	mkdirSync(dir, { recursive: true });
	const inferred = (md.split("\n").find((l) => l.startsWith("# ")) ?? "")
		.slice(2)
		.trim();
	const base = topic?.trim().toLowerCase() || inferred || "untitled";
	const safe =
		base
			.replace(/[^\w\- ]+/g, "")
			.replace(/\s+/g, "-")
			.slice(0, 60) || "untitled";
	let final = join(dir, `${safe}.md`);
	let i = 1;
	while (existsSync(final)) {
		final = join(dir, `${safe}-${i}.md`);
		i++;
	}
	writeFileSync(final, md, "utf8");
	return final;
}

/** Archive CURRENT.md and start a fresh document (used by `/notes new` and the tool). */
function archiveCurrent(cwd: string, topic?: string): string {
	const md = ensureCurrent(cwd);
	const inferred = (md.split("\n").find((l) => l.startsWith("# ")) ?? "")
		.slice(2)
		.trim();
	const next =
		topic?.trim() ||
		(inferred && inferred !== "Untitled session" ? inferred : "session-notes");
	const final = snapshotCurrent(cwd, next);
	writeCurrent(cwd, template(next));
	return final;
}

/** List archived notes filenames for a cwd. */
function listArchives(cwd: string): string[] {
	const dir = archiveDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort((a, b) => a.localeCompare(b));
}

/* ---------------- tool + command ---------------- */

const MemoryParams = Type.Object({
	action: StringEnum(["read", "note", "write", "set_title", "archive"] as const),
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
	// hook so they don't seed/archive/auto-log from child processes (which would
	// race the parent's read-modify-write of CURRENT.md).
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";

	// TUI widget: show condensed notes (Current State + recent Worklog) above the
	// editor, mirrored in the footer. Uses a distinct key so it sits alongside
	// todo/plan widgets. Rebuilt whenever notes change or the session restarts.
	const refreshWidget = (ctx: { cwd: string; hasUI: boolean; ui: any }) => {
		if (!ctx.hasUI) return;
		const md = readCurrent(ctx.cwd);
		// SAFETY: WidgetTheme only needs fg(color,text), which ctx.ui.theme (Theme)
		// provides with the same shape as the todo widget theme.
		const theme = ctx.ui.theme as unknown as WidgetTheme;
		const lines = md ? buildNotesWidget(md, theme) : [];
		ctx.ui.setWidget("session-notes", lines.length ? lines : undefined);
		const status = md ? buildNotesStatus(md, theme) : undefined;
		ctx.ui.setStatus("session-notes", status);
	};

	// Auto-seed: inject a condensed brief into context on the first user turn of a
	// session if notes exist for this cwd. Sent as a hidden custom message.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (isSubagentChild) return; // never seed from subagent children
		refreshWidget(ctx);
		const md = readCurrent(ctx.cwd);
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
		const md = readCurrent(ctx.cwd);
		if (!md) return;
		const line = worklogLine(new Date(), `session closed (${event.reason})`);
		if (isSubagentChild) return;
		writeCurrent(ctx.cwd, prependWorklog(md, line));
		refreshWidget(ctx);
	});

	// Periodic auto-log: after each settled agent run, append a one-line worklog
	// entry summarizing the last assistant message. Deduped per message id so a
	// turn is logged exactly once; skips empty/trivial outputs. This keeps the
	// notes updating on its own, not only when the model happens to call `note`.
	let lastAutoLogKey: string | undefined;
	let autoLogEnabled = true; // /notes auto-log
	let autoRefreshEnabled = false; // /notes auto-refresh (opt-in LLM refresh)
	let autoRefreshCountdown = 0;
	const AUTO_REFRESH_EVERY = 5; // nudge the agent to refresh sections every N settled runs

	pi.on("agent_settled", (_event, ctx) => {
		if (isSubagentChild) return; // never write notes from subagent children
		const md = readCurrent(ctx.cwd);
		if (!md) return;
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

		// Auto-log: one deterministic worklog line per settled run (on by default).
		if (autoLogEnabled && lastKey && lastKey !== lastAutoLogKey) {
			const summary = summarizeMessage(lastText);
			if (summary) {
				lastAutoLogKey = lastKey;
				writeCurrent(ctx.cwd, prependWorklog(md, worklogLine(new Date(), summary)));
				refreshWidget(ctx);
			}
		}

		// Auto-refresh (opt-in): every N settled runs, queue a follow-up that nudges
		// the agent to refresh ALL sections via the note tool. Bounded by the
		// countdown so the refresh turn itself cannot re-trigger immediately.
		if (autoRefreshEnabled) {
			autoRefreshCountdown--;
			if (autoRefreshCountdown <= 0) {
				autoRefreshCountdown = AUTO_REFRESH_EVERY;
				pi.sendUserMessage(
					"Session maintenance: refresh the session notes with the note tool — update Current State, Files and Functions, Workflow, Learnings, Key results, and Errors & Corrections from the recent turns. Keep each concise.",
					{ deliverAs: "followUp" },
				);
			}
		}
	});

	// Auto-archive on compact: when the session is compacted (context summarized),
	// snapshot the current notes so their content survives independently of the
	// summarization. Skips when the notes are still just the empty template.
	pi.on("session_compact", (_event, ctx) => {
		if (isSubagentChild) return; // never archive from subagent children
		const md = readCurrent(ctx.cwd);
		if (!md) return;
		if (condense(md) === null) return; // nothing real to preserve yet
		const archived = snapshotCurrent(ctx.cwd, "compact");
		ctx.ui.notify(
			`Session compacted — session notes archived to ${archived}`,
			"info",
		);
	});

	// Register the note tool the LLM can call to maintain notes.
	pi.registerTool({
		name: "note",
		label: "Session Notes",
		description:
			'Read or maintain a structured markdown memory of the current session. Actions: "read" (dump current notes), "note" (append a bullet note to a section), "write" (replace a whole section), "set_title" (set the session title), "archive" (snapshot current notes and start fresh). Sections: title, state, task, files, workflow, errors, codebase, learnings, results, worklog.',
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
			// Auto-title: adopt the pi session's display name as the notes title
			// ("update the name by pi itself"), sourced live from the tool-call
			// context. This keeps the `# Title` in sync with the session name so the
			// model doesn't have to call `set_title` just to give the notes a name.
			// A fresh file (created below) starts with the session name directly;
			// an existing file is re-titled only while it's still the placeholder
			// "Untitled session" — a manual/previous explicit title is never
			// clobbered.
			const sessionName = ctx.sessionManager.getSessionName()?.trim() || undefined;
			const existing = readCurrent(ctx.cwd);
			if (
				existing !== null &&
				sessionName &&
				extractTitle(existing) === "Untitled session"
			) {
				writeCurrent(ctx.cwd, setTitle(existing, sessionName));
				refreshWidget(ctx);
			}

			switch (params.action) {
				case "read": {
					const md = readCurrent(ctx.cwd);
					if (!md) {
						writeCurrent(ctx.cwd, template(sessionName));
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
						ctx.cwd,
						appendSection(
							ensureCurrent(ctx.cwd, sessionName),
							section,
							params.content,
						),
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
						ctx.cwd,
						setSection(ensureCurrent(ctx.cwd, sessionName), section, params.content),
					);
					refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Set "${SECTION_HEADINGS[section]}".` }],
						details: { ok: true, action: "write", section },
					};
				}

				case "set_title": {
					const title = params.title?.trim() || sessionName || "Untitled session";
					writeCurrent(ctx.cwd, setTitle(ensureCurrent(ctx.cwd, title), title));
					refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Title set: "${title}"` }],
						details: { ok: true },
					};
				}

				case "archive": {
					const archived = archiveCurrent(ctx.cwd, params.title);
					refreshWidget(ctx);
					return {
						content: [
							{
								type: "text",
								text: `Archived to ${archived}. Started a fresh document.`,
							},
						],
						details: { ok: true, archived },
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

	// /notes command: status / edit / new / seed.
	pi.registerCommand("notes", {
		description:
			"Session notes: default shows path, `edit` opens the file in the editor, `new <title>` archives + restarts, `seed` loads a past topic, `auto-log` toggles periodic worklog lines, `auto-refresh` toggles periodic LLM section refresh.",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const space = trimmed.indexOf(" ");
			const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();

			switch (sub) {
				case "auto-log": {
					autoLogEnabled = !autoLogEnabled;
					ctx.ui.notify(
						autoLogEnabled
							? "Auto-log on: each settled run appends one worklog line."
							: "Auto-log off: settled runs no longer append worklog lines.",
						autoLogEnabled ? "info" : "warning",
					);
					return;
				}

				case "auto-refresh": {
					autoRefreshEnabled = !autoRefreshEnabled;
					ctx.ui.notify(
						autoRefreshEnabled
							? "Auto-refresh on: every few runs the agent refreshes all notes sections."
							: "Auto-refresh off: notes update only via note tool / auto-log / manual edit.",
						autoRefreshEnabled ? "info" : "warning",
					);
					return;
				}

				case "edit": {
					const current = ensureCurrent(ctx.cwd);
					if (!ctx.hasUI) {
						ctx.ui.notify(`Notes at ${currentPath(ctx.cwd)}`, "info");
						return;
					}
					const edited = await ctx.ui.editor("Edit session notes", current);
					if (edited !== undefined) {
						writeCurrent(ctx.cwd, edited);
						refreshWidget(ctx);
						ctx.ui.notify("Session notes updated.", "info");
					}
					return;
				}

				case "new": {
					const title = space === -1 ? undefined : trimmed.slice(space + 1).trim();
					const archived = archiveCurrent(ctx.cwd, title);
					refreshWidget(ctx);
					ctx.ui.notify(`Archived to ${archived}. Fresh notes started.`, "info");
					return;
				}

				case "seed": {
					const files = listArchives(ctx.cwd);
					if (files.length === 0) {
						ctx.ui.notify(
							"No archived topics to seed yet. Use `/notes new` when finishing a topic.",
							"warning",
						);
						return;
					}
					const choice = await ctx.ui.select(
						"Pick a past topic to load into context:",
						files,
					);
					if (!choice) return;
					const content = readFileSync(join(archiveDir(ctx.cwd), choice), "utf8");
					// Restore the archived topic as the working document. The next user
					// turn auto-seeds the condensed brief into context.
					writeCurrent(ctx.cwd, content);
					refreshWidget(ctx);
					ctx.ui.notify(
						`Loaded "${choice}" as the working document; it will be seeded into context on your next message.`,
						"info",
					);
					return;
				}

				default: {
					const md = readCurrent(ctx.cwd);
					ctx.ui.notify(
						md === null
							? `No session notes yet at ${currentPath(ctx.cwd)}. Create with /notes edit.`
							: `Session notes: ${currentPath(ctx.cwd)} (${md.length} chars). /notes edit | new | seed | auto-log | auto-refresh`,
						"info",
					);
					return;
				}
			}
		},
	});
}
