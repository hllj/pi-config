/**
 * Workflow TUI Renderer
 *
 * Custom renderer for workflow state with:
 * - DAG rendering with status icons (✓⏳⏸✗↺)
 * - Collapsed/expanded views
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { WorkflowState, WorkflowStepResult } from "./workflow-engine.ts";

export interface ThemeAPI {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * Get status icon for a step
 */
function getStatusIcon(status: string, theme: ThemeAPI): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "running":
			return theme.fg("warning", "⏳");
		case "waiting_approval":
			return theme.fg("warning", "⏸");
		case "failed":
			return theme.fg("error", "✗");
		case "skipped":
			return theme.fg("muted", "⊘");
		case "pending":
			return theme.fg("dim", "○");
		default:
			return theme.fg("dim", "?");
	}
}

/**
 * Render workflow state in collapsed view
 */
export function renderWorkflowCollapsed(
	state: WorkflowState,
	theme: ThemeAPI,
): Text {
	const statusIcon = getStatusIcon(state.status, theme);
	const completed = state.results.filter((r) => r.status === "completed").length;
	const failed = state.results.filter((r) => r.status === "failed").length;
	const running = state.results.filter((r) => r.status === "running").length;

	let text = `${statusIcon} Workflow ${theme.fg("accent", state.name ?? state.id)}`;
	text += ` ${theme.fg("dim", `[${completed}/${state.steps.length}]`)}`;

	if (failed > 0) text += ` ${theme.fg("error", `${failed} failed`)}`;
	if (running > 0) text += ` ${theme.fg("warning", `${running} running`)}`;

	// Show first few steps
	for (const result of state.results.slice(0, 3)) {
		const icon = getStatusIcon(result.status, theme);
		text += `\n  ${icon} ${theme.fg("accent", result.step.agent)}`;
		if (result.status === "running") text += theme.fg("dim", " (in progress...)");
		if (result.retryCount && result.retryCount > 0) {
			text += ` ${theme.fg("warning", `[retry ${result.retryCount}]`)}`;
		}
	}

	if (state.steps.length > 3) {
		text += `\n  ${theme.fg("muted", `... +${state.steps.length - 3} more steps (Ctrl+O to expand)`)}`;
	}

	return new Text(text, 0, 0);
}

/**
 * Render workflow state in expanded view
 */
export function renderWorkflowExpanded(
	state: WorkflowState,
	theme: ThemeAPI,
): Container {
	const container = new Container();

	const statusIcon = getStatusIcon(state.status, theme);
	const completed = state.results.filter((r) => r.status === "completed").length;

	let header = `${statusIcon} Workflow ${theme.fg("accent", theme.bold(state.name ?? state.id))}`;
	header += ` ${theme.fg("dim", `[${completed}/${state.steps.length} steps]`)}`;
	container.addChild(new Text(header, 0, 0));

	const duration = state.endTime
		? state.endTime - state.startTime
		: Date.now() - state.startTime;
	container.addChild(
		new Text(
			theme.fg(
				"dim",
				`Status: ${state.status} | Duration: ${Math.round(duration / 1000)}s`,
			),
			0,
			0,
		),
	);

	if (state.error) {
		container.addChild(
			new Text(theme.fg("error", `Error: ${state.error}`), 0, 0),
		);
	}

	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Steps ───"), 0, 0));

	for (const result of state.results) {
		container.addChild(new Spacer(1));

		const icon = getStatusIcon(result.status, theme);
		const groupPrefix = result.step.parallelGroup
			? theme.fg("muted", `‖ ${result.step.parallelGroup} `)
			: "";
		let stepText = `${icon} ${groupPrefix}${theme.fg("accent", theme.bold(result.step.agent))}`;

		if (result.status === "running")
			stepText += theme.fg("warning", " (running)");
		if (result.retryCount && result.retryCount > 0) {
			stepText += ` ${theme.fg("warning", `[retry ${result.retryCount}]`)}`;
		}

		container.addChild(new Text(stepText, 0, 0));
		container.addChild(
			new Text(theme.fg("dim", `Task: ${result.step.task}`), 0, 0),
		);

		if (result.step.condition) {
			const condText = `${result.step.condition.type}: ${result.step.condition.value}`;
			container.addChild(
				new Text(theme.fg("muted", `Condition: ${condText}`), 0, 0),
			);
		}

		if (result.step.errorHandler) {
			const ehText = `Strategy: ${result.step.errorHandler.strategy}`;
			container.addChild(
				new Text(theme.fg("muted", `Error handler: ${ehText}`), 0, 0),
			);
		}

		if (result.step.requiresApproval) {
			container.addChild(
				new Text(
					theme.fg(
						"warning",
						`⏸ Requires approval (granted: ${result.approvalGranted ?? false})`,
					),
					0,
					0,
				),
			);
		}

		if (result.output && result.status === "completed") {
			const preview =
				result.output.length > 200
					? `${result.output.slice(0, 200)}...`
					: result.output;
			container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
		}

		if (result.error) {
			container.addChild(
				new Text(theme.fg("error", `Error: ${result.error}`), 0, 0),
			);
		}

		if (result.startTime && result.endTime) {
			const stepDuration = result.endTime - result.startTime;
			container.addChild(
				new Text(
					theme.fg("dim", `Duration: ${Math.round(stepDuration / 1000)}s`),
					0,
					0,
				),
			);
		}
	}

	return container;
}

/**
 * Render a single workflow step result
 */
export function renderStepResult(
	result: WorkflowStepResult,
	theme: ThemeAPI,
): Container {
	const container = new Container();

	const icon = getStatusIcon(result.status, theme);
	let header = `${icon} Step ${result.stepIndex + 1}: ${theme.fg("accent", theme.bold(result.step.agent))}`;
	if (result.retryCount && result.retryCount > 0) {
		header += ` ${theme.fg("warning", `[retry ${result.retryCount}]`)}`;
	}

	container.addChild(new Text(header, 0, 0));
	container.addChild(
		new Text(theme.fg("dim", `Task: ${result.step.task}`), 0, 0),
	);

	if (result.output) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		container.addChild(new Text(theme.fg("toolOutput", result.output), 0, 0));
	}

	if (result.error) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("error", `Error: ${result.error}`), 0, 0),
		);
	}

	return container;
}
