/**
 * Tests for the todo-list widget/status builders in todo-widget.ts.
 * Runs with native node type-stripping: `node todo-widget.test.ts`
 */
import {
	buildTodoListWidget,
	buildTodoStatus,
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

if (failed > 0) {
	console.error(`\n${failed} test(s) FAILED`);
	process.exit(1);
}
console.log("\nAll tests passed");
