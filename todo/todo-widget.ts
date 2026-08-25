/**
 * Pure, dependency-free builders for the todo-list widget/status UI.
 * Kept separate from todo.ts so this logic is unit-testable without the
 * pi runtime packages (@earendil-works/*), which are only resolvable when pi
 * loads the extension.
 */

/** Max todo items rendered in the widget above the editor. */
export const MAX_TODO_WIDGET_ITEMS = 5;

export interface TodoWidgetTheme {
	fg(color: string, text: string): string;
	strikethrough(text: string): string;
}

export interface TodoWidgetItem {
	text: string;
	done: boolean;
}

/**
 * Build the persistent widget lines shown above the editor.
 *
 * Matches the user's template:
 *   Current task: <first pending task name, or 'None'>
 *   Task list (N tasks):
 *     ○ <pending task text>            (max 5 items, '+N more' if more)
 *     ✓ <completed task text>
 *   +N pending, N completed
 *
 * Returns [] when there are no todos, mirroring setWidget(key, undefined).
 */
export function buildTodoListWidget(
	todos: TodoWidgetItem[],
	theme: TodoWidgetTheme,
): string[] {
	if (todos.length === 0) return [];

	const done = todos.filter((t) => t.done).length;
	const pending = todos.length - done;
	const firstPending = todos.find((t) => !t.done);

	const lines: string[] = [];
	lines.push(`Current task: ${firstPending ? firstPending.text : "None"}`);
	lines.push(
		`Task list (${todos.length} task${todos.length === 1 ? "" : "s"}):`,
	);

	for (const t of todos.slice(0, MAX_TODO_WIDGET_ITEMS)) {
		if (t.done) {
			lines.push(
				"  " +
					theme.fg("success", "✓ ") +
					theme.fg("muted", theme.strikethrough(t.text)),
			);
		} else {
			lines.push("  " + theme.fg("dim", "○ ") + t.text);
		}
	}
	if (todos.length > MAX_TODO_WIDGET_ITEMS) {
		lines.push(theme.fg("dim", `+${todos.length - MAX_TODO_WIDGET_ITEMS} more`));
	}
	lines.push(
		`${theme.fg("accent", `+${pending}`)} pending, ${theme.fg("success", `${done} completed`)}`,
	);

	return lines;
}

/**
 * Footer status summary, or undefined when there are no todos (clears status).
 */
export function buildTodoStatus(
	todos: TodoWidgetItem[],
	_theme: TodoWidgetTheme,
): string | undefined {
	if (todos.length === 0) return undefined;
	const done = todos.filter((t) => t.done).length;
	return `📋 ${done}/${todos.length}`;
}
