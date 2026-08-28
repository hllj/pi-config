/**
 * Tests for the session-notes markdown logic (lib.ts).
 * Runs with native node type-stripping: `node lib.test.ts`
 */
import {
	appendSection,
	buildNotesStatus,
	buildNotesWidget,
	condense,
	extractTitle,
	lastWorklogLines,
	prependWorklog,
	setSection,
	setTitle,
	stripGuides,
	summarizeMessage,
	template,
	worklogLine,
} from "./lib.ts";

let failed = 0;

function assertContains(name: string, haystack: string, needle: string): void {
	if (haystack.includes(needle)) {
		console.log(`✓ ${name}`);
	} else {
		failed++;
		console.log(
			`✗ ${name}\n  expected to contain: ${JSON.stringify(needle)}\n  in:\n${indent(haystack)}`,
		);
	}
}

function assertNotContains(
	name: string,
	haystack: string,
	needle: string,
): void {
	if (haystack.includes(needle)) {
		failed++;
		console.log(
			`✗ ${name}\n  expected NOT to contain: ${JSON.stringify(needle)}`,
		);
	} else {
		console.log(`✓ ${name}`);
	}
}

function assertEqualStrict(
	name: string,
	actual: unknown,
	expected: unknown,
): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`✓ ${name}`);
	} else {
		failed++;
		console.log(`✗ ${name}\n  expected: ${e}\n  actual:   ${a}`);
	}
}

function indent(s: string): string {
	return s
		.split("\n")
		.map((l) => "    " + l)
		.join("\n");
}

// --- template ---
const tpl = template("Refactor auth");
assertContains("template has title heading", tpl, "# Refactor auth");
assertContains("template has all sections", tpl, "## Current State");
assertContains("template has all sections", tpl, "## Errors & Corrections");
assertContains(
	"template has all sections",
	tpl,
	"## Codebase and System Documentation",
);
assertContains("template has all sections", tpl, "## Key results");
assertContains("template has all sections", tpl, "## Worklog");

// --- setTitle ---
const retitled = setTitle(tpl, "New title");
assertContains("setTitle replaces # line", retitled, "# New title");
assertNotContains("setTitle removed old title", retitled, "# Refactor auth");

// --- setSection ---
const withState = setSection(tpl, "state", "Mid refactor, two tests green.");
assertContains(
	"setSection replaces section body",
	withState,
	"Mid refactor, two tests green.",
);
assertNotContains(
	"setSection removed guide placeholder",
	withState,
	"_Where the work stands",
);

// section that has no body replace
const withEmptyState = setSection(tpl, "state", "");
assertContains(
	"setSection empty leaves heading",
	withEmptyState,
	"## Current State",
);

// --- appendSection (note) ---
const noted = appendSection(
	tpl,
	"learnings",
	"Caching the token costs a rewrite.",
);
assertContains(
	"note adds a bullet",
	noted,
	"- Caching the token costs a rewrite.",
);
assertContains(
	"note keeps other learnings guide removed path",
	noted,
	"## Learnings",
);

// append two notes => bullets accumulate
const noted2 = appendSection(noted, "learnings", "Wrap the http client once.");
const learningsBody = noted2
	.split("## Learnings")[1]
	.split("## Key results")[0];
assertContains(
	"notes accumulate in the same section",
	learningsBody,
	"- Caching the token costs a rewrite.",
);
assertContains(
	"notes accumulate in the same section",
	learningsBody,
	"- Wrap the http client once.",
);

// --- appendSection appends to existing bullet content (not starting from template) ---
const manual = setSection(tpl, "results", "- Shipped v1");
const manual2 = appendSection(manual, "results", "Cut p95 40%");
const resultsBody = manual2.split("## Key results")[1].split("## Worklog")[0];
assertContains(
	"appends to prior non-bullet content as bullet",
	resultsBody,
	"- Shipped v1",
);
assertContains("appends new bullet", resultsBody, "- Cut p95 40%");

// --- worklogLine / prependWorklog / summarizeMessage ---
assertContains(
	"worklogLine is timestamped bullet",
	worklogLine(new Date("2026-01-02T03:04:05Z"), "went live"),
	"- 2026-01-02 03:04 — went live",
);

const pre = prependWorklog(template("T"), "- 2026-01-02 03:04 — closed (quit)");
const preLog = pre.split("## Worklog")[1];
assertContains(
	"prependWorklog inserts line at top of worklog",
	preLog,
	"closed (quit)",
);
assertEqualStrict(
	"prependWorklog is above the notes-started line",
	preLog.indexOf("closed (quit)") < preLog.indexOf("notes started"),
	true,
);

assertEqualStrict(
	"summarizeMessage collapses whitespace",
	summarizeMessage("a\n\n b   c"),
	"a b c",
);
assertEqualStrict(
	"summarizeMessage caps length",
	summarizeMessage("x".repeat(200), 20),
	`${("x").repeat(19)}…`,
);
assertEqualStrict("summarizeMessage empty", summarizeMessage("   "), "");

// --- worklog gets a timestamped line ---
assertContains("worklog auto-log line present", noted2, "auto-log update");

// --- condense ---
const cond = condense(withState);
assertContains(
	"condense carries title",
	cond ?? "",
	"Mid refactor, two tests green.",
);
assertContains("condense omits empty sections", cond ?? "", "## Current State");

// Fresh template (all guides) should condense to null (nothing real)
assertEqualStrict(
	"condense on blank template is null",
	condense(template()),
	null,
);

// stripGuides
assertEqualStrict(
	"stripGuides removes guide lines, keeps bullets",
	stripGuides("_Where the work stands_\n- real note\n_What is built_\n- second"),
	"- real note\n- second",
);
const custom = setSection(template(), "task", "Build X.");
assertContains("setSection creates newly-appended section", custom, "Build X.");
assertContains("setSection adds the heading", custom, "## Task specification");

// --- widget ---
const theme = { fg: (c: string, t: string) => `${c}:${t}` };

// blank template => no widget, no status
assertEqualStrict(
	"widget empty on blank template",
	buildNotesWidget(template(), theme),
	[],
);
assertEqualStrict(
	"status empty on blank template",
	buildNotesStatus(template(), theme),
	undefined,
);

// with a current state => widget shows title + state
const wmd = setSection(
	template("Auth work"),
	"state",
	"Mid refactor, two tests green.",
);
const wl = buildNotesWidget(wmd, theme).join("\n");
assertContains("widget shows title", wl, "Auth work");
assertContains(
	"widget shows current state",
	wl,
	"Mid refactor, two tests green.",
);

// status reflects non-empty + carries title
const st = buildNotesStatus(wmd, theme);
assertEqualStrict("status present when content", Boolean(st), true);
assertContains("status carries title", st ?? "", "Auth work");

// extractTitle / lastWorklogLines
assertEqualStrict("extractTitle", extractTitle(template("X")), "X");
assertEqualStrict(
	"extractTitle default",
	extractTitle(template()),
	"Untitled session",
);
assertEqualStrict(
	"worklog excludes template line",
	lastWorklogLines(template("T"), 2).length,
	0,
);
const withNote = appendSection(template("T"), "results", "Shipped");
const realLog = lastWorklogLines(withNote, 2);
assertEqualStrict("worklog captures real entries", realLog.length, 1);
assertEqualStrict(
	"worklog caps max",
	lastWorklogLines(withNote, 10).length === 1,
	true,
);

if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}
console.log("\nAll lib tests passed.");
