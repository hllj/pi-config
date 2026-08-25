// Pure, dependency-free rendering for the live workflow TUI widget.
//
// Split out of index.ts so it is unit-testable without importing the whole
// extension (index.ts pulls in @earendil-works modules not present in a bare
// test workspace). updateWorkflowWidget() in index.ts is the thin UI hook that
// calls buildWorkflowWidgetLines()/buildWorkflowStatus() and pushes the result
// to ctx.ui.

import type { WorkflowState } from "./workflow-engine.ts";

/**
 * Truncate a string so its length <= n (in code points), appending an ellipsis.
 * Code-point aware: a cut inside an astral-plane character would otherwise
 * leave a lone surrogate half, so we slice over Array.from (code points) rather
 * than UTF-16 code units.
 */
export function truncate(s: string, n: number): string {
	const chars = Array.from(s);
	return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s;
}

/** Format elapsed ms the same way index.ts's formatElapsed does (injectable `now` for tests). */
function formatElapsed(startedAt: number, now: number): string {
	const ms = now - startedAt;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

const STATUS_ICONS: Record<WorkflowState["results"][number]["status"], string> =
	{
		completed: "✓",
		failed: "✗",
		skipped: "⊘",
		running: "⏳",
		waiting_approval: "⏸",
		pending: "○",
	};

/** One line per step: status icon followed by `{agent} — {task}` (truncated to ~80 chars). */
function stepLine(
	agent: string,
	task: string,
	status: WorkflowState["results"][number]["status"],
): string {
	return truncate(`${STATUS_ICONS[status]} ${agent} — ${task}`, 80);
}

/**
 * Build the plain-text widget lines (uncolored — UiHooks has no theme) for a
 * workflow state: a "current task" line (running steps; or the waiting step
 * when paused with nothing running), a "Tasks (N) — name" header, one icon +
 * agent — task line per step, and a final summary. Returns [] when the
 * workflow has no steps (widget should be omitted).
 */
export function buildWorkflowWidgetLines(
	state: WorkflowState,
	now: number = Date.now(),
): string[] {
	const results = state.results ?? [];
	if (results.length === 0 || (state.steps?.length ?? 0) === 0) return [];

	const lines: string[] = [];

	// Current-task line(s): one per running step (parallel groups), or the
	// waiting_approval step when paused with nothing running. These too are
	// truncated to 80 (like step lines) so a long agent/task name can't overflow
	// the widget.
	const running = results.filter((r) => r.status === "running");
	if (running.length > 0) {
		for (const r of running) {
			lines.push(
				truncate(
					`Current task running: ${r.step.agent} — ${r.step.task} (${formatElapsed(r.startTime ?? state.startTime, now)})`,
					80,
				),
			);
		}
	} else if (state.status === "paused") {
		const waiting = results.find((r) => r.status === "waiting_approval");
		if (waiting) {
			lines.push(
				truncate(
					`Current task waiting: ${waiting.step.agent} — ${waiting.step.task}`,
					80,
				),
			);
		}
	}

	// Header.
	let header = `Tasks (${state.steps.length})`;
	if (state.name) header += ` — ${state.name}`;
	lines.push(header);

	// One line per step, in stepIndex order.
	for (const r of results) {
		lines.push(stepLine(r.step.agent, r.step.task, r.status));
	}

	// Final summary: completed/pending counts; failed/skipped appended when > 0.
	const completed = results.filter((r) => r.status === "completed").length;
	const pending = results.filter(
		(r) => r.status === "pending" || r.status === "waiting_approval",
	).length;
	const failed = results.filter((r) => r.status === "failed").length;
	const skipped = results.filter((r) => r.status === "skipped").length;
	let summary = `${completed} completed / ${pending} pending`;
	if (failed > 0) summary += `, ${failed} failed`;
	if (skipped > 0) summary += `, ${skipped} skipped`;
	lines.push(summary);

	return lines;
}

/** Footer status string: `wf:{completed}/{steps.length}` while any step is running, else "". */
export function buildWorkflowStatus(state: WorkflowState): string {
	const results = state.results ?? [];
	if ((state.steps?.length ?? 0) === 0) return "";
	const runningCount = results.filter((r) => r.status === "running").length;
	if (runningCount === 0) return "";
	const completed = results.filter((r) => r.status === "completed").length;
	return `wf:${completed}/${state.steps.length}`;
}

// Re-export the WorkflowState type so index.ts can import it alongside the
// build helpers when it already imports from workflow-engine.ts.
export type { WorkflowState };
