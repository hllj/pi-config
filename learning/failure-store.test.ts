// Unit tests for learning/failure-store.ts — pure logic, no I/O.
// Run directly with Node >= 22 (type-stripping):  node learning/failure-store.test.ts
import {
	DEFAULT_THRESHOLD,
	TERMINAL_STATUSES,
	analyze,
	buildIndex,
	buildReport,
	buildToolTrace,
	fingerprint,
	fingerprintKey,
	forgetPattern,
	lookupRepeat,
	markStatus,
	mergeOccurrence,
	normalizeMessage,
	skillDraft,
	skillSlug,
	stampWorkflow,
	suggestWorkflow,
	summarizeArgs,
	truncate,
	type FailurePattern,
	type OccurrenceInput,
} from "./failure-store.ts";

declare const process: { exit(code?: number): never };

let passed = 0;
let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		console.log(`✓ ${name}`);
	} else {
		failed++;
		console.log(`✗ ${name}\n  expected: ${e}\n  actual:   ${a}`);
	}
};

const occ = (partial: Partial<OccurrenceInput> = {}): OccurrenceInput => ({
	kind: "tool",
	source: "bash",
	detail: "Command failed: exit code 1",
	trace: ["user: build the thing", "tool: bash → make"],
	cwd: "/repo",
	sessionId: "sess-1",
	at: 1000,
	...partial,
});

/* ---- normalizeMessage / fingerprint ---- */
check(
	"normalize strips numbers and paths",
	normalizeMessage("Error 42 at /Users/me/x/y.go:10"),
	"error <n> at <path>/y.go:<n>",
);
check(
	"normalize lowercases and collapses whitespace",
	normalizeMessage("  BOOM\n  thing\n"),
	"boom thing",
);
check(
	"fingerprint is stable sha1[16]",
	fingerprint({ kind: occ().kind, source: occ().source, message: occ().detail })
		.length,
	16,
);
check(
	"fingerprint differs for different sources",
	fingerprint({ kind: "tool", source: "bash", message: "x" }) !==
		fingerprint({ kind: "tool", source: "read", message: "x" }),
	true,
);
check(
	"fingerprint same for same message regardless of numbers",
	fingerprint({ kind: "tool", source: "bash", message: "exit code 1" }) ===
		fingerprint({ kind: "tool", source: "bash", message: "exit code 99" }),
	true,
);
check(
	"fingerprintKey includes normalization",
	fingerprintKey({ kind: "tool", source: "bash", message: "FAILED 7" }),
	fingerprintKey({ kind: "tool", source: "bash", message: "failed 123" }),
);

/* ---- mergeOccurrence ---- */
let list: FailurePattern[] = [];
list = mergeOccurrence(list, occ());
check("fresh pattern added with counts", list.length, 1);
check(
	"first pattern fields",
	[list[0].occurrences, list[0].sessions.length, list[0].status, list[0].detail],
	[1, 1, "new", "Command failed: exit code 1"],
);

const same = mergeOccurrence(list, occ({ sessionId: "sess-1", at: 2000 }));
check(
	"same session increments occurrences only",
	[same.length, same[0].occurrences, same[0].sessions.length],
	[1, 2, 1],
);

const other = mergeOccurrence(
	same,
	occ({ sessionId: "sess-2", detail: "Command failed: exit code 3", at: 3000 }),
);
check(
	"new session tracked (un-normalized detail still same fp)",
	[other[0].occurrences, other[0].sessions.length],
	[3, 2],
);
check(
	"message keeps first-seen normalization",
	other[0].message,
	"command failed: exit code <n>",
);

// -- subagent runId dedupe --
const withRun = mergeOccurrence(
	[],
	occ({ kind: "subagent", source: "worker", runId: "run-1" }),
);
check("subagent record added", withRun.length, 1);
check(
	"re-ingesting same runId is a no-op",
	mergeOccurrence(
		withRun,
		occ({ kind: "subagent", source: "worker", runId: "run-1", at: 9000 }),
	).length,
	1,
);

// -- trace dedupe + cap --
let tlist: FailurePattern[] = [];
const t1 = occ({ sessionId: "s1", trace: ["a", "b", "c"], at: 1 });
tlist = mergeOccurrence(tlist, t1);
tlist = mergeOccurrence(tlist, { ...t1, at: 2 });
check("identical trace deduped", tlist[0].traces.length, 1);
for (let i = 0; i < 6; i++) {
	tlist = mergeOccurrence(
		tlist,
		occ({ sessionId: `sn${i}`, trace: [`trace ${i}`], at: 100 + i }),
	);
}
check("traces capped at MAX_TRACES", tlist[0].traces.length, 3);

// -- cap on patterns (drop oldest) --
let big: FailurePattern[] = [];
for (let i = 0; i < 1005; i++) {
	big = mergeOccurrence(
		big,
		occ({ source: `tool${i}`, detail: `fail ${i}`, sessionId: `s${i}`, at: i }),
	);
}
check(
	"pattern list capped at 1000 (oldest dropped)",
	[big.length, big[0].source],
	[1000, "tool5"],
);

/* ---- analyze / threshold ---- */
const withSessions = [
	{ ...occ(), sessionId: "a", at: 1 },
	{ ...occ({ detail: "seed", at: 2 }), sessionId: "b" },
	{ ...occ({ detail: "seed", at: 3 }), sessionId: "c" },
	{ ...occ({ source: "once", detail: "one-off", at: 4 }), sessionId: "d" },
].reduce((acc, o) => mergeOccurrence(acc, o), [] as FailurePattern[]);

const analysis = analyze(withSessions, DEFAULT_THRESHOLD);
const seed = analysis.find(
	(a) => a.pattern.source === "bash" && a.pattern.message.includes("seed"),
)!;
const one = analysis.find((a) => a.pattern.source === "once")!;
check("3-session repeat is a candidate", seed.repeat, true);
check("single-session pattern not a candidate", one.repeat, false);
check("candidates sort before non-candidates", analysis[0].repeat, true);

// -- terminal statuses stop recommendations --
const resolved = markStatus(withSessions, seed.pattern.fingerprint, "resolved");
const ra = analyze(resolved, DEFAULT_THRESHOLD);
check(
	"resolved pattern no longer recommended",
	ra.find((a) => a.pattern.status === "resolved")!.repeat,
	false,
);
check(
	"resolved keeps session count",
	ra.find((a) => a.pattern.status === "resolved")!.sessions,
	2,
);

/* ---- workflow hints (R3) ---- */
const hintCases: Array<
	[string, Parameters<typeof suggestWorkflow>[0], string | null]
> = [
	["subagent runs → bugfix", { kind: "subagent", source: "worker" }, "bugfix"],
	["run_test failures → bugfix", { kind: "tool", source: "run_test" }, "bugfix"],
	["other tool failures → no hint", { kind: "tool", source: "bash" }, null],
];
for (const [name, input, expected] of hintCases) {
	check(`suggestWorkflow: ${name}`, suggestWorkflow(input), expected);
}

const stamped = stampWorkflow(withSessions, seed.pattern.fingerprint, "bugfix");
check(
	"stampWorkflow attaches hint",
	stamped.find((p) => p.fingerprint === seed.pattern.fingerprint)?.workflow,
	"bugfix",
);
check(
	"stampWorkflow unknown fp is no-op",
	stampWorkflow(withSessions, "nope", "swat").length,
	withSessions.length,
);

/* ---- lookupRepeat (auto-nudge bridge, R2) ---- */
const repeatSeed = mergeOccurrence([], {
	kind: "tool",
	source: "run_test",
	detail: "Assertion failed: expected 2 to equal 3",
	trace: [],
	cwd: "/repo",
	sessionId: "sess-1",
	at: 1000,
});
const repeatStore = mergeOccurrence(repeatSeed, {
	kind: "tool",
	source: "run_test",
	detail: "Assertion failed: expected 2 to equal 3",
	trace: [],
	cwd: "/repo",
	sessionId: "sess-2",
	at: 2000,
});
const hit = lookupRepeat(
	repeatStore,
	"tool",
	"run_test",
	"Assertion failed: expected 2 to equal 3",
);
check(
	"lookupRepeat finds repeat candidate",
	hit?.pattern.fingerprint,
	fingerprint({
		kind: "tool",
		source: "run_test",
		message: "Assertion failed: expected 2 to equal 3",
	}),
);
check("lookupRepeat suggests bugfix for run_test", hit?.workflow, "bugfix");
check(
	"lookupRepeat null for unknown",
	lookupRepeat(repeatStore, "tool", "bash", "Command failed: exit code 1"),
	null,
);
check(
	"lookupRepeat null below threshold (single session)",
	lookupRepeat(
		repeatSeed,
		"tool",
		"run_test",
		"Assertion failed: expected 2 to equal 3",
	),
	null,
);

/* ---- markStatus / forgetPattern ---- */
check(
	"markStatus unknown fp is no-op",
	markStatus(withSessions, "nope", "resolved").length,
	withSessions.length,
);
const mk = markStatus(
	withSessions,
	seed.pattern.fingerprint,
	"skill-created",
	"my-skill",
);
check(
	"markStatus sets status + skillName",
	[
		mk.find((p) => p.fingerprint === seed.pattern.fingerprint)!.status,
		mk.find((p) => p.fingerprint === seed.pattern.fingerprint)!.skillName,
	],
	["skill-created", "my-skill"],
);
check(
	"false-positive sets no resolution fields",
	markStatus(withSessions, seed.pattern.fingerprint, "false-positive").find(
		(p) => p.fingerprint === seed.pattern.fingerprint,
	)?.resolvedAt,
	undefined,
);
check(
	"markStatus with resolution records resolvedAt + note",
	(() => {
		const p = markStatus(
			withSessions,
			seed.pattern.fingerprint,
			"resolved",
			undefined,
			"swapped the flag order",
			1234,
		).find((x) => x.fingerprint === seed.pattern.fingerprint)!;
		return [p.status, p.resolvedAt, p.resolution];
	})(),
	["resolved", 1234, "swapped the flag order"],
);
check(
	"markStatus without resolution keeps prior resolution",
	(() => {
		const once = markStatus(
			withSessions,
			seed.pattern.fingerprint,
			"resolved",
			undefined,
			"fix text",
			1234,
		);
		return markStatus(
			once,
			seed.pattern.fingerprint,
			"skill-created",
			"sk",
			undefined,
			5678,
		).find((x) => x.fingerprint === seed.pattern.fingerprint)!.resolution;
	})(),
	"fix text",
);
check(
	"forgetPattern removes",
	forgetPattern(withSessions, seed.pattern.fingerprint).find(
		(p) => p.fingerprint === seed.pattern.fingerprint,
	),
	undefined,
);
check(
	"TERMINAL_STATUSES covers all terminal states",
	["skill-created", "resolved", "false-positive"].every((s) =>
		TERMINAL_STATUSES.includes(s as never),
	),
	true,
);

/* ---- buildReport ---- */
const rep = buildReport(analysis, DEFAULT_THRESHOLD);
check("report has summary line", rep.includes("**Summary:**"), true);
check(
	"report flags repeat candidates",
	rep.includes("Repeat candidates"),
	true,
);
check("report lists reported patterns", rep.includes("Reported"), true);
check("report includes a trace", rep.includes("Latest trace"), true);

/* ---- skill drafting ---- */
const slug = skillSlug("bash", "command not found: make");
check("skillSlug slugs", slug, "bash-command-not-found-make");
const draft = skillDraft(slug, seed);
check("skillDraft has frontmatter", draft.startsWith("---\nname: bash"), true);
check(
	"skillDraft embeds occurrences",
	draft.includes("failure(s) across"),
	true,
);

/* ---- buildIndex (cross-session index with session-note links) ---- */
const idx = buildIndex(analysis, DEFAULT_THRESHOLD, (sid) =>
	sid === "sess-1" ? `/notes/${sid}/CURRENT.md` : null,
);
// analysis here is computed over `withSessions` which used custom session ids
// (a/b/c/d), so re-derive from those sessions to get a deterministic index.
const idxFromCustom = buildIndex(
	analyze(withSessions, DEFAULT_THRESHOLD),
	DEFAULT_THRESHOLD,
	(sid) => (sid === "a" ? `/mem/a/CURRENT.md` : null),
);
check(
	"index links only sessions that have notes",
	[
		idxFromCustom.includes("[notes](/mem/a/CURRENT.md)"),
		idxFromCustom.includes("[notes](/mem/b/CURRENT.md)"),
	],
	[true, false],
);
check(
	"index shows repeat section but omits empty closed section",
	[
		idxFromCustom.includes("Repeat candidates"),
		idxFromCustom.includes("Closed"),
	],
	[true, false],
);
// resolution surfaces in the index for closed patterns
const idxRes = buildIndex(
	analyze(
		markStatus(
			withSessions,
			seed.pattern.fingerprint,
			"resolved",
			undefined,
			"reordered the keys",
		),
		DEFAULT_THRESHOLD,
	),
	DEFAULT_THRESHOLD,
);
check(
	"index embeds resolution note for closed patterns",
	idxRes.includes("Resolution:** reordered the keys"),
	true,
);
check(
	"index has summary header",
	idx.startsWith("# Failure Learning Index"),
	true,
);

/* ---- trace extraction ---- */
const entries = [
	{
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: "please build\nit now" }],
		},
	},
	{ type: "message", message: { role: "assistant", content: [] } },
	{
		type: "message",
		message: { role: "toolResult", name: "bash", content: "ok" },
	},
];
const trace = buildToolTrace(
	entries,
	"bash",
	"Command failed: exit code 1",
	"make",
);
check(
	"trace includes user prompt (first line)",
	trace.some((l) => l.startsWith("user:")),
	true,
);
check(
	"trace includes failed tool",
	trace.some((l) => l.startsWith("failed: bash")),
	true,
);
check(
	"trace includes error line",
	trace.some((l) => l.startsWith("error:")),
	true,
);
check("trace bounded", trace.length <= 8, true);

/* ---- helpers ---- */
check("truncate appends ellipsis", truncate("abcdefgh", 4), "abc…");
check("truncate short passthrough", truncate("ab", 4), "ab");
check(
	"summarizeArgs string normalized",
	summarizeArgs("  make  clean \n"),
	"make clean",
);
check("summarizeArgs object json", summarizeArgs({ a: 1 }), '{"a":1}');
check("summarizeArgs null", summarizeArgs(null), "");

/* ---- summary ---- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
