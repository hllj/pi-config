/**
 * Tests for the todo-list widget/status builders in todo-widget.ts.
 * Runs with native node type-stripping: `node todo-widget.test.ts`
 */
import {
	buildTodoListWidget,
	buildTodoStatus,
	isValidTodoDetails,
	snapshotTodos,
	type TodoWidgetTheme,
} from "./todo-widget.ts";

declare const process: { exit(code?: number): never };

// Recording theme: fg returns `<color>text</color>`, strikethrough wraps in `⟨⟩`
const theme: TodoWidgetTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	strikethrough: (t) => `⟨${t}⟩`,
};

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`✓ ${name}`);
	} else {
		failed++;
		console.log(`✗ ${name}\n  expected: ${e}\n  actual:   ${a}`);
	}
}

// ---- widget: empty list hides widget and clears status ----
check("empty todos -> no widget lines", buildTodoListWidget([], theme), []);
check("empty todos -> no status", buildTodoStatus([], theme), undefined);

// ---- widget: single pending task ----
const singlePending = [{ id: 1, text: "Buy milk", done: false }];
check("single pending task lines", buildTodoListWidget(singlePending, theme), [
	"Current task: Buy milk",
	"Task list (1 task):",
	`  ${theme.fg("dim", "○ ")}Buy milk`,
	`${theme.fg("accent", "+1")} pending, ${theme.fg("success", "0 completed")}`,
]);

// ---- status for pending ----
check("single pending status", buildTodoStatus(singlePending, theme), "📋 0/1");

// ---- widget: first pending wins for current task (completed items at front are skipped) ----
const mixed = [
	{ id: 1, text: "Old", done: true },
	{ id: 2, text: "Active", done: false },
];
check(
	"current task picks first pending, not first item",
	buildTodoListWidget(mixed, theme),
	[
		"Current task: Active",
		"Task list (2 tasks):",
		`  ${theme.fg("success", "✓ ")}${theme.fg("muted", theme.strikethrough("Old"))}`,
		`  ${theme.fg("dim", "○ ")}Active`,
		`${theme.fg("accent", "+1")} pending, ${theme.fg("success", "1 completed")}`,
	],
);

// ---- widget: all completed -> current task None ----
const allDone = [{ id: 1, text: "Old", done: true }];
check(
	"all completed -> current task None",
	buildTodoListWidget(allDone, theme),
	[
		"Current task: None",
		"Task list (1 task):",
		`  ${theme.fg("success", "✓ ")}${theme.fg("muted", theme.strikethrough("Old"))}`,
		`${theme.fg("accent", "+0")} pending, ${theme.fg("success", "1 completed")}`,
	],
);

// ---- widget: more than 5 items -> cap at 5 with '+N more' ----
const many = Array.from({ length: 7 }, (_, i) => ({
	id: i + 1,
	text: `Task ${i + 1}`,
	done: false,
}));
const manyLines = buildTodoListWidget(many, theme);
check(
	"many items capped at 5",
	manyLines.filter((l) => l.startsWith(`  ${theme.fg("dim", "○ ")}`)).length,
	5,
);
check(
	"many items -> +2 more line",
	manyLines.includes(`${theme.fg("dim", "+2 more")}`),
	true,
);
check(
	"many items summary counts",
	manyLines[manyLines.length - 1],
	`${theme.fg("accent", "+7")} pending, ${theme.fg("success", "0 completed")}`,
);
check("many items status", buildTodoStatus(many, theme), "📋 0/7");

// ---- status counts completed/total ----
const halfDone = [
	{ id: 1, text: "a", done: true },
	{ id: 2, text: "b", done: false },
	{ id: 3, text: "c", done: true },
];
check("status 2/3", buildTodoStatus(halfDone, theme), "📋 2/3");

// ---- linked background task markers ----
const linkedRunning = [
	{ id: 1, text: "npm run build", done: false, taskStatus: "running" },
];
check(
	"pending + running task -> ⏳ bullet",
	buildTodoListWidget(linkedRunning, theme),
	[
		"Current task: npm run build",
		"Task list (1 task):",
		`  ${theme.fg("accent", "⏳ ")}npm run build`,
		`${theme.fg("accent", "+1")} pending, ${theme.fg("success", "0 completed")}`,
	],
);

const linkedFailed = [
	{ id: 1, text: "lint", done: false, taskStatus: "failed" },
];
check(
	"pending + failed task -> ⚠ bullet",
	buildTodoListWidget(linkedFailed, theme),
	[
		"Current task: lint",
		"Task list (1 task):",
		`  ${theme.fg("warning", "⚠ ")}lint`,
		`${theme.fg("accent", "+1")} pending, ${theme.fg("success", "0 completed")}`,
	],
);

const doneLinkedFailed = [
	{ id: 1, text: "lint", done: true, taskStatus: "failed" },
];
check(
	"done + failed task -> warning suffix",
	buildTodoListWidget(doneLinkedFailed, theme),
	[
		"Current task: None",
		"Task list (1 task):",
		`  ${theme.fg("success", "✓ ")}${theme.fg("muted", theme.strikethrough("lint"))}${theme.fg("warning", " ⚠")}`,
		`${theme.fg("accent", "+0")} pending, ${theme.fg("success", "1 completed")}`,
	],
);

const doneLinkedOk = [
	{ id: 1, text: "lint", done: true, taskStatus: "completed" },
];
check(
	"done + completed task -> no warning suffix",
	buildTodoListWidget(doneLinkedOk, theme),
	[
		"Current task: None",
		"Task list (1 task):",
		`  ${theme.fg("success", "✓ ")}${theme.fg("muted", theme.strikethrough("lint"))}`,
		`${theme.fg("accent", "+0")} pending, ${theme.fg("success", "1 completed")}`,
	],
);

// ---- details validity guard (regression: validation-error results have `details: {}`) ----
check("empty details object -> invalid", isValidTodoDetails({}), false);
check("undefined details -> invalid", isValidTodoDetails(undefined), false);
check("null details -> invalid", isValidTodoDetails(null), false);
check(
	"todos: null -> invalid",
	isValidTodoDetails({ action: "list", todos: null }),
	false,
);
check(
	"todos not an array -> invalid",
	isValidTodoDetails({ action: "list", todos: "x" }),
	false,
);
check(
	"valid add snapshot -> valid",
	isValidTodoDetails({
		action: "add",
		todos: [{ id: 1, text: "x", done: false }],
	}),
	true,
);

// ---- snapshot independence (regression: parallel tool results must not
// share Todo object references, or all results would serialize as the same
// final mutated state instead of the state at each call's return) ----
const live = [
	{ id: 1, text: "A", done: false },
	{ id: 2, text: "B", done: false },
];
const snap = snapshotTodos(
	live as { id: number; text: string; done: boolean }[],
);
check("snapshot has same items", snap, live);
check("snapshot is a new array", snap !== live, true);
check("snapshot items are new objects", snap[0] !== live[0], true);
check(
	"mutating source does not leak into snapshot (deep copy)",
	(() => {
		live[0].done = true;
		return snap[0].done;
	})(),
	false,
);

if (failed > 0) {
	console.error(`\n${failed} test(s) FAILED`);
	process.exit(1);
}
console.log("\nAll tests passed");
