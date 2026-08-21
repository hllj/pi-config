/**
 * /runs TUI screen: tabular render of subagent run records.
 *
 * Mirrors the renderAgentsScreen pattern in index.ts (string lines + theme),
 * showing: agent, mode, status (color-coded), duration, turns, cost.
 */

import type { RunStatus } from "./session-store.ts";
import { formatDuration } from "./session-store.ts";

/** Minimal theme surface shared with renderAgentsScreen (duck-typed). */
interface ScreenTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

function statusColor(status: RunStatus): string {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
		case "orphaned":
			return "error";
		case "running":
		case "timed_out":
			return "warning";
		default:
			return "muted";
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function pad(value: string, width: number): string {
	return value.length >= width
		? value
		: value + " ".repeat(width - value.length);
}

/** One row of the /runs table (normalized from live runningAgents entries or records). */
export interface RunsTableRow {
	agent: string;
	mode: string;
	status: RunStatus;
	durationMs?: number;
	turns?: number;
	cost?: number;
}

/**
 * Render the /runs screen as string lines (for a ui.custom dialog).
 * Columns: agent, mode, status, duration, turns, cost. Footer hint row.
 */
export function renderRunsScreen(
	width: number,
	runs: RunsTableRow[],
	theme: ScreenTheme,
): string[] {
	const lines: string[] = [];
	const divider = theme.fg("borderMuted", "─".repeat(Math.min(width, 64)));
	lines.push("");
	lines.push(
		theme.fg("accent", theme.bold(" Subagent Runs ")) +
			theme.fg("muted", ` (${runs.length})`),
	);
	lines.push(divider);
	lines.push("");

	if (runs.length === 0) {
		lines.push(theme.fg("dim", "  No subagent runs recorded."));
	} else {
		const statusWidth = Math.max(
			"status".length,
			...runs.map((r) => r.status.length),
		);
		const agentWidth = Math.max(
			"agent".length,
			...runs.map((r) => Math.min(r.agent.length, 16)),
		);
		lines.push(
			theme.fg(
				"muted",
				`${pad("agent", agentWidth)}  ${pad("mode", 9)}  ${pad("status", statusWidth)}  ${pad("duration", 9)}  ${pad("turns", 5)}  cost`,
			),
		);
		lines.push(divider);
		for (const r of runs) {
			const duration = formatDuration(r.durationMs);
			const cost = r.cost && r.cost > 0 ? `$${r.cost.toFixed(4)}` : "$0";
			lines.push(
				`${theme.fg("accent", truncate(r.agent, agentWidth))}  ${theme.fg("dim", pad(r.mode, 9))}  ${theme.fg(statusColor(r.status), pad(r.status, statusWidth))}  ${pad(duration, 9)}  ${pad(String(r.turns ?? 0), 5)}  ${theme.fg("dim", cost)}`,
			);
		}
	}

	lines.push("");
	lines.push(theme.fg("dim", "  r = refresh   Esc = close"));
	lines.push("");
	return lines;
}
