// Unit tests for subagent/workflow-widget.ts (the live workflow TUI widget).
//
// Run via run-widget.sh (an isolated NO_MODULES workspace — workflow-widget.ts
// is dependency-free, so no @earendil-works modules are needed), or directly:
//   cd <workdir-with-workflow-widget.ts> && node workflow-widget.test.mjs
//
// This exercises the pure template rendering (Task header, per-step status
// icons, current-task line, summary, footer status) that updateWorkflowWidget()
// pushes into the TUI.

import {
	buildWorkflowWidgetLines,
	buildWorkflowStatus,
	truncate,
} from "./workflow-widget.ts";

let passed = 0;
let failed = 0;
const fail = (n, m) => {
	failed++;
	console.log(`  ✗ ${n}: ${m}`);
};
const ok = (n) => {
	passed++;
	console.log(`  ✓ ${n}`);
};

// Minimal state builders (plain data — mirrors workflow-engine.ts shapes).
const step = (agent, task) => ({ agent, task });

const state0 = () => ({
	id: "wf-1",
	name: "build pipeline",
	steps: [
		step("scout", "scan"),
		step("writer", "write"),
		step("editor", "edit"),
	],
	results: [
		{ step: step("scout", "scan"), stepIndex: 0, status: "completed" },
		{
			step: step("writer", "write"),
			stepIndex: 1,
			status: "running",
			startTime: 1000,
		},
		{ step: step("editor", "edit"), stepIndex: 2, status: "pending" },
	],
	currentStepIndex: 1,
	status: "running",
	startTime: 1000,
});

const T0 = 2000; // injected "now" so the widget is deterministic

const linesFor = (s) => buildWorkflowWidgetLines(s, T0);

console.log("== widget header ==");
{
	const lines = linesFor(state0());
	if (lines[0] === "Current task running: writer — write (1.0s)")
		ok("current-task line for running step (formatElapsed on startTime)");
	else fail("running line", JSON.stringify(lines[0]));
	if (lines[1] === "Tasks (3) — build pipeline")
		ok("header Tasks (N) + workflow name");
	else fail("header", JSON.stringify(lines[1]));
}

console.log(
	"== per-step icons (running/pending/completed/skipped/failed/waiting) ==",
);
{
	const s = state0();
	const L = linesFor(s);
	if (L.some((l) => l === "✓ scout — scan")) ok("completed icon ✓");
	else fail("completed icon", JSON.stringify(L));
	if (L.some((l) => l === "⏳ writer — write")) ok("running icon ⏳");
	else fail("running icon", JSON.stringify(L));
	if (L.some((l) => l === "○ editor — edit")) ok("pending icon ○");
	else fail("pending icon", JSON.stringify(L));

	const failed = {
		...s,
		results: [{ step: step("scout", "read"), stepIndex: 0, status: "failed" }],
	};
	if (linesFor(failed).some((l) => l === "✗ scout — read")) ok("failed icon ✗");
	else fail("failed icon", JSON.stringify(linesFor(failed)));

	const skipped = {
		...s,
		results: [{ step: step("scout", "read"), stepIndex: 0, status: "skipped" }],
	};
	if (linesFor(skipped).some((l) => l === "⊘ scout — read"))
		ok("skipped icon ⊘");
	else fail("skipped icon", JSON.stringify(linesFor(skipped)));

	const waiting = {
		...s,
		status: "paused",
		results: [
			{ step: step("scout", "read"), stepIndex: 0, status: "pending" },
			{
				step: step("writer", "write"),
				stepIndex: 1,
				status: "waiting_approval",
			},
		],
	};
	const wLines = linesFor(waiting);
	if (wLines.some((l) => l === "⏸ writer — write"))
		ok("waiting_approval icon ⏸");
	else fail("waiting icon", JSON.stringify(wLines));
}

console.log("== current-task waiting when paused with no running ==");
{
	const waiting = {
		id: "wf-2",
		name: undefined,
		steps: [step("scout", "read"), step("writer", "write")],
		results: [
			{ step: step("scout", "read"), stepIndex: 0, status: "pending" },
			{ step: step("writer", "write"), stepIndex: 1, status: "waiting_approval" },
		],
		currentStepIndex: 1,
		status: "paused",
		startTime: 500,
	};
	const L = buildWorkflowWidgetLines(waiting, T0);
	if (L[0] === "Current task waiting: writer — write")
		ok("waiting line emitted when paused with no running step");
	else fail("waiting line", JSON.stringify(L[0]));
	if (L[1] === "Tasks (2)") ok("waiting header without workflow name");
	else fail("waiting header", JSON.stringify(L[1]));
}

console.log("== summary line ==");
{
	// running state from state0: 1 completed, 1 pending (running step uncounted)
	const s = state0();
	const summary = buildWorkflowWidgetLines(s, T0).at(-1);
	if (summary === "1 completed / 1 pending")
		ok("summary completed/pending excludes running");
	else fail("summary excludes running", JSON.stringify(summary));

	const done = {
		...state0(),
		status: "completed",
		results: [
			{ step: step("scout", "read"), stepIndex: 0, status: "completed" },
			{ step: step("writer", "write"), stepIndex: 1, status: "completed" },
			{ step: step("editor", "edit"), stepIndex: 2, status: "skipped" },
		],
	};
	const doneSummary = buildWorkflowWidgetLines(done).at(-1);
	if (doneSummary === "2 completed / 0 pending, 1 skipped")
		ok("summary counts skipped out of completed/pending, appends skipped");
	else fail("skipped summary", JSON.stringify(doneSummary));

	const err = {
		...state0(),
		status: "failed",
		results: [
			{ step: step("scout", "read"), stepIndex: 0, status: "completed" },
			{ step: step("writer", "write"), stepIndex: 1, status: "failed" },
			{ step: step("editor", "edit"), stepIndex: 2, status: "pending" },
		],
	};
	const errSummary = buildWorkflowWidgetLines(err).at(-1);
	if (errSummary === "1 completed / 1 pending, 1 failed")
		ok("summary includes failed count");
	else fail("failed summary", JSON.stringify(errSummary));
}

console.log("== footer status string ==");
{
	if (
		buildWorkflowStatus({
			...state0(),
		}) === "wf:1/3"
	)
		ok("running workflow footer wf:completed/steps");
	else
		fail(
			"running footer",
			buildWorkflowStatus({
				...state0(),
			}),
		);
	const done = {
		...state0(),
		status: "completed",
		results: [
			{ step: step("scout", "read"), stepIndex: 0, status: "completed" },
			{ step: step("writer", "write"), stepIndex: 1, status: "completed" },
			{ step: step("editor", "edit"), stepIndex: 2, status: "completed" },
		],
	};
	if (buildWorkflowStatus(done) === "") ok("no running -> empty footer");
	else fail("empty footer", buildWorkflowStatus(done));
}

console.log("== truncate ==");
{
	if (truncate("abcdefghij", 10) === "abcdefghij") ok("short string unchanged");
	else fail("short", truncate("abcdefghij", 10));
	if (truncate("abcdefghij", 9) === "abcdefgh…")
		ok("truncate slices to n-1 and appends ellipsis");
	else fail("truncate", truncate("abcdefghijk", 9));
	// Code-point aware: slicing at a boundary must not split an astral-plane
	// surrogate pair. "a😀bc" is 4 code points; truncating to 3 must cut
	// between the emoji and 'b', not mid-emoji.
	if (truncate("a😀bc", 3) === "a😀…")
		ok("truncate does not split a surrogate pair");
	else fail("surrogate-safe", JSON.stringify(truncate("a😀bc", 3)));
}

console.log("== long running/waiting current-task lines truncated to 80 ==");
{
	const longName = "averylongagentname".repeat(8); // far past 80
	const s = {
		...state0(),
		results: [
			{
				step: step(longName, "task"),
				stepIndex: 0,
				status: "running",
				startTime: 1000,
			},
		],
	};
	const L = buildWorkflowWidgetLines(s, T0);
	if (L[0].length <= 80 && L[0].endsWith("…"))
		ok("running line truncated to <=80 with ellipsis");
	else
		fail(
			"running line truncation",
			JSON.stringify(L[0]) + ` (len=${L[0].length})`,
		);

	const w = {
		...state0(),
		status: "paused",
		results: [
			{ step: step("scout", "read"), stepIndex: 0, status: "pending" },
			{
				step: step(longName, "task"),
				stepIndex: 1,
				status: "waiting_approval",
			},
		],
	};
	const Lw = buildWorkflowWidgetLines(w, T0);
	if (Lw[0].length <= 80 && Lw[0].endsWith("…"))
		ok("waiting line truncated to <=80 with ellipsis");
	else
		fail(
			"waiting line truncation",
			JSON.stringify(Lw[0]) + ` (len=${Lw[0].length})`,
		);
}

console.log("== empty steps ==");
{
	const empty = { ...state0(), steps: [], results: [] };
	const lines = buildWorkflowWidgetLines(empty, T0);
	if (Array.isArray(lines) && lines.length === 0) ok("empty steps -> no widget");
	else fail("empty", JSON.stringify(lines));
}

console.log("");
console.log(`SUITE: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
