/**
 * Pure markdown manipulation for session notes. No file I/O — kept separately
 * from index.ts so it can be unit-tested directly with `node lib.test.ts`.
 */

/** Section ids used by the tool, mapped to markdown headings. */
export const SECTION_HEADINGS: Record<string, string> = {
	title: "Session Title",
	state: "Current State",
	task: "Task specification",
	files: "Files and Functions",
	workflow: "Workflow",
	errors: "Errors & Corrections",
	codebase: "Codebase and System Documentation",
	learnings: "Learnings",
	results: "Key results",
	worklog: "Worklog",
};

export const SECTION_IDS = Object.keys(SECTION_HEADINGS);

/** Minimal theme surface used by the widget builders (same shape as ctx.ui.theme). */
export interface WidgetTheme {
	fg(color: string, text: string): string;
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Lines of a section body, guide placeholders gone, non-empty only. */
function sectionLines(md: string, id: string): string[] {
	const heading = SECTION_HEADINGS[id];
	const lines = md.split("\n");
	const start = sectionHeadStart(lines, heading);
	if (start === -1) return [];
	const end = nextHeadingIndex(lines, start);
	return stripGuides(lines.slice(start, end).join("\n"))
		.split("\n")
		.map((l) => l.trim().replace(/^[-*]\s+/, ""))
		.filter(Boolean);
}

function sectionHeadStart(lines: string[], heading: string): number {
	// position of the heading line itself (return its line index, body starts +1)
	const idx = lines.findIndex((l) => l === `## ${heading}`);
	return idx === -1 ? -1 : idx + 1;
}

/** The top-level `# Title`, or undefined. */
export function extractTitle(md: string): string | undefined {
	const line = md.split("\n").find((l) => l.startsWith("# "));
	return line ? line.slice(2).trim() : undefined;
}

/** Most recent real worklog lines (excluding the template “notes started” line). */
export function lastWorklogLines(md: string, max: number): string[] {
	const lines = sectionLines(md, "worklog").filter(
		(l) => !/notes started/.test(l),
	);
	return lines.slice(-max);
}

/**
 * Build the persistent above-editor widget for session notes. Returns [] when
 * the notes have no meaningful content (fresh template only).
 */
export function buildNotesWidget(md: string, theme: WidgetTheme): string[] {
	const title = extractTitle(md);
	const state = sectionLines(md, "state");
	const work = lastWorklogLines(md, 2);
	if (state.length === 0 && work.length === 0) return [];

	const lines: string[] = [];
	if (title && title !== "Untitled session") {
		lines.push(`${theme.fg("accent", "📝 ")}${title}`);
	}
	if (state.length) {
		lines.push(`  ${theme.fg("muted", "Current: ")}${truncate(state[0], 70)}`);
	}
	if (work.length) {
		lines.push(theme.fg("dim", "  Recent:"));
		for (const w of work) {
			lines.push(`    ${theme.fg("dim", "- ")}${truncate(w.trim(), 52)}`);
		}
	}
	return lines;
}

/** Footer status, or undefined when the notes are empty (clears the status). */
export function buildNotesStatus(
	md: string,
	_theme: WidgetTheme,
): string | undefined {
	const state = sectionLines(md, "state");
	const work = lastWorklogLines(md, 1);
	if (state.length === 0 && work.length === 0) return undefined;
	const title = extractTitle(md);
	const label =
		title && title !== "Untitled session" ? truncate(title, 24) : "session notes";
	return `📝 ${label}`;
}

/** Render the default template for a fresh memory file. */
export function template(title?: string): string {
	const now = new Date().toISOString();
	const t = title ?? "Untitled session";
	return [
		`> Auto-maintained session notes. Update via the \`note\` tool, or open with \`/notes edit\`.`,
		``,
		`# ${t}`,
		``,
		`## Current State`,
		`_Where the work stands right now. Refresh as the session progresses._`,
		``,
		`## Task specification`,
		`_What is being built or fixed, and the acceptance criteria._`,
		``,
		`## Files and Functions`,
		`_Key files, functions, and modules touched in this session._`,
		``,
		`## Workflow`,
		`_Step-by-step process: commands, tool orchestration, and ordering._`,
		``,
		`## Errors & Corrections`,
		`_Problems hit, their fixes, and any gotchas._`,
		``,
		`## Codebase and System Documentation`,
		`_Architecture notes, environment details, how components fit together._`,
		``,
		`## Learnings`,
		`_Insights, patterns, and tradeoffs discovered._`,
		``,
		`## Key results`,
		`_Concrete outputs, metrics, and wins._`,
		``,
		`## Worklog`,
		`- ${now.slice(0, 16).replace("T", " ")} — notes started.`,
		``,
	].join("\n");
}

/** Index (0-based) of the first line matching `## heading`, or -1. */
function sectionStart(lines: string[], heading: string): number {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === `## ${heading}`) return i + 1;
	}
	return -1;
}

/** Index of the next heading (any `#... ` heading) strictly after `from`, else length. */
function nextHeadingIndex(lines: string[], from: number): number {
	for (let i = from; i < lines.length; i++) {
		if (/^#{1,3}\s/.test(lines[i])) return i;
	}
	return lines.length;
}

function timestampedWorklogLine(): string {
	return `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} — auto-log update`;
}

/** Remove the template placeholder `_..._` guides from a section body. */
export function stripGuides(body: string): string {
	return body
		.split("\n")
		.filter(
			(l) =>
				!/^_Where|^_What|^_Key|^_Step|^_Problems|^_Architecture|^_Insights|^_Concrete/.test(
					l.trim(),
				),
		)
		.join("\n");
}

/** Build a single timestamped worklog bullet, e.g. `- 2026-01-01 12:00 — text`. */
export function worklogLine(when: Date, text: string): string {
	const ts = when.toISOString().slice(0, 16).replace("T", " ");
	return `- ${ts} — ${text.trim()}`;
}

/**
 * Prepend a ready-made line at the top of the Worklog section (immediately after
 * its `## Worklog` heading), creating the section if absent. Unlike appendSection
 * this does NOT add an extra "auto-log update" line — the caller supplies the
 * full bullet.
 */
export function prependWorklog(md: string, line: string): string {
	const heading = SECTION_HEADINGS.worklog;
	const lines = md.split("\n");
	const wl = sectionStart(lines, heading);
	if (wl === -1) {
		return `${md.replace(/\s+$/, "")}\n\n## ${heading}\n${line}\n`;
	}
	return [...lines.slice(0, wl), line, ...lines.slice(wl)].join("\n");
}

/** Shrink multi-line message text to a single concise worklog line. */
export function summarizeMessage(text: string, max = 90): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Replace the body of section `id` with `content` (creating the section if absent). */
export function setSection(md: string, id: string, content: string): string {
	const heading = SECTION_HEADINGS[id];
	const lines = md.split("\n");
	const block = content.trimEnd();
	if (!heading) throw new Error(`unknown section id: ${id}`);
	const start = sectionStart(lines, heading);
	if (start === -1) {
		return `${md.replace(/\s+$/, "")}\n\n## ${heading}\n\n${block}\n\n`;
	}
	const end = nextHeadingIndex(lines, start);
	return [...lines.slice(0, start), "", block, ...lines.slice(end)].join("\n");
}

/** Set the `# Title` line (top-level), creating it if absent. */
export function setTitle(md: string, title: string): string {
	const lines = md.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("# ")) {
			lines[i] = `# ${title.trim()}`;
			return lines.join("\n");
		}
	}
	return `# ${title.trim()}\n\n${md}`;
}

function bulletsFor(block: string, asBullets: boolean): string {
	if (!asBullets) return block;
	return block
		.split("\n")
		.map((l) =>
			l.trim().startsWith("-") || l.trim().startsWith("*")
				? l.trimEnd()
				: `- ${l.trim()}`,
		)
		.join("\n");
}

/**
 * Append bullet content into a section, prepending a Worklog line. If the
 * section is empty (template guides only), it is replaced outright. Pure: takes
 * the current document and returns the new one.
 */
export function appendSection(md: string, id: string, content: string): string {
	const heading = SECTION_HEADINGS[id];
	const lines = md.split("\n");
	const block = content.trim();
	if (!heading) throw md;

	if (id === "title") return setTitle(md, block);

	const prependWorklog = (text: string): string => {
		const wl = sectionStart(text.split("\n"), SECTION_HEADINGS.worklog);
		if (wl === -1) {
			return `${text.replace(/\s+$/, "")}\n## ${SECTION_HEADINGS.worklog}\n${timestampedWorklogLine()}\n`;
		}
		const wLines = text.split("\n");
		return [
			...wLines.slice(0, wl),
			timestampedWorklogLine(),
			...wLines.slice(wl),
		].join("\n");
	};

	const start = sectionStart(lines, heading);
	if (start === -1) {
		return prependWorklog(
			`${md.replace(/\s+$/, "")}\n\n## ${heading}\n\n${bulletsFor(block, id !== "codebase")}\n`,
		);
	}

	const end = nextHeadingIndex(lines, start);
	const existing = stripGuides(lines.slice(start, end).join("\n")).trim();
	const updated = existing
		? existing +
			"\n" +
			block
				.split("\n")
				.map((l) => (l.startsWith("-") ? l : `- ${l}`))
				.join("\n")
		: bulletsFor(block, id !== "codebase");
	const withBody = [
		...lines.slice(0, start),
		"",
		updated,
		...lines.slice(end),
	].join("\n");
	return prependWorklog(withBody);
}

/**
 * Build a compact "memory brief" for context seeding — bounded to never flood
 * the window. Returns null when there is nothing meaningful to seed.
 */
export function condense(md: string): string | null {
	if (!md) return null;
	const titleLine = md.split("\n").find((l) => l.startsWith("# "));
	const title = titleLine ? titleLine.slice(2).trim() : "Untitled";

	const pick = (id: string, limit: number): string | null => {
		const heading = SECTION_HEADINGS[id];
		const lines = md.split("\n");
		const start = sectionStart(lines, heading);
		if (start === -1) return null;
		const end = nextHeadingIndex(lines, start);
		const body = lines
			.slice(start, end)
			.map((l) => l.trim())
			.filter(Boolean)
			.join("\n");
		const stripped = stripGuides(body).trim();
		if (!stripped) return null;
		return stripped.length > limit ? stripped.slice(0, limit) + "…" : stripped;
	};

	const parts: string[] = [`# ${title}`];
	let hasContent = false;
	const state = pick("state", 600);
	if (state) {
		parts.push(`## Current State\n${state}`);
		hasContent = true;
	}
	const results = pick("results", 600);
	if (results) {
		parts.push(`## Key results\n${results}`);
		hasContent = true;
	}
	const learn = pick("learnings", 600);
	if (learn) {
		parts.push(`## Learnings\n${learn}`);
		hasContent = true;
	}
	const errors = pick("errors", 500);
	if (errors) {
		parts.push(`## Errors & Corrections\n${errors}`);
		hasContent = true;
	}
	const worklog = pick("worklog", 400);
	if (worklog) {
		// Skip the template's "notes started" placeholder line — real activity only.
		const real = worklog
			.split("\n")
			.filter((l) => !/notes started/.test(l))
			.join("\n")
			.trim();
		if (real) {
			parts.push(`## Worklog (recent)\n${real}`);
			hasContent = true;
		}
	}
	// No real content beyond the title (only template guides) → nothing to seed.
	if (!hasContent) return null;

	return parts.join("\n\n");
}
