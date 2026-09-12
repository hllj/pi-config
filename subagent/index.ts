/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentToolResult,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
	matchesKey,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatAgentList,
} from "./agents.ts";
import { buildExpectPromptBlock, validateStructuredOutput } from "./expect.ts";
import {
	type WatchdogFinding,
	type WatchdogStalemateState,
	type WatchdogTriggerState,
	buildWatchdogReviewTask,
	formatWatchdogSteer,
	hashWatchdogFindings,
	newWatchdogStalemateState,
	newWatchdogTriggerState,
	parseWatchdogFindings,
	recordWatchdogTool,
	resetWatchdogTriggerState,
	shouldRunWatchdog,
	trackWatchdogStalemate,
} from "./watchdog.ts";
import {
	type SubagentMessage,
	getMessages,
	getPendingMessages,
	initializeMessageStore,
	markAsDelivered,
	markAsFailed,
	sendMessage,
	setMessagePersistHook,
} from "./messaging.ts";
import {
	type WorkflowState,
	type WorkflowStep,
	type WorkflowStepResult,
	completeWorkflow,
	createWorkflowState,
	failWorkflow,
	formatBudgetNudge,
	getWorkflowSummary,
	handleStepError,
	hydrateWorkflowState,
	nextBudgetThresholdCrossed,
	pauseWorkflow,
	prepareResume,
	resumeWorkflow,
	shouldExecuteStep,
	totalWorkflowTokens,
	updateWorkflowState,
} from "./workflow-engine.ts";
import {
	renderWorkflowCollapsed,
	renderWorkflowExpanded,
} from "./workflow-renderer.ts";
import {
	buildWorkflowStatus,
	buildWorkflowWidgetLines,
} from "./workflow-widget.ts";
import {
	type RunStatus,
	type SubagentRunRecord,
	formatDuration,
	getRun,
	listRuns,
	pruneStore,
	readRunTranscript,
	reconcileOrphans,
	recordStart,
	recordUpdate,
	recordEnd,
	resolveStoreDir,
} from "./session-store.ts";
import { renderRunsScreen, type RunsTableRow } from "./runs-screen.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const PER_CONTEXT_FILE_CAP = 50 * 1024;
const RUNNING_AGENT_PRUNE_MS = 10 * 60 * 1000;
const SUBAGENTS_WIDGET_ID = "subagents";
const SUBAGENTS_STATUS_ID = "subagents";
const WORKFLOW_WIDGET_ID = "workflow";
const WORKFLOW_STATUS_ID = "workflow";
const RUNS_DEFAULT_LIMIT = 50;
const RUNS_TRANSCRIPT_MAX_MESSAGES = 30;
const RUNS_TRANSCRIPT_MAX_BYTES = 20 * 1024;
/** Parent session pointer payload caps (task + output summary). */
const SESSION_POINTER_TRUNCATE = 500;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit === undefined ? "" : startLine + limit - 1;
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	timedOut?: boolean;
	/** Parsed, schema-validated output when an `expect` contract was satisfied. */
	structuredOutput?: unknown;
	/** When an `expect` contract was set and failed, a human-readable reason. */
	expectError?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	workflow?: WorkflowState;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = Array.from({ length: items.length });
	let nextIndex = 0;
	const workers: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) {
		workers.push(
			(async (): Promise<void> => {
				while (true) {
					const current = nextIndex++;
					if (current >= items.length) return;
					results[current] = await fn(items[current], current);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback<TDetails = SubagentDetails> = (
	partial: AgentToolResult<TDetails>,
) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Session-scoped data threaded into runSingleAgent for on-disk run records. */
export interface SessionLink {
	/** Resolved subagent run store directory. */
	storeDir: string;
	/** Parent (broker) session id. */
	sessionId: string;
	/** Parent session file path. */
	sessionFile: string;
}

/**
 * Build a SessionLink from an extension context (tools and commands both expose
 * sessionManager). sessionDir may be undefined for in-memory sessions.
 */
export function buildSessionLink(sm?: {
	getSessionDir?(): string | undefined;
	getSessionId?(): string | undefined;
	getSessionFile?(): string | undefined;
}): SessionLink {
	return {
		storeDir: resolveStoreDir(sm?.getSessionDir?.()),
		sessionId: sm?.getSessionId?.() ?? "",
		sessionFile: sm?.getSessionFile?.() ?? "",
	};
}

export type RunningAgentMode = "single" | "parallel" | "chain" | "workflow";

export interface RunningAgentInfo {
	id: string;
	agent: string;
	task: string;
	step?: number;
	mode: RunningAgentMode;
	startedAt: number;
	status: "running" | "completed" | "failed" | "aborted";
	exitCode?: number;
	settledAt?: number;
	/** OS pid of the subagent pi process, once spawned. */
	pid?: number;
}

/** Minimal UI surface needed to refresh the running-subagents widget. */
export interface UiHooks {
	setWidget?: (id: string, lines?: string[]) => void;
	setStatus?: (id: string, text: string) => void;
}

/**
 * Options for a single subagent dispatch. Everything except `task` and
 * `makeDetails` is optional; when no new options are set the spawned pi
 * invocation is byte-identical to the pre-options-object behavior.
 */
interface RunAgentOptions<TDetails = SubagentDetails> {
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback<TDetails>;
	makeDetails: (results: SingleResult[]) => TDetails;
	/** Kill the subagent after this many ms. Overrides the agent frontmatter's timeoutMs. */
	timeoutMs?: number;
	/** Files (relative to cwd) whose contents are injected into the system prompt. */
	contextFiles?: string[];
	/** Output contract ({ type, jsonSchema?, description? }); validated after completion. */
	expect?: unknown;
	/** Mode label for the running-agents registry. */
	mode?: RunningAgentMode;
	/** UI hooks used to refresh the running-subagents widget. */
	ui?: UiHooks;
	/** Invoked once the subagent process has spawned. */
	onSpawn?: (info: RunningAgentInfo) => void;
	/** Invoked once the subagent has settled (completed/failed/timed out). */
	onSettled?: (info: RunningAgentInfo) => void;
	/** Session-scoped linkage (store dir + parent session) for the run record. */
	session?: SessionLink;
	/** Workflow id this dispatch belongs to (workflow mode only). */
	workflowId?: string;
	/** Extension API — used to append the parent-session pointer (pi.appendEntry). */
	pi?: ExtensionAPI;
}

/** Registry of running/finished subagent processes (drives the widget + /agents). */
const runningAgents = new Map<string, RunningAgentInfo>();
/** Registry of known workflows (drives get_workflow / resume_workflow). */
const workflows = new Map<string, WorkflowState>();
/** Id of the most recently committed workflow (used when workflowId is omitted). */
let lastWorkflowId: string | undefined;
/** Runs hydrated from parent-session "subagent-session" pointers (last-wins by runId). */
const sessionRuns = new Map<string, SubagentRunRecord>();
/**
 * Set by session_shutdown before killing children, so a late runEnd firing after
 * the parent lingers does not downgrade an already-persisted "aborted" record.
 */
let shutdownAbortFlag = false;

/**
 * Soft, session-wide dispatch ceiling — catches a runaway workflow that keeps
 * spawning fallback/retry agents without the user noticing token spend
 * accumulating. Warns once (never blocks); override with
 * PI_SUBAGENT_SPAWN_CEILING.
 */
const SPAWN_CEILING = (() => {
	const n = Number(process.env.PI_SUBAGENT_SPAWN_CEILING);
	return Number.isFinite(n) && n > 0 ? n : 50;
})();
let totalSpawnCount = 0;
let spawnCeilingWarned = false;

function generateRunningAgentId(): string {
	return `sg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function truncateTask(task: string, max = 60): string {
	return task.length > max ? `${task.slice(0, max)}...` : task;
}

function formatElapsed(startedAt: number): string {
	const ms = Date.now() - startedAt;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

/** Format a run's total duration; falls back to live elapsed for running runs. */
function formatRunDuration(rec: SubagentRunRecord): string {
	const ms =
		rec.durationMs ??
		(rec.endedAt === undefined ? undefined : rec.endedAt - rec.startedAt);
	if (ms === undefined) return formatElapsed(rec.startedAt);
	return formatDuration(ms);
}

/** Color mapping for run statuses (shared by /runs screen + entry renderer). */
function statusColor(
	status: string,
): "success" | "error" | "warning" | "muted" {
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

function pruneRunningAgents(): void {
	const now = Date.now();
	for (const [id, info] of runningAgents) {
		if (
			info.status !== "running" &&
			info.settledAt !== undefined &&
			now - info.settledAt > RUNNING_AGENT_PRUNE_MS
		) {
			runningAgents.delete(id);
		}
	}
}

/**
 * Session-cumulative subagent status counts, unioned by runId so live runs
 * hydrated into sessionRuns (during session_start) are not double-counted
 * against runningAgents. Settled runs are bucketed by status:
 * completed = success (exit 0); everything else (failed/timed_out/aborted/
 * orphaned) counts as failed.
 */
function sumSubagentStatus(): {
	running: number;
	completed: number;
	failed: number;
} {
	const ids = new Set([...sessionRuns.keys(), ...runningAgents.keys()]);
	let running = 0;
	let completed = 0;
	let failed = 0;
	for (const id of ids) {
		if (runningAgents.get(id)?.status === "running") {
			running++;
			continue;
		}
		const live = runningAgents.get(id);
		const rec = live
			? { status: live.status, exitCode: live.exitCode }
			: sessionRuns.get(id);
		if (!rec) continue;
		if (rec.status === "completed") completed++;
		else failed++;
	}
	return { running, completed, failed };
}

/**
 * Refresh the "subagents" widget + status from the registry. Fail-soft: UI
 * errors (e.g. non-TUI mode) are swallowed.
 */
function updateSubagentWidget(ui?: UiHooks): void {
	if (!ui || typeof ui.setWidget !== "function") return;
	const all = Array.from(runningAgents.values());
	const running = all
		.filter((r) => r.status === "running")
		.sort((a, b) => b.startedAt - a.startedAt);
	const recent = all
		.filter((r) => r.status !== "running")
		.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
		.slice(0, 5);

	const lines: string[] = [];
	const { running: runningCount, completed, failed } = sumSubagentStatus();
	lines.push(
		`Subagents: ${runningCount} running / ${completed} completed / ${failed} failed`,
	);
	for (const r of running.slice(0, 6)) {
		const stepText = r.step === undefined ? "" : ` step ${r.step}`;
		lines.push(
			`  ● ${r.agent}${stepText} — ${r.task} ${formatElapsed(r.startedAt)}`,
		);
	}
	if (recent.length > 0) {
		lines.push("");
		lines.push("Recently finished:");
		for (const r of recent) {
			const icon = r.status === "completed" ? "✓" : "✗";
			lines.push(
				`  ${icon} ${r.agent} ${r.status}${r.exitCode === undefined ? "" : ` (${r.exitCode})`}`,
			);
		}
	}
	try {
		ui.setWidget(SUBAGENTS_WIDGET_ID, lines);
		if (typeof ui.setStatus === "function") {
			ui.setStatus(
				SUBAGENTS_STATUS_ID,
				runningCount > 0 ? `sg:${runningCount}/${completed}✓/${failed}✗` : "",
			);
		}
	} catch {
		/* Ignore UI errors (e.g. in non-TUI mode) */
	}
}

/**
 * Refresh the "workflow" widget + status from the current workflow state.
 * Fail-soft like updateSubagentWidget: UI errors (e.g. non-TUI mode) are
 * swallowed. Linear output — no theme coloring (UiHooks has no theme).
 */
function updateWorkflowWidget(state: WorkflowState, ui?: UiHooks): void {
	if (!ui || typeof ui.setWidget !== "function") return;
	try {
		const lines = buildWorkflowWidgetLines(state);
		ui.setWidget(WORKFLOW_WIDGET_ID, lines);
		if (typeof ui.setStatus === "function") {
			ui.setStatus(WORKFLOW_STATUS_ID, buildWorkflowStatus(state));
		}
	} catch {
		/* Ignore UI errors (e.g. in non-TUI mode) */
	}
}

/** Byte-safe slicing helper shared by context-file injection and output truncation. */
function sliceUtf8(text: string, cap: number): string {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= cap) return text;
	let truncated = text.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	return truncated;
}

/**
 * Read context files and format them as a system-prompt block. Fail-soft:
 * unreadable files are noted inline instead of aborting the dispatch.
 */
function buildContextBlock(files: string[], baseDir: string): string {
	const parts: string[] = ["", "## Context files", ""];
	for (const file of files) {
		const filePath = path.resolve(baseDir, file);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			parts.push(`--- Context: ${file} ---`);
			parts.push(
				`(could not read: ${err instanceof Error ? err.message : String(err)})`,
			);
			continue;
		}
		if (Buffer.byteLength(content, "utf8") > PER_CONTEXT_FILE_CAP) {
			const truncated = sliceUtf8(content, PER_CONTEXT_FILE_CAP);
			const omitted =
				Buffer.byteLength(content, "utf8") - Buffer.byteLength(truncated, "utf8");
			content = `${truncated}\n\n[Context file truncated: ${omitted} bytes omitted. Max ${PER_CONTEXT_FILE_CAP} bytes per file.]`;
		}
		parts.push(`--- Context: ${file} ---`);
		parts.push(content);
		parts.push("");
	}
	return parts.join("\n");
}

/** Minimal theme surface used by render screens (duck-typed to pi-tui's ThemeAPI). */
interface ScreenTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * Render the /agents screen: available agents + currently running subagents.
 * Returns string lines for the ui.custom dialog.
 */
function renderAgentsScreen(
	width: number,
	agents: AgentConfig[],
	running: RunningAgentInfo[],
	theme: ScreenTheme,
): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push(
		theme.fg("accent", theme.bold(" Available Agents ")) +
			theme.fg("muted", ` (${agents.length})`),
	);
	lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 60))));
	lines.push("");
	if (agents.length === 0) {
		lines.push(theme.fg("dim", "  No agents found."));
	} else {
		for (const a of agents) {
			const sourceColor = a.source === "project" ? "warning" : "accent";
			const model = a.model ? ` • ${a.model}` : "";
			lines.push(
				`  ${theme.fg("accent", a.name)} ${theme.fg(sourceColor, `[${a.source}]`)}${theme.fg("dim", model)}`,
			);
			const desc =
				a.description.length > 80
					? `${a.description.slice(0, 80)}...`
					: a.description;
			lines.push(`    ${theme.fg("dim", desc)}`);
		}
	}
	lines.push("");
	lines.push(
		theme.fg("accent", theme.bold(" Running Subagents ")) +
			theme.fg("muted", ` (${running.length})`),
	);
	lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 60))));
	lines.push("");
	if (running.length === 0) {
		lines.push(theme.fg("dim", "  No subagents running."));
	} else {
		for (const r of running) {
			const stepText = r.step === undefined ? "" : ` (step ${r.step})`;
			const elapsed = formatElapsed(r.startedAt);
			lines.push(
				`  ${theme.fg("warning", "●")} ${theme.fg("accent", r.agent)}${theme.fg("dim", `${stepText} [${r.mode}]`)} ${r.task} ${theme.fg("muted", elapsed)}`,
			);
		}
	}
	lines.push("");
	lines.push(theme.fg("dim", " Press Escape or Ctrl+C to close"));
	lines.push("");
	return lines;
}

async function runSingleAgent<TDetails = SubagentDetails>(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	opts: RunAgentOptions<TDetails>,
): Promise<SingleResult> {
	const { task, cwd, step, signal } = opts;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (agent.thinking) {
		args.push("--thinking", agent.thinking);
	} else if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	// Per-call timeout beats the agent frontmatter's timeoutMs.
	const effectiveTimeout = opts.timeoutMs ?? agent.timeoutMs;
	// Per-call context files beat the agent frontmatter's contextFiles.
	const effectiveContextFiles = opts.contextFiles ?? agent.contextFiles ?? [];

	// Running-agents registry entry (widget + /agents command).
	const runId = generateRunningAgentId();
	const startedAt = Date.now();

	// Persistent run store: durable record.json + the child's own session dir.
	const mode = opts.mode ?? "single";
	const session = opts.session;
	const storeDir = session?.storeDir ?? resolveStoreDir();
	const runDir = path.join(storeDir, runId);
	const runRec: SubagentRunRecord = {
		runId,
		agent: agentName,
		agentSource: agent.source,
		task,
		model: model ?? "",
		mode,
		workflowId: opts.workflowId,
		step,
		parentSessionId: session?.sessionId ?? "",
		parentSessionFile: session?.sessionFile ?? "",
		status: "running",
		startedAt,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
	};
	let runSettled = false;

	// The child writes its own pi session into runDir (real session file per run).
	args.push("--session-dir", runDir);
	args.push("--name", `subagent/${agentName}`);

	const runInfo: RunningAgentInfo = {
		id: runId,
		agent: agentName,
		task: truncateTask(task),
		step,
		mode,
		startedAt,
		status: "running",
	};
	runningAgents.set(runId, runInfo);
	// Durable "running" record before spawn (pid is filled in right after spawn).
	try {
		recordStart(runRec, storeDir);
	} catch {
		/* ignore */
	}
	totalSpawnCount++;
	if (totalSpawnCount === SPAWN_CEILING + 1 && !spawnCeilingWarned) {
		spawnCeilingWarned = true;
		const ceilingMsg = `Subagent spawn ceiling: this session has dispatched ${totalSpawnCount} subagents so far (soft limit ${SPAWN_CEILING}). Advisory only — if a workflow keeps spawning fallback/retry agents, check it isn't runaway. Override with PI_SUBAGENT_SPAWN_CEILING.`;
		if (opts.pi) {
			try {
				opts.pi.sendUserMessage(ceilingMsg, { deliverAs: "steer" });
			} catch {
				/* ignore */
			}
		} else {
			console.error(`[subagent] ${ceilingMsg}`);
		}
	}
	if (opts.onSpawn) {
		try {
			opts.onSpawn(runInfo);
		} catch {
			/* ignore */
		}
	}
	updateSubagentWidget(opts.ui);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model,
		step,
	};

	const emitUpdate = () => {
		if (opts.onUpdate) {
			opts.onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: opts.makeDetails([currentResult]),
			});
		}
	};

	let wasAborted = false;
	let timedOut = false;

	/** One-shot durable run-record finalization + parent-session pointer. */
	const runEnd = (runStatus: RunStatus) => {
		if (runSettled) return;
		runSettled = true;
		// If the session was shut down, a late finalization must not downgrade the
		// already-persisted "aborted" status to "failed" (the child was killed).
		if (shutdownAbortFlag) runStatus = "aborted";
		const endedAt = Date.now();
		runRec.status = runStatus;
		runRec.endedAt = endedAt;
		runRec.durationMs = endedAt - startedAt;
		runRec.exitCode = currentResult.exitCode;
		runRec.usage = {
			input: currentResult.usage.input,
			output: currentResult.usage.output,
			cacheRead: currentResult.usage.cacheRead,
			cacheWrite: currentResult.usage.cacheWrite,
			cost: currentResult.usage.cost,
			contextTokens: currentResult.usage.contextTokens,
			turns: currentResult.usage.turns,
		};
		runRec.outputSummary = sliceUtf8(
			getFinalOutput(currentResult.messages) ?? "",
			2000,
		);
		if (currentResult.errorMessage) {
			runRec.error = sliceUtf8(currentResult.errorMessage, 2000);
		} else if (currentResult.stderr) {
			runRec.error = sliceUtf8(currentResult.stderr, 2000);
		}
		try {
			recordEnd(runRec, storeDir);
		} catch {
			/* ignore */
		}
		// Keep the in-session run map current when runs settle mid-session (today
		// it is only hydrated at session_start). Without this the widget's
		// cumulative completed/failed counts would shrink once pruneRunningAgents()
		// removes settled entries from runningAgents after RUNNING_AGENT_PRUNE_MS.
		sessionRuns.set(runRec.runId, runRec);
		// Parent-session pointer: ONE compact entry per run (full record minus
		// task/outputSummary truncated to keep session growth bounded).
		if (opts.pi) {
			try {
				opts.pi.appendEntry("subagent-session", {
					...runRec,
					task: sliceUtf8(runRec.task, SESSION_POINTER_TRUNCATE),
					outputSummary: runRec.outputSummary
						? sliceUtf8(runRec.outputSummary, SESSION_POINTER_TRUNCATE)
						: undefined,
				});
			} catch {
				/* ignore */
			}
		}
	};

	const settle = (status: "completed" | "failed") => {
		runInfo.status = status;
		runInfo.exitCode = currentResult.exitCode;
		runInfo.settledAt = Date.now();
		runningAgents.set(runId, runInfo);
		pruneRunningAgents();
		// Durable record: completed/failed stay; timedOut → timed_out; aborted → aborted.
		let runStatus: RunStatus = status;
		if (timedOut) runStatus = "timed_out";
		else if (wasAborted) runStatus = "aborted";
		runEnd(runStatus);
		if (opts.onSettled) {
			try {
				opts.onSettled(runInfo);
			} catch {
				/* ignore */
			}
		}
		updateSubagentWidget(opts.ui);
	};

	try {
		const baseCwd = cwd ?? defaultCwd;

		// Effective system prompt: agent prompt + context files + advisory
		// constraint directives + optional output contract.
		let promptBody = agent.systemPrompt;
		const additions: string[] = [];
		if (effectiveContextFiles.length > 0) {
			additions.push(buildContextBlock(effectiveContextFiles, baseCwd));
		}
		if (agent.readonly) {
			additions.push(
				[
					"",
					"## Constraints",
					"- Operate in read-only mode: do not create, modify, or delete any files.",
				].join("\n"),
			);
		}
		if (agent.temperature !== undefined) {
			additions.push(
				[
					"",
					"## Sampling",
					`- Requested sampling temperature: ${agent.temperature} (advisory).`,
				].join("\n"),
			);
		}
		const expectSpec =
			opts.expect && typeof opts.expect === "object"
				? (opts.expect as {
						type?: string;
						jsonSchema?: unknown;
						description?: string;
					})
				: undefined;
		if (expectSpec?.description) {
			additions.push(`\n## Output contract note\n${expectSpec.description}`);
		}
		if (expectSpec?.jsonSchema) {
			additions.push(buildExpectPromptBlock(expectSpec.jsonSchema));
		}
		if (additions.length > 0) promptBody += additions.join("\n");

		if (promptBody.trim()) {
			const tmp = await writePromptToTempFile(agent.name, promptBody);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// Inbox: inject pending messages addressed to this agent.
		let taskPrompt = task;
		const pending = getPendingMessages(agentName);
		if (pending.length > 0) {
			const inbox = pending
				.map(
					(m) =>
						`[from: ${m.from} at ${new Date(m.timestamp).toISOString()}] ${m.content}`,
				)
				.join("\n");
			taskPrompt = `--- Messages addressed to you ---\n${inbox}\n--- End of messages ---\n\n${taskPrompt}`;
		}
		args.push(`Task: ${taskPrompt}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childEnv = {
				...process.env,
				...(agent.env ?? {}),
				PI_SUBAGENT_RUN_ID: runId,
				// pi-lens subagent detection (light mode) — see pi-lens
				// dist/clients/subagent-mode.js: PI_SUBAGENT_CHILD === "1"
				// activates subagent mode; the AGENT/PID pair is informational.
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_AGENT: agentName,
				PI_SUBAGENT_PARENT_PID: String(process.pid),
				...(session?.sessionFile
					? { PI_PARENT_SESSION_FILE: session.sessionFile }
					: {}),
			};
			const proc = spawn(invocation.command, invocation.args, {
				cwd: baseCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			// Track the pid in the registry + durable record right after spawn.
			runInfo.pid = proc.pid;
			runningAgents.set(runId, runInfo);
			runRec.pid = proc.pid;
			try {
				recordUpdate(runRec, storeDir);
			} catch {
				/* ignore */
			}
			let buffer = "";
			let timer: ReturnType<typeof setTimeout> | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (timer) clearTimeout(timer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				if (timer) clearTimeout(timer);
				resolve(1);
			});

			if (effectiveTimeout && effectiveTimeout > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 2000);
				}, effectiveTimeout);
			}

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		// Discover the child's own session JSONL inside runDir (written by the
		// child pi via --session-dir; present once the process has closed). Skip the
		// wait entirely when the child already closed with an error (a session file
		// may never have been written); otherwise a short bounded poll (~500ms).
		runRec.sessionFile = await waitForSessionFile(runDir, {
			exitCode: currentResult.exitCode,
		});
		if (timedOut) {
			currentResult.timedOut = true;
			if (currentResult.exitCode === 0) currentResult.exitCode = 124;
			currentResult.errorMessage = `Subagent timed out after ${effectiveTimeout}ms`;
		}

		// Structured output validation (fail-soft).
		if (expectSpec?.jsonSchema) {
			const finalText = getFinalOutput(currentResult.messages);
			const validation = validateStructuredOutput(
				expectSpec.jsonSchema,
				finalText,
			);
			if (!validation.ok) {
				currentResult.expectError = validation.error;
				if (currentResult.exitCode === 0) currentResult.exitCode = 1;
				currentResult.errorMessage = currentResult.errorMessage
					? `${currentResult.errorMessage}; output failed schema validation: ${validation.error}`
					: `Output failed schema validation: ${validation.error}`;
			} else if (validation.value !== undefined) {
				currentResult.structuredOutput = validation.value;
			}
		}

		// Message delivery: success → delivered, anything else → failed.
		const deliverySucceeded =
			!wasAborted &&
			!currentResult.timedOut &&
			!currentResult.expectError &&
			currentResult.exitCode === 0;
		for (const m of pending) {
			try {
				if (deliverySucceeded) markAsDelivered(m.id);
				else markAsFailed(m.id);
			} catch {
				/* ignore */
			}
		}

		settle(deliverySucceeded && !wasAborted ? "completed" : "failed");

		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		// Crash/exception safety: if settle() never ran (e.g. an unexpected
		// throw mid-flight), still persist a terminal record — only a genuine
		// abort is recorded as "aborted", anything else is "failed".
		if (!runSettled) runEnd(wasAborted ? "aborted" : "failed");
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/** Find the child session JSONL in a run dir (lazily discovered, best-effort). */
function discoverSessionFile(runDir: string): string | undefined {
	try {
		const files = fs
			.readdirSync(runDir)
			.filter((f: string) => f.endsWith(".jsonl") && !f.endsWith(".tmp"))
			.sort();
		if (files.length > 0) return path.join(runDir, files[files.length - 1]);
	} catch {
		/* ignore */
	}
	return undefined;
}

/**
 * Poll runDir for the child's first session JSONL after the process closes
 * (the child flushes its session file just before exit). Bounded best-effort.
 *
 * When `exitCode !== 0` the child already closed with an error and may never
 * have flushed a session file, so the wait is skipped entirely. Preserves the
 * instant-success path when the file appears on the first probe.
 */
async function waitForSessionFile(
	runDir: string,
	opts: { timeoutMs?: number; exitCode?: number } = {},
): Promise<string | undefined> {
	const timeoutMs = opts.timeoutMs ?? 500;
	if (opts.exitCode !== undefined && opts.exitCode !== 0) return undefined;
	const deadline = Date.now() + timeoutMs;
	let found = discoverSessionFile(runDir);
	while (!found && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		found = discoverSessionFile(runDir);
	}
	return found;
}

/** Everything a workflow step-execution loop needs from the dispatching tool. */
export interface WorkflowRunContext {
	pi: ExtensionAPI;
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: { confirm(title: string, message: string): Promise<boolean> };
	};
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	signal?: AbortSignal;
	ui?: UiHooks;
	/** Session-scoped linkage threaded into runSingleAgent for run records. */
	session?: SessionLink;
	onUpdate?: (state: WorkflowState) => void;
}

/** Terminal result of executing one workflow step (or a parallel group member). */
interface SingleStepOutcome {
	stepIndex: number;
	result: WorkflowStepResult;
	output: string;
	exitCode: number;
	failed: boolean;
	failureText?: string;
}

/**
 * Execute one workflow step with the full retry/skip/fallback/abort semantics.
 * `state` here is the PRE-STEP state; the caller merges the returned result via
 * updateWorkflowState so parallel members never clobber each other.
 */
async function executeSingleWorkflowStep(
	state: WorkflowState,
	stepIndex: number,
	step: WorkflowStep,
	previousOutput: string,
	exec: WorkflowRunContext,
	commit: (next: WorkflowState) => void,
): Promise<SingleStepOutcome> {
	let retryCount = 0;
	const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

	while (true) {
		let s = updateWorkflowState(state, stepIndex, {
			status: "running",
			retryCount,
			startTime: Date.now(),
			output: undefined,
			error: undefined,
			endTime: undefined,
		});
		s = { ...s, currentStepIndex: stepIndex };
		commit(s);

		const result = await runSingleAgent(
			exec.ctx.cwd,
			exec.dispatchDefaults,
			exec.agents,
			step.agent,
			{
				task: taskWithContext,
				cwd: step.cwd,
				step: stepIndex + 1,
				signal: exec.signal,
				mode: "workflow",
				workflowId: state.id,
				session: exec.session,
				timeoutMs: step.timeoutMs,
				contextFiles: step.contextFiles,
				expect: step.expect,
				ui: exec.ui,
				pi: exec.pi,
				makeDetails: (results) => ({
					mode: "workflow" as const,
					agentScope: "user" as const,
					projectAgentsDir: null,
					results,
					workflow: s,
				}),
			},
		);

		const output =
			result.structuredOutput === undefined
				? getFinalOutput(result.messages)
				: JSON.stringify(result.structuredOutput, null, 2);
		const exitCode = result.exitCode;

		if (!isFailedResult(result)) {
			return {
				stepIndex,
				result: {
					step,
					stepIndex,
					status: "completed",
					output,
					exitCode,
					retryCount,
					endTime: Date.now(),
					usage: {
						input: result.usage.input,
						output: result.usage.output,
						cacheRead: result.usage.cacheRead,
						cacheWrite: result.usage.cacheWrite,
					},
				},
				output,
				exitCode,
				failed: false,
			};
		}

		// Step failed — apply the error handler strategy.
		const errText = result.errorMessage || result.stderr || "Step failed";
		const strategy = handleStepError(step, {
			step,
			stepIndex,
			status: "failed",
			retryCount,
		});

		if (strategy.action === "retry") {
			retryCount++;
			const s2 = updateWorkflowState(state, stepIndex, {
				status: "failed",
				error: errText,
				exitCode,
				retryCount,
				endTime: Date.now(),
			});
			commit({ ...s2, currentStepIndex: stepIndex });
			continue;
		}

		if (strategy.action === "skip") {
			return {
				stepIndex,
				result: {
					step,
					stepIndex,
					status: "skipped",
					error: errText,
					output: "Skipped due to error",
					exitCode,
					retryCount,
					endTime: Date.now(),
				},
				output: "",
				exitCode,
				failed: false,
			};
		}

		if (strategy.action === "fallback" && strategy.fallbackStep) {
			const fb = strategy.fallbackStep;
			const fbResult = await runSingleAgent(
				exec.ctx.cwd,
				exec.dispatchDefaults,
				exec.agents,
				fb.agent,
				{
					task: fb.task.replace(/\{previous\}/g, previousOutput),
					cwd: fb.cwd,
					step: stepIndex + 1,
					signal: exec.signal,
					mode: "workflow",
					workflowId: state.id,
					session: exec.session,
					timeoutMs: step.timeoutMs,
					ui: exec.ui,
					pi: exec.pi,
					makeDetails: (results) => ({
						mode: "workflow" as const,
						agentScope: "user" as const,
						projectAgentsDir: null,
						results,
						workflow: state,
					}),
				},
			);
			const fbOutput =
				fbResult.structuredOutput === undefined
					? getFinalOutput(fbResult.messages)
					: JSON.stringify(fbResult.structuredOutput, null, 2);
			if (!isFailedResult(fbResult)) {
				return {
					stepIndex,
					result: {
						step,
						stepIndex,
						status: "completed",
						output: `Fallback succeeded: ${fbOutput}`,
						exitCode: fbResult.exitCode,
						retryCount,
						endTime: Date.now(),
						usage: {
							input: fbResult.usage.input,
							output: fbResult.usage.output,
							cacheRead: fbResult.usage.cacheRead,
							cacheWrite: fbResult.usage.cacheWrite,
						},
					},
					output: fbOutput,
					exitCode: fbResult.exitCode,
					failed: false,
				};
			}
			const ftext = `Workflow failed at step ${stepIndex + 1} (${step.agent}): original and fallback failed (${fbResult.errorMessage || fbResult.stderr})`;
			return {
				stepIndex,
				result: {
					step,
					stepIndex,
					status: "failed",
					error: `Original and fallback failed: ${fbResult.errorMessage || fbResult.stderr}`,
					exitCode: fbResult.exitCode,
					retryCount,
					endTime: Date.now(),
				},
				output: "",
				exitCode: fbResult.exitCode,
				failed: true,
				failureText: ftext,
			};
		}

		// abort (default)
		const abortedText = `Workflow failed at step ${stepIndex + 1} (${step.agent}): ${errText}`;
		return {
			stepIndex,
			result: {
				step,
				stepIndex,
				status: "failed",
				error: errText,
				exitCode,
				retryCount,
				endTime: Date.now(),
			},
			output: "",
			exitCode,
			failed: true,
			failureText: abortedText,
		};
	}
}

/**
 * Shared workflow executor: runs steps from `startIndex` (0 for fresh
 * workflows, saved index for resume_workflow), supports consecutive
 * parallelGroup members running concurrently, persists via `commit` on every
 * transition (per-step durability), and completes/fails the workflow state.
 */
export async function executeWorkflowSteps(
	state: WorkflowState,
	startIndex: number,
	initialPrevious: { output: string; exitCode: number },
	exec: WorkflowRunContext,
): Promise<{ state: WorkflowState; failed: boolean; failureText?: string }> {
	let current = state;
	let previousOutput = initialPrevious.output;
	let previousExitCode = initialPrevious.exitCode;

	const commit = (next: WorkflowState) => {
		current = next;
		workflows.set(current.id, current);
		lastWorkflowId = current.id;
		try {
			exec.pi.appendEntry("subagent-workflow", current);
		} catch {
			/* ignore */
		}
		if (exec.onUpdate) exec.onUpdate(current);
		updateWorkflowWidget(current, exec.ui);
	};
	commit(current);

	// Advisory token-budget nudge (see workflow-engine.ts nextBudgetThresholdCrossed):
	// fires once per threshold (60%/85%) when current.budgetTokens is set, never
	// blocks or alters control flow.
	const maybeSendBudgetNudge = () => {
		if (!current.budgetTokens) return;
		const total = totalWorkflowTokens(current);
		const crossed = nextBudgetThresholdCrossed(
			total,
			current.budgetTokens,
			current.budgetNudgesSent,
		);
		if (crossed === undefined) return;
		const nextPendingIndex = current.results.findIndex((r) => r.status === "pending");
		const nextStep =
			nextPendingIndex >= 0
				? { index: nextPendingIndex, agent: current.steps[nextPendingIndex].agent }
				: undefined;
		const message = formatBudgetNudge(crossed, total, current.budgetTokens, nextStep);
		try {
			exec.pi.sendUserMessage(message, { deliverAs: "steer" });
		} catch {
			/* best-effort advisory — never fail the workflow over this */
		}
		current = {
			...current,
			budgetNudgesSent: [...(current.budgetNudgesSent ?? []), crossed],
		};
		commit(current);
	};

	const steps = current.steps;
	let i = Math.min(startIndex, steps.length);
	while (i < steps.length) {
		const first = steps[i];

		// Collect a consecutive parallel group.
		let groupEnd = i;
		if (first.parallelGroup) {
			while (
				groupEnd + 1 < steps.length &&
				steps[groupEnd + 1].parallelGroup === first.parallelGroup
			) {
				groupEnd++;
			}
		}
		const groupSteps = steps.slice(i, groupEnd + 1);
		const groupIndexes = groupSteps.map((_, k) => i + k);

		// Group-level condition gate (evaluated on the first member, against the
		// output preceding the group).
		if (!shouldExecuteStep(first, previousOutput, previousExitCode)) {
			for (const gi of groupIndexes) {
				current = updateWorkflowState(current, gi, {
					status: "skipped",
					output: "Skipped due to condition",
				});
			}
			commit(current);
			i = groupEnd + 1;
			continue;
		}

		// Approval gates (per member, resolved before launch).
		for (let k = 0; k < groupSteps.length; k++) {
			const step = groupSteps[k];
			const gi = groupIndexes[k];
			if (step.requiresApproval && exec.ctx.hasUI) {
				current = updateWorkflowState(current, gi, {
					status: "waiting_approval",
				});
				current = pauseWorkflow(current);
				commit(current);
				const approved = await exec.ctx.ui.confirm(
					`Approve step ${gi + 1}?`,
					`Agent: ${step.agent}\nTask: ${step.task}`,
				);
				if (approved) {
					current = updateWorkflowState(current, gi, {
						approvalGranted: true,
					});
				} else {
					current = updateWorkflowState(current, gi, {
						status: "skipped",
						approvalGranted: false,
						output: "Skipped: approval denied",
					});
				}
				current = resumeWorkflow(current);
				commit(current);
			}
		}

		if (groupSteps.length > 1) {
			// Parallel group: run members concurrently, then merge in order.
			const outcomes = await mapWithConcurrencyLimit(
				groupSteps,
				MAX_CONCURRENCY,
				async (step, k) =>
					executeSingleWorkflowStep(
						current,
						groupIndexes[k],
						step,
						previousOutput,
						exec,
						commit,
					),
			);
			for (const o of outcomes) {
				current = updateWorkflowState(current, o.stepIndex, o.result);
			}
			commit(current);
			maybeSendBudgetNudge();
			const fatal = outcomes.find((o) => o.failed);
			if (fatal) {
				current = failWorkflow(
					current,
					fatal.failureText ?? `Workflow failed at step ${fatal.stepIndex + 1}`,
				);
				commit(current);
				return {
					state: current,
					failed: true,
					failureText: fatal.failureText,
				};
			}
			const doneMembers = outcomes.filter((o) => o.result.status === "completed");
			if (doneMembers.length > 0) {
				previousOutput = doneMembers
					.map((o) => `--- [${o.result.step.agent}] ---\n${o.output}`)
					.join("\n\n");
				previousExitCode = doneMembers.every((o) => o.result.exitCode === 0)
					? 0
					: 1;
			}
		} else {
			const step = first;
			const gi = i;
			const out = await executeSingleWorkflowStep(
				current,
				gi,
				step,
				previousOutput,
				exec,
				commit,
			);
			current = updateWorkflowState(current, gi, out.result);
			commit(current);
			maybeSendBudgetNudge();
			if (out.failed) {
				current = failWorkflow(
					current,
					out.failureText ?? `Workflow failed at step ${gi + 1} (${step.agent})`,
				);
				commit(current);
				return {
					state: current,
					failed: true,
					failureText: out.failureText,
				};
			}
			previousOutput = out.output;
			previousExitCode = out.exitCode;
		}
		i = groupEnd + 1;
	}

	current = completeWorkflow(current);
	commit(current);
	return { state: current, failed: false };
}

const TimeoutMsSchema = Type.Optional(
	Type.Number({
		minimum: 1000,
		description: "Kill the subagent after this many milliseconds",
	}),
);

const ContextFilesSchema = Type.Optional(
	Type.Array(Type.String(), {
		description:
			"Files (relative to cwd) whose contents are injected into the agent's system prompt",
	}),
);

/** Shared `expect` output-contract shape used across all dispatch modes. */
const ExpectSchema = Type.Optional(
	Type.Object({
		type: Type.Optional(
			StringEnum(["json"] as const, {
				description: "Output format (default json)",
			}),
		),
		jsonSchema: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					"JSON Schema the agent's final message must conform to (validated after completion)",
			}),
		),
		description: Type.Optional(
			Type.String({
				description: "Human-readable description of the expected output",
			}),
		),
	}),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
	timeoutMs: TimeoutMsSchema,
	contextFiles: ContextFilesSchema,
	expect: ExpectSchema,
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
	timeoutMs: TimeoutMsSchema,
	contextFiles: ContextFilesSchema,
	expect: ExpectSchema,
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const WorkflowStepSchema = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to execute" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
	condition: Type.Optional(
		Type.Object({
			type: StringEnum(["outputContains", "exitCodeEquals"] as const, {
				description: "Condition type",
			}),
			value: Type.Union([Type.String(), Type.Number()], {
				description: "Condition value",
			}),
		}),
	),
	errorHandler: Type.Optional(
		Type.Object({
			strategy: StringEnum(["retry", "skip", "fallback", "abort"] as const, {
				description: "Error handling strategy",
			}),
			maxRetries: Type.Optional(
				Type.Number({ description: "Maximum retry attempts (for retry strategy)" }),
			),
			fallbackAgent: Type.Optional(
				Type.String({ description: "Fallback agent name (for fallback strategy)" }),
			),
			fallbackTask: Type.Optional(
				Type.String({ description: "Fallback task (for fallback strategy)" }),
			),
		}),
	),
	requiresApproval: Type.Optional(
		Type.Boolean({
			description: "Whether this step requires manual approval before execution",
		}),
	),
	parallelGroup: Type.Optional(
		Type.String({
			description:
				"Consecutive steps sharing a parallelGroup id run concurrently (bounded by MAX_CONCURRENCY=4). Only consecutive steps with the same id are grouped; reuse non-consecutively to start a new group.",
		}),
	),
	timeoutMs: TimeoutMsSchema,
	contextFiles: ContextFilesSchema,
	expect: ExpectSchema,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode)" }),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	workflow: Type.Optional(
		Type.Array(WorkflowStepSchema, {
			description:
				"Array of workflow steps with conditions, error handling, and approval gates. Extended chain mode.",
		}),
	),
	workflowName: Type.Optional(
		Type.String({ description: "Optional name for the workflow" }),
	),
	workflowBudgetTokens: Type.Optional(
		Type.Number({
			description:
				"Optional whole-workflow token budget for workflow mode (input+output+cache, summed across steps). At 60%/85% usage, one advisory steer each is sent — never stops the workflow.",
			minimum: 1,
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
	timeoutMs: TimeoutMsSchema,
	contextFiles: ContextFilesSchema,
	expect: ExpectSchema,
});

/** Output contract for the watchdog's review dispatch (see watchdog.ts). */
const WatchdogOutputSchema = Type.Object({
	findings: Type.Array(
		Type.Object({
			severity: StringEnum(["high", "medium", "low"] as const),
			category: StringEnum(
				["correctness", "test-gap", "loop-risk", "scope-drift", "unsafe-change"] as const,
			),
			evidence: Type.String(),
			recommendedAction: Type.String(),
		}),
	),
});

const WATCHDOG_REVIEW_TIMEOUT_MS = 120_000;
const WATCHDOG_REVIEW_AGENT = "reviewer";

/**
 * Dispatch a single, silent watchdog review via the `reviewer` agent. Reuses
 * runSingleAgent (the same dispatch path as the `subagent` tool) so watchdog
 * runs get the same run-store recording and timeout handling — just without
 * a user-facing tool call. Returns parsed findings, or an error string
 * (never throws — the caller treats a failed review as "nothing to report").
 */
async function dispatchWatchdogReview(ctx: {
	cwd: string;
	sessionManager?: {
		getSessionDir?(): string | undefined;
		getSessionId?(): string | undefined;
		getSessionFile?(): string | undefined;
	};
}): Promise<{ findings: WatchdogFinding[] } | { error: string }> {
	const discovery = discoverAgents(ctx.cwd, "user");
	const agents = discovery.agents;
	if (!agents.some((a) => a.name === WATCHDOG_REVIEW_AGENT)) {
		return { error: `watchdog: no "${WATCHDOG_REVIEW_AGENT}" agent available` };
	}
	const session = buildSessionLink(ctx.sessionManager);
	const result = await runSingleAgent(ctx.cwd, {}, agents, WATCHDOG_REVIEW_AGENT, {
		task: buildWatchdogReviewTask(ctx.cwd),
		cwd: ctx.cwd,
		makeDetails: () => ({
			mode: "single" as const,
			agentScope: "user" as const,
			projectAgentsDir: null,
			results: [],
		}),
		expect: {
			type: "json",
			jsonSchema: WatchdogOutputSchema,
			description: "Watchdog findings — empty array when nothing to report.",
		},
		mode: "single",
		timeoutMs: WATCHDOG_REVIEW_TIMEOUT_MS,
		session,
	});
	if (isFailedResult(result)) {
		return { error: result.errorMessage || result.stderr || "watchdog review failed" };
	}
	if (result.structuredOutput === undefined) {
		return { error: result.expectError || "watchdog review returned no structured output" };
	}
	return { findings: parseWatchdogFindings(result.structuredOutput) };
}

export default function (pi: ExtensionAPI) {
	// Feature 1: list_agents tool
	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description:
			"List available subagents (name, description, tools, model) with optional filtering by scope and name pattern. Run this to discover which agent to dispatch before calling subagent.",
		promptSnippet: "List available subagents (scout/planner/worker/reviewer/general) before dispatching one",
		parameters: Type.Object({
			scope: Type.Optional(AgentScopeSchema),
			namePattern: Type.Optional(
				Type.String({
					description: "Filter agents by name pattern (substring match)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.scope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			let agents = discovery.agents;

			if (params.namePattern) {
				const pattern = params.namePattern.toLowerCase();
				agents = agents.filter((a) => a.name.toLowerCase().includes(pattern));
			}

			const agentList = agents.map((a) => ({
				name: a.name,
				description: a.description,
				tools: a.tools,
				model: a.model,
				source: a.source,
				filePath: a.filePath,
				unread: getPendingMessages(a.name).length,
			}));

			let text = `Found ${agents.length} agent(s) [scope: ${agentScope}]`;
			if (params.namePattern) text += ` matching "${params.namePattern}"`;
			if (agents.length === 0) {
				text += "\n\nNo agents found.";
			} else {
				for (const agent of agents) {
					const unread = getPendingMessages(agent.name).length;
					text += `\n\n### ${agent.name} (${agent.source})`;
					if (unread > 0)
						text += ` ${unread === 1 ? "— 1 unread message" : `— ${unread} unread messages`}`;
					text += `\n${agent.description}`;
					if (agent.tools && agent.tools.length > 0)
						text += `\nTools: ${agent.tools.join(", ")}`;
					if (agent.model) text += `\nModel: ${agent.model}`;
					text += `\nPath: ${agent.filePath}`;
				}
			}

			return {
				content: [{ type: "text", text }],
				details: {
					agents: agentList,
					scope: agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
				},
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.scope ?? "user";
			let text =
				theme.fg("toolTitle", theme.bold("list_agents ")) +
				theme.fg("accent", `[${scope}]`);
			if (args.namePattern) {
				text += " " + theme.fg("muted", `filter: "${args.namePattern}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as
				| {
						agents: AgentConfig[];
						scope: AgentScope;
						projectAgentsDir: string | null;
				  }
				| undefined;

			if (!details || details.agents.length === 0) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "No agents found",
					0,
					0,
				);
			}

			if (expanded) {
				const container = new Container();
				container.addChild(
					new Text(
						`${theme.fg("success", "✓")} Found ${details.agents.length} agent(s) ${theme.fg("muted", `[${details.scope}]`)}`,
						0,
						0,
					),
				);

				for (const agent of details.agents) {
					container.addChild(new Spacer(1));
					const sourceColor = agent.source === "project" ? "warning" : "accent";
					container.addChild(
						new Text(
							`${theme.fg("accent", theme.bold(agent.name))} ${theme.fg(sourceColor, `[${agent.source}]`)}`,
							0,
							0,
						),
					);
					container.addChild(new Text(theme.fg("dim", agent.description), 0, 0));
					if (agent.tools && agent.tools.length > 0) {
						container.addChild(
							new Text(
								theme.fg("muted", "Tools: ") + theme.fg("dim", agent.tools.join(", ")),
								0,
								0,
							),
						);
					}
					if (agent.model) {
						container.addChild(
							new Text(
								theme.fg("muted", "Model: ") + theme.fg("dim", agent.model),
								0,
								0,
							),
						);
					}
					container.addChild(
						new Text(
							theme.fg("muted", "Path: ") + theme.fg("dim", agent.filePath),
							0,
							0,
						),
					);
				}
				return container;
			}

			// Collapsed view
			let text = `${theme.fg("success", "✓")} Found ${details.agents.length} agent(s) ${theme.fg("muted", `[${details.scope}]`)}`;
			for (const agent of details.agents.slice(0, 5)) {
				const sourceColor = agent.source === "project" ? "warning" : "accent";
				text += `\n  ${theme.fg("accent", agent.name)} ${theme.fg(sourceColor, `[${agent.source}]`)} ${theme.fg("dim", "- " + agent.description)}`;
			}
			if (details.agents.length > 5) {
				text += `\n  ${theme.fg("muted", `... +${details.agents.length - 5} more (Ctrl+O to expand)`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// Feature 2: send_message tool
	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message from one subagent to another. Messages are persisted across the session.",
		parameters: Type.Object({
			from: Type.String({ description: "Name of the sending agent" }),
			to: Type.String({ description: "Name of the receiving agent" }),
			content: Type.String({ description: "Message content" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const message = sendMessage(params.from, params.to, params.content);

			// Persistence is handled by the message-persist hook registered in
			// session_start (setMessagePersistHook); no explicit appendEntry needed.
			return {
				content: [
					{
						type: "text",
						text: `Message sent from ${params.from} to ${params.to}\nID: ${message.id}\nTimestamp: ${new Date(message.timestamp).toISOString()}`,
					},
				],
				details: { message },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("send_message ")) +
					theme.fg("accent", args.from) +
					theme.fg("muted", " → ") +
					theme.fg("accent", args.to),
				0,
				0,
			);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as { message: SubagentMessage } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "Message sent", 0, 0);
			}

			const msg = details.message;
			const container = new Container();
			container.addChild(
				new Text(
					`${theme.fg("success", "✓")} Message sent: ${theme.fg("accent", msg.from)} ${theme.fg("muted", "→")} ${theme.fg("accent", msg.to)}`,
					0,
					0,
				),
			);
			container.addChild(new Text(theme.fg("dim", `ID: ${msg.id}`), 0, 0));
			container.addChild(
				new Text(
					theme.fg("dim", `Time: ${new Date(msg.timestamp).toISOString()}`),
					0,
					0,
				),
			);
			if (msg.content.length <= 100) {
				container.addChild(new Text(theme.fg("toolOutput", msg.content), 0, 0));
			} else {
				container.addChild(
					new Text(theme.fg("toolOutput", `${msg.content.slice(0, 100)}...`), 0, 0),
				);
			}
			return container;
		},
	});

	// Feature 2: get_messages tool
	pi.registerTool({
		name: "get_messages",
		label: "Get Messages",
		description:
			"Retrieve messages for a specific agent (as sender, recipient, or both).",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name to filter messages" }),
			filter: Type.Optional(
				StringEnum(["sent", "received", "all"] as const, {
					description: 'Filter type: "sent", "received", or "all" (default)',
					default: "all",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const messages = getMessages(params.agent, params.filter);

			if (messages.length === 0) {
				return {
					content: [
						{ type: "text", text: `No messages found for agent "${params.agent}"` },
					],
					details: { messages: [] },
				};
			}

			let text = `Found ${messages.length} message(s) for "${params.agent}" [${params.filter ?? "all"}]\n\n`;
			for (const msg of messages) {
				const direction = msg.from === params.agent ? "→" : "←";
				const other = msg.from === params.agent ? msg.to : msg.from;
				const statusIcon =
					msg.deliveryStatus === "delivered"
						? "✓"
						: msg.deliveryStatus === "failed"
							? "✗"
							: "⏳";
				text += `${statusIcon} ${direction} ${other} (${new Date(msg.timestamp).toISOString()})\n`;
				const preview =
					msg.content.length > 80 ? `${msg.content.slice(0, 80)}...` : msg.content;
				text += `  ${preview}\n\n`;
			}

			return {
				content: [{ type: "text", text: text.trim() }],
				details: { messages },
			};
		},

		renderCall(args, theme, _context) {
			const filterText = args.filter ? ` [${args.filter}]` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("get_messages ")) +
					theme.fg("accent", args.agent) +
					theme.fg("muted", filterText),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as
				| { messages: SubagentMessage[] }
				| undefined;
			if (!details || details.messages.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "No messages", 0, 0);
			}

			if (expanded) {
				const container = new Container();
				container.addChild(
					new Text(
						`${theme.fg("success", "✓")} Found ${details.messages.length} message(s)`,
						0,
						0,
					),
				);

				for (const msg of details.messages) {
					container.addChild(new Spacer(1));
					const statusIcon =
						msg.deliveryStatus === "delivered"
							? theme.fg("success", "✓")
							: msg.deliveryStatus === "failed"
								? theme.fg("error", "✗")
								: theme.fg("warning", "⏳");
					container.addChild(
						new Text(
							`${statusIcon} ${theme.fg("accent", msg.from)} ${theme.fg("muted", "→")} ${theme.fg("accent", msg.to)}`,
							0,
							0,
						),
					);
					container.addChild(
						new Text(theme.fg("dim", new Date(msg.timestamp).toISOString()), 0, 0),
					);
					container.addChild(new Text(theme.fg("toolOutput", msg.content), 0, 0));
				}
				return container;
			}

			// Collapsed view
			let text = `${theme.fg("success", "✓")} Found ${details.messages.length} message(s)`;
			for (const msg of details.messages.slice(0, 3)) {
				const statusIcon =
					msg.deliveryStatus === "delivered"
						? theme.fg("success", "✓")
						: msg.deliveryStatus === "failed"
							? theme.fg("error", "✗")
							: theme.fg("warning", "⏳");
				const preview =
					msg.content.length > 50 ? `${msg.content.slice(0, 50)}...` : msg.content;
				text += `\n  ${statusIcon} ${theme.fg("accent", msg.from)} ${theme.fg("muted", "→")} ${theme.fg("accent", msg.to)}: ${theme.fg("dim", preview)}`;
			}
			if (details.messages.length > 3) {
				text += `\n  ${theme.fg("muted", `... +${details.messages.length - 3} more (Ctrl+O to expand)`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// Feature 2: Entry renderer for subagent-message
	pi.registerEntryRenderer("subagent-message", (entry, _options, theme) => {
		const msg = (entry as { data?: unknown }).data as SubagentMessage;
		const statusIcon =
			msg.deliveryStatus === "delivered"
				? theme.fg("success", "✓")
				: msg.deliveryStatus === "failed"
					? theme.fg("error", "✗")
					: theme.fg("warning", "⏳");

		const container = new Container();
		container.addChild(
			new Text(
				`${theme.fg("muted", "[message]")} ${statusIcon} ${theme.fg("accent", msg.from)} ${theme.fg("muted", "→")} ${theme.fg("accent", msg.to)}`,
				0,
				0,
			),
		);
		container.addChild(
			new Text(theme.fg("dim", new Date(msg.timestamp).toISOString()), 0, 0),
		);
		container.addChild(new Text(theme.fg("toolOutput", msg.content), 0, 0));
		return container;
	});

	// Feature 2: session_start hook to expose message state
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager?.getEntries() ?? [];

		// Messages: session entries are append-only, so later entries for the
		// same message id supersede earlier ones (last-wins).
		const messageMap = new Map<string, SubagentMessage>();
		for (const entry of entries) {
			if ((entry as { type?: string }).type === "subagent-message") {
				const msg = (entry as { data?: unknown }).data as SubagentMessage;
				if (msg && typeof msg.id === "string") messageMap.set(msg.id, msg);
			}
		}
		initializeMessageStore(Array.from(messageMap.values()));

		// Register the message-persistence hook: every send/deliver/fail state
		// change is appended to the session so delivery status survives restarts.
		setMessagePersistHook((msg) => {
			try {
				pi.appendEntry("subagent-message", msg);
			} catch {
				/* ignore */
			}
		});

		// Workflows: last-wins by id, then hydrate running/paused states to
		// paused (never auto-resume on reload — mirrors monitor's rule).
		const workflowMap = new Map<string, WorkflowState>();
		for (const entry of entries) {
			if ((entry as { type?: string }).type === "subagent-workflow") {
				const wf = (entry as { data?: unknown }).data as WorkflowState;
				if (wf && typeof wf.id === "string") workflowMap.set(wf.id, wf);
			}
		}
		for (const wf of workflowMap.values()) {
			workflows.set(wf.id, hydrateWorkflowState(wf));
		}
		// Most recent workflow entry wins the "latest" slot for get_workflow/resume.
		const lastWfEntry = [...entries]
			.reverse()
			.find((e) => (e as { type?: string }).type === "subagent-workflow");
		if (lastWfEntry) {
			const wf = (lastWfEntry as { data?: unknown }).data as WorkflowState;
			if (wf && typeof wf.id === "string") lastWorkflowId = wf.id;
		}

		// Run store: rebuild the in-session run map from parent pointers, then
		// reconcile orphans and prune. Idempotent: re-fires on "reload" etc.
		const storeDir = resolveStoreDir(ctx.sessionManager?.getSessionDir());
		const runMap = new Map<string, SubagentRunRecord>();
		for (const entry of entries) {
			if ((entry as { type?: string }).type === "subagent-session") {
				const rec = (entry as { data?: unknown }).data as SubagentRunRecord;
				if (rec && typeof rec.runId === "string") runMap.set(rec.runId, rec);
			}
		}
		sessionRuns.clear();
		for (const rec of runMap.values()) sessionRuns.set(rec.runId, rec);
		try {
			reconcileOrphans(storeDir);
		} catch {
			/* ignore */
		}
		try {
			pruneStore(undefined, undefined, storeDir);
		} catch {
			/* ignore */
		}
	});

	// Feature 6.5: session_shutdown — kill live subagents + mark aborted, but
	// ONLY on "quit". reload/new/resume/fork must not kill children.
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "quit") return;
		shutdownAbortFlag = true;
		const storeDir = resolveStoreDir(ctx.sessionManager?.getSessionDir());
		for (const info of runningAgents.values()) {
			if (info.status !== "running") continue;
			// Synchronous SIGTERM + bounded SIGKILL escalation: pi's quit path calls
			// process.exit(0) immediately after this handler returns, so a setTimeout
			// SIGKILL would be dead code. Poll kill(pid, 0) in a short loop (~200ms).
			if (typeof info.pid === "number" && info.pid > 0) {
				try {
					process.kill(info.pid, "SIGTERM");
					const pid = info.pid;
					for (let i = 0; i < 10; i++) {
						try {
							process.kill(pid, 0);
						} catch {
							break; // already gone
						}
						// busy-wait ~20ms between liveness polls (bounded ~200ms total)
						const end = Date.now() + 20;
						while (Date.now() < end) {
							/* spin */
						}
						if (i === 9) {
							try {
								process.kill(pid, "SIGKILL");
							} catch {
								/* already gone */
							}
						}
					}
				} catch {
					/* already gone */
				}
			}
			// Mark the durable record aborted (one-shot, like runEnd).
			const rec = getRun(info.id, storeDir);
			if (rec && rec.status === "running") {
				rec.status = "aborted";
				if (rec.endedAt === undefined) {
					rec.endedAt = Date.now();
					rec.durationMs = rec.endedAt - (rec.startedAt ?? rec.endedAt);
				}
				if (!rec.error) rec.error = "Aborted: pi session quit.";
				try {
					recordEnd(rec, storeDir);
				} catch {
					/* ignore */
				}
			}
			info.status = "aborted";
			info.settledAt = Date.now();
		}
		updateSubagentWidget(ctx.ui);
		// Clear the live workflow widget/status on quit so a stale workflow
		// doesn't linger. Fail-soft like the rest of the shutdown path.
		try {
			if (typeof ctx.ui?.setWidget === "function") {
				ctx.ui.setWidget(WORKFLOW_WIDGET_ID, []);
			}
			if (typeof ctx.ui?.setStatus === "function") {
				ctx.ui.setStatus(WORKFLOW_STATUS_ID, "");
			}
		} catch {
			/* ignore */
		}
	});

	// Feature 3: run_workflow tool
	pi.registerTool({
		name: "run_workflow",
		label: "Run Workflow",
		description:
			"Execute a multi-step workflow with conditions, error handling, approval gates, parallel groups, per-step timeout, and per-step persistence (resumable via resume_workflow).",
		promptSnippet: "Run a multi-step subagent pipeline (e.g. scout -> planner -> worker -> reviewer) with gates and resume",
		promptGuidelines: [
			"Prefer run_workflow over hand-chaining subagent calls when a task has distinct phases with clear handoffs (investigate -> plan -> implement -> review) — it gives you conditions, retries, approval gates, and resume-after-crash for free.",
		],
		parameters: Type.Object({
			steps: Type.Array(WorkflowStepSchema, {
				description: "Workflow steps to execute",
			}),
			name: Type.Optional(Type.String({ description: "Optional workflow name" })),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({
					description: "Prompt before running project-local agents. Default: true.",
					default: true,
				}),
			),
			budgetTokens: Type.Optional(
				Type.Number({
					description:
						"Optional whole-workflow token budget (input+output+cache, summed across steps). At 60%/85% usage, one advisory steer each is sent naming the remaining budget and the next ready step — the workflow itself is never stopped by this.",
					minimum: 1,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const makeDetails = (state: WorkflowState): { workflow: WorkflowState } => ({
				workflow: state,
			});

			// Check for project agents
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>();
				for (const step of params.steps) requestedAgentNames.add(step.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{ type: "text", text: "Canceled: project-local agents not approved." },
							],
							details: makeDetails(createWorkflowState(params.steps, params.name, params.budgetTokens)),
						};
				}
			}

			let state = createWorkflowState(params.steps, params.name, params.budgetTokens);

			const exec: WorkflowRunContext = {
				pi,
				ctx: {
					cwd: ctx.cwd,
					hasUI: ctx.hasUI,
					ui: {
						confirm: (title, message) => ctx.ui.confirm(title, message),
					},
				},
				dispatchDefaults,
				agents,
				signal,
				session: buildSessionLink(ctx.sessionManager),
				ui: {
					setWidget: (id, lines) => {
						try {
							ctx.ui.setWidget(id, lines);
						} catch {
							/* ignore */
						}
					},
					setStatus: (id, text) => {
						try {
							ctx.ui.setStatus(id, text);
						} catch {
							/* ignore */
						}
					},
				},
				onUpdate: (s) => {
					if (onUpdate) {
						const completed = s.results.filter(
							(r) => r.status === "completed",
						).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Workflow: ${completed}/${s.steps.length} steps completed`,
								},
							],
							details: makeDetails(s),
						});
					}
				},
			};

			const {
				state: finalState,
				failed,
				failureText,
			} = await executeWorkflowSteps(state, 0, { output: "", exitCode: 0 }, exec);
			state = finalState;

			if (failed) {
				return {
					content: [{ type: "text", text: failureText ?? "Workflow failed" }],
					details: makeDetails(state),
					isError: true,
				};
			}

			const completed = state.results.filter(
				(r) => r.status === "completed",
			).length;
			const skipped = state.results.filter((r) => r.status === "skipped").length;

			let summaryText = `Workflow completed: ${completed}/${state.steps.length} steps succeeded`;
			if (skipped > 0) summaryText += `, ${skipped} skipped`;

			const lastOutput = state.results
				.filter((r) => r.status === "completed")
				.pop();
			if (lastOutput?.output) {
				summaryText += `\n\n─── Final Output ───\n${lastOutput.output}`;
			}

			return {
				content: [{ type: "text", text: summaryText }],
				details: makeDetails(state),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const name = args.name ?? "workflow";
			let text =
				theme.fg("toolTitle", theme.bold("run_workflow ")) +
				theme.fg("accent", name) +
				theme.fg("muted", ` [${scope}]`);
			if (args.steps && args.steps.length > 0) {
				text += theme.fg("dim", ` (${args.steps.length} steps)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { workflow: WorkflowState } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "Workflow completed",
					0,
					0,
				);
			}

			if (expanded) {
				return renderWorkflowExpanded(details.workflow, theme);
			}

			return renderWorkflowCollapsed(details.workflow, theme);
		},
	});

	// Feature 3: Entry renderer for workflow state
	pi.registerEntryRenderer("subagent-workflow", (entry, _options, theme) => {
		const state = (entry as { data?: unknown }).data as WorkflowState;
		return renderWorkflowCollapsed(state, theme);
	});

	// Feature 6.25: entry renderer for subagent-session parent pointers
	pi.registerEntryRenderer("subagent-session", (entry, _options, theme) => {
		const rec = (entry as { data?: unknown }).data as SubagentRunRecord;
		const duration = formatRunDuration(rec);
		const cost =
			rec.usage?.cost && rec.usage.cost > 0
				? `$${rec.usage.cost.toFixed(4)}`
				: "$0";
		return new Text(
			`${theme.fg("muted", "▸ subagent session")} ${theme.fg("accent", rec.runId)} ${theme.fg("muted", "·")} ${theme.fg("accent", rec.agent)} ${theme.fg("muted", "·")} ${theme.fg(statusColor(rec.status), rec.status)} ${theme.fg("muted", "·")} ${theme.fg("dim", duration)} ${theme.fg("muted", "·")} ${theme.fg("dim", cost)}`,
			0,
			0,
		);
	});

	// Feature 4: get_workflow tool — inspect the latest or a specific workflow
	pi.registerTool({
		name: "get_workflow",
		label: "Get Workflow",
		description:
			"Retrieve the state of a workflow (by id, or the most recent one). Use before resume_workflow to inspect where a workflow stopped.",
		parameters: Type.Object({
			workflowId: Type.Optional(
				Type.String({
					description:
						"Workflow id. Omit to get the most recently committed workflow.",
				}),
			),
			includeOutputs: Type.Optional(
				Type.Boolean({
					description:
						"Include per-step output previews in the text result (default true)",
					default: true,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const includeOutputs = params.includeOutputs ?? true;
			let state: WorkflowState | undefined;
			if (params.workflowId) {
				state = workflows.get(params.workflowId);
			} else {
				state = lastWorkflowId
					? workflows.get(lastWorkflowId)
					: Array.from(workflows.values()).pop();
			}
			if (!state) {
				const known = Array.from(workflows.values())
					.map((w) => `${w.name ?? w.id} (${w.status})`)
					.join(", ");
				return {
					content: [
						{
							type: "text",
							text: `No workflow found${
								params.workflowId ? ` for id "${params.workflowId}"` : ""
							}. Known workflows: ${known || "none"}.`,
						},
					],
					details: { workflows: Array.from(workflows.values()) },
				};
			}

			const summary = getWorkflowSummary(state);
			const stepLines = state.results
				.map((r) => {
					const output =
						includeOutputs && r.output ? ` — ${truncateTask(r.output, 120)}` : "";
					return `- [${r.status}] ${r.step.agent}${output}`;
				})
				.join("\n");
			return {
				content: [{ type: "text", text: `${summary}\n\n${stepLines}` }],
				details: {
					workflow: state,
					workflows: Array.from(workflows.values()),
				},
			};
		},

		renderCall(args, theme, _context) {
			const target = args.workflowId ?? "(latest)";
			return new Text(
				theme.fg("toolTitle", theme.bold("get_workflow ")) +
					theme.fg("accent", target),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as
				| { workflow?: WorkflowState; workflows?: WorkflowState[] }
				| undefined;
			if (details?.workflow) {
				return expanded
					? renderWorkflowExpanded(details.workflow, theme)
					: renderWorkflowCollapsed(details.workflow, theme);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "No workflow", 0, 0);
		},
	});

	// Feature 5: resume_workflow tool — resume a paused/failed workflow
	pi.registerTool({
		name: "resume_workflow",
		label: "Resume Workflow",
		description:
			"Resume a paused or failed workflow from the first incomplete step (or a given step). Requires the workflow to be in a non-running state.",
		parameters: Type.Object({
			workflowId: Type.Optional(
				Type.String({
					description:
						"Workflow id. Omit to resume the most recently committed workflow.",
				}),
			),
			fromStep: Type.Optional(
				Type.Number({
					description:
						"0-based step index to resume from. Defaults to the first incomplete step.",
				}),
			),
			name: Type.Optional(Type.String({ description: "Optional workflow name" })),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({
					description: "Prompt before running project-local agents. Default: true.",
					default: true,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const state = params.workflowId
				? workflows.get(params.workflowId)
				: lastWorkflowId
					? workflows.get(lastWorkflowId)
					: undefined;
			if (!state) {
				return {
					content: [
						{
							type: "text",
							text: `No workflow to resume${
								params.workflowId ? ` for id "${params.workflowId}"` : ""
							}.`,
						},
					],
					details: { workflows: Array.from(workflows.values()) },
				};
			}
			if (state.status === "running") {
				return {
					content: [
						{
							type: "text",
							text: `Workflow ${state.name ?? state.id} is still running; cannot resume until it settles.`,
						},
					],
					details: { workflow: state },
				};
			}

			const makeDetails = (s: WorkflowState): { workflow: WorkflowState } => ({
				workflow: s,
			});

			// Project-agent gate mirrors run_workflow.
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>(
					state.results
						.filter((r) => r.status !== "completed" && r.status !== "skipped")
						.map((r) => r.step.agent),
				);
				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");
				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(state),
						};
				}
			}

			// Prepare resume: reset steps at/after the resume point.
			const resumed = prepareResume(state, params.fromStep);
			const resumeStart = resumed.resumedFromStepIndex ?? 0;

			// Reconstruct previous output from the last completed step before the
			// resume point (persisted workflow state does not carry the loop's
			// local previousOutput/previousExitCode).
			let previousOutput = "";
			let previousExitCode = 0;
			for (let k = resumeStart - 1; k >= 0; k--) {
				const r = resumed.results[k];
				if (r.status === "completed") {
					previousOutput = r.output ?? "";
					previousExitCode = r.exitCode ?? 0;
					break;
				}
			}

			const exec: WorkflowRunContext = {
				pi,
				ctx: {
					cwd: ctx.cwd,
					hasUI: ctx.hasUI,
					ui: { confirm: (title, message) => ctx.ui.confirm(title, message) },
				},
				dispatchDefaults,
				agents,
				signal,
				session: buildSessionLink(ctx.sessionManager),
				ui: {
					setWidget: (id, lines) => {
						try {
							ctx.ui.setWidget(id, lines);
						} catch {
							/* ignore */
						}
					},
					setStatus: (id, text) => {
						try {
							ctx.ui.setStatus(id, text);
						} catch {
							/* ignore */
						}
					},
				},
				onUpdate: (s) => {
					if (onUpdate) {
						const completed = s.results.filter(
							(r) => r.status === "completed",
						).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Workflow: ${completed}/${s.steps.length} steps completed`,
								},
							],
							details: makeDetails(s),
						});
					}
				},
			};

			const {
				state: finalState,
				failed,
				failureText,
			} = await executeWorkflowSteps(
				resumed,
				resumeStart,
				{ output: previousOutput, exitCode: previousExitCode },
				exec,
			);

			if (failed) {
				return {
					content: [{ type: "text", text: failureText ?? "Workflow failed" }],
					details: makeDetails(finalState),
					isError: true,
				};
			}

			const completed = finalState.results.filter(
				(r) => r.status === "completed",
			).length;
			const skipped = finalState.results.filter(
				(r) => r.status === "skipped",
			).length;
			let summaryText = `Workflow resumed: ${completed}/${finalState.steps.length} steps succeeded`;
			if (skipped > 0) summaryText += `, ${skipped} skipped`;
			if (finalState.resumedFromStepIndex !== undefined)
				summaryText += ` (resumed from step ${finalState.resumedFromStepIndex + 1})`;
			const lastOutput = finalState.results
				.filter((r) => r.status === "completed")
				.pop();
			if (lastOutput?.output) {
				summaryText += `\n\n─── Final Output ───\n${lastOutput.output}`;
			}

			return {
				content: [{ type: "text", text: summaryText }],
				details: makeDetails(finalState),
			};
		},

		renderCall(args, theme, _context) {
			const target = args.workflowId ?? "(latest)";
			const from = args.fromStep === undefined ? "" : ` from ${args.fromStep + 1}`;
			return new Text(
				theme.fg("toolTitle", theme.bold("resume_workflow ")) +
					theme.fg("accent", target) +
					theme.fg("muted", from),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { workflow?: WorkflowState } | undefined;
			if (details?.workflow) {
				return expanded
					? renderWorkflowExpanded(details.workflow, theme)
					: renderWorkflowCollapsed(details.workflow, theme);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "Workflow result", 0, 0);
		},
	});

	// Feature 6: /agents command — a screen listing available agents + running subagents
	pi.registerCommand("agents", {
		description:
			"List available subagents and currently running subagent processes",
		handler: async (_args, cmdCtx) => {
			const agentScope: AgentScope = "both";
			const discovery = discoverAgents(cmdCtx.cwd, agentScope);
			const agents = discovery.agents;
			const running = Array.from(runningAgents.values()).filter(
				(r) => r.status === "running",
			);

			if (cmdCtx.mode !== "tui") {
				const { text, remaining } = formatAgentList(agents, 30);
				console.log(
					`Available agents: ${text}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
				);
				if (running.length === 0) console.log("No subagents running.");
				else
					for (const r of running)
						console.log(`● ${r.agent} (${r.mode}) — ${r.task}`);
				return;
			}

			await cmdCtx.ui.custom((_tui, theme, _kb, done) => ({
				render: (width: number) =>
					renderAgentsScreen(width, agents, running, theme),
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
						done(undefined);
				},
			}));
		},
	});

	// Feature 6.75: /runs command — durable run records for subagent dispatches
	pi.registerCommand("runs", {
		description:
			"List persisted subagent runs with status, duration, turns, and cost",
		handler: async (_args, cmdCtx) => {
			const storeDir = resolveStoreDir(cmdCtx.sessionManager?.getSessionDir());

			// Source list: live registry (record overlaid where available) merged
			// with store-wide records; dedup by runId, newest first.
			const loadRows = (): RunsTableRow[] => {
				const rows: { runId?: string; startedAt: number; row: RunsTableRow }[] = [];
				for (const info of runningAgents.values()) {
					const rec = getRun(info.id, storeDir);
					rows.push({
						runId: rec?.runId,
						startedAt: info.startedAt,
						row: {
							agent: info.agent,
							mode: info.mode,
							status: (rec?.status ?? info.status) as RunStatus,
							durationMs:
								rec?.durationMs ??
								(info.settledAt ? info.settledAt - info.startedAt : undefined),
							turns: rec?.usage?.turns,
							cost: rec?.usage?.cost,
						},
					});
				}
				let storeRuns: SubagentRunRecord[] = [];
				try {
					storeRuns = listRuns({ limit: RUNS_DEFAULT_LIMIT }, storeDir);
				} catch {
					/* ignore */
				}
				for (const rec of storeRuns) {
					rows.push({
						runId: rec.runId,
						startedAt: rec.startedAt,
						row: {
							agent: rec.agent,
							mode: rec.mode,
							status: rec.status,
							durationMs: rec.durationMs,
							turns: rec.usage?.turns,
							cost: rec.usage?.cost,
						},
					});
				}
				rows.sort((a, b) => b.startedAt - a.startedAt);
				const seen = new Set<string>();
				const out: RunsTableRow[] = [];
				for (const entry of rows) {
					if (entry.runId) {
						if (seen.has(entry.runId)) continue;
						seen.add(entry.runId);
					}
					out.push(entry.row);
					if (out.length >= RUNS_DEFAULT_LIMIT) break;
				}
				return out;
			};

			if (cmdCtx.mode !== "tui") {
				const rows = loadRows();
				if (rows.length === 0) {
					console.log("No subagent runs recorded.");
					return;
				}
				for (const r of rows) {
					const duration = formatDuration(r.durationMs);
					console.log(
						`${r.agent.padEnd(12)} ${String(r.mode).padEnd(9)} ${String(r.status).padEnd(10)} ${duration.padEnd(9)} ${String(r.turns ?? 0).padEnd(6)} $${(r.cost ?? 0).toFixed(4)}`,
					);
				}
				return;
			}

			let current = loadRows();
			const refresh = () => {
				current = loadRows();
			};

			await cmdCtx.ui.custom((_tui, theme, _kb, done) => ({
				render: (width: number) => renderRunsScreen(width, current, theme),
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(undefined);
					} else if (data === "r" || data === "R") {
						refresh();
					}
				},
			}));
		},
	});

	// Note: Workflow session persistence is implemented via per-step appendEntry
	// (see executeWorkflowSteps) + session_start hydration. Interrupted workflows
	// can be inspected with get_workflow and resumed with resume_workflow.

	// Feature 6.8: list_subagent_sessions tool — query the run store
	pi.registerTool({
		name: "list_subagent_sessions",
		label: "List Subagent Sessions",
		description:
			"List persisted subagent run records (store-wide) with optional filtering by agent, status, mode, workflow, or recency. Use with get_subagent_session for details.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
			mode: Type.Optional(
				StringEnum(["single", "parallel", "chain", "workflow"] as const, {
					description: "Filter by run mode",
				}),
			),
			status: Type.Optional(
				StringEnum(
					[
						"running",
						"completed",
						"failed",
						"timed_out",
						"aborted",
						"orphaned",
					] as const,
					{
						description: "Filter by run status",
					},
				),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max runs to return (default 50)",
					default: 50,
				}),
			),
			workflowId: Type.Optional(
				Type.String({ description: "Filter by workflow id" }),
			),
			since: Type.Optional(
				Type.Number({
					description: "Only runs started at or after this epoch ms timestamp",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storeDir = resolveStoreDir(ctx.sessionManager?.getSessionDir());
			const limit = params.limit ?? RUNS_DEFAULT_LIMIT;
			let runs: SubagentRunRecord[] = [];
			try {
				runs = listRuns(
					{
						agent: params.agent,
						mode: params.mode,
						status: params.status,
						workflowId: params.workflowId,
						since: params.since,
						limit,
					},
					storeDir,
				);
			} catch {
				/* ignore */
			}
			const compact = runs.map((r) => ({
				runId: r.runId,
				agent: r.agent,
				mode: r.mode,
				status: r.status,
				durationMs: r.durationMs,
				turns: r.usage.turns,
				cost: r.usage.cost,
				task: truncateTask(r.task, 100),
			}));
			let text =
				`Found ${runs.length} subagent run(s)` +
				(params.agent ? ` for agent "${params.agent}"` : "") +
				(params.status ? ` [status: ${params.status}]` : "");
			if (runs.length === 0) {
				text += "\n\nNo runs recorded yet.";
			} else {
				for (const r of compact) {
					const duration = formatDuration(r.durationMs);
					text += `\n\n${r.runId} — ${r.agent} (${r.mode}) [${r.status}] — ${duration}, ${r.turns} turns, $${r.cost.toFixed(4)}\n  ${r.task}`;
				}
			}
			return {
				content: [{ type: "text", text }],
				details: { runs: compact },
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("list_subagent_sessions"));
			if (args.agent) text += theme.fg("accent", ` ${args.agent}`);
			if (args.status) text += theme.fg("muted", ` [${args.status}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as
				| {
						runs?: {
							runId: string;
							agent: string;
							mode: string;
							status: string;
							durationMs?: number;
							turns: number;
							cost: number;
							task: string;
						}[];
				  }
				| undefined;
			const text = result.content[0];
			const runs = details?.runs ?? [];
			if (runs.length === 0) {
				return new Text(text?.type === "text" ? text.text : "No runs", 0, 0);
			}
			const lines: string[] = [];
			for (const r of runs.slice(0, 10)) {
				const icon =
					r.status === "completed"
						? theme.fg("success", "✓")
						: r.status === "running"
							? theme.fg("warning", "⏳")
							: theme.fg("error", "✗");
				lines.push(
					`${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", `[${r.mode}] ${r.status}`)} ${theme.fg("muted", r.runId)}`,
				);
			}
			if (runs.length > 10)
				lines.push(theme.fg("muted", `... +${runs.length - 10} more`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// Feature 6.9: get_subagent_session tool — full record + transcript
	pi.registerTool({
		name: "get_subagent_session",
		label: "Get Subagent Session",
		description:
			"Retrieve a persisted subagent run record by runId (from list_subagent_sessions) plus an optional transcript excerpt of the child session.",
		parameters: Type.Object({
			runId: Type.String({ description: "Run id (e.g. sg-...)" }),
			includeTranscript: Type.Optional(
				Type.Boolean({
					description:
						"Include the tail of the run's session transcript (last ~30 assistant messages)",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storeDir = resolveStoreDir(ctx.sessionManager?.getSessionDir());
			// Disk record first; fall back to the hydrated parent-session pointer
			// (which survives pruneStore, since session entries are append-only).
			const rec = getRun(params.runId, storeDir) ?? sessionRuns.get(params.runId);
			if (!rec) {
				return {
					content: [
						{
							type: "text",
							text: `No run record found for "${params.runId}". Run /runs or list_subagent_sessions to see known ids.`,
						},
					],
					details: {},
				};
			}

			const transcriptMessages: {
				role: string;
				text: string;
				model?: string;
				usage?: unknown;
			}[] = [];
			if (params.includeTranscript) {
				try {
					const t = readRunTranscript(params.runId, storeDir);
					if (t) {
						const last = t.messages
							.filter((m) => m.role === "assistant")
							.slice(-RUNS_TRANSCRIPT_MAX_MESSAGES);
						let budget = RUNS_TRANSCRIPT_MAX_BYTES;
						for (const m of last) {
							if (budget <= 0) break;
							const text = m.content
								.filter((p) => p.type === "text")
								.map((p) => p.text)
								.join("\n");
							if (!text) continue;
							const capped = sliceUtf8(text, budget);
							budget -= Buffer.byteLength(capped, "utf8");
							transcriptMessages.push({
								role: "assistant",
								text: capped,
								model: m.model,
							});
						}
					}
				} catch {
					/* ignore */
				}
			}

			const duration = formatDuration(rec.durationMs);
			const usage = rec.usage;
			let text = `Run ${rec.runId}\n`;
			text += `Agent: ${rec.agent} (${rec.agentSource})  Mode: ${rec.mode}  Status: ${rec.status}\n`;
			if (rec.workflowId)
				text += `Workflow: ${rec.workflowId}${rec.step === undefined ? "" : ` step ${rec.step}`}\n`;
			if (rec.model) text += `Model: ${rec.model}\n`;
			text += `Started: ${new Date(rec.startedAt).toISOString()}  Duration: ${duration}\n`;
			if (rec.endedAt) text += `Ended: ${new Date(rec.endedAt).toISOString()}\n`;
			if (rec.exitCode !== undefined) text += `Exit: ${rec.exitCode}\n`;
			if (rec.pid) text += `PID: ${rec.pid}\n`;
			text += `Usage: ${usage.turns} turns, input ${usage.input}, output ${usage.output}, cacheRead ${usage.cacheRead}, cacheWrite ${usage.cacheWrite}, ctx ${usage.contextTokens}, cost $${usage.cost.toFixed(4)}\n`;
			text += `Session file: ${rec.sessionFile ?? "(not discovered)"}\n`;
			if (rec.error) text += `Error: ${rec.error}\n`;
			if (rec.outputSummary)
				text += `\n─── Output summary ───\n${rec.outputSummary}\n`;
			if (transcriptMessages.length > 0) {
				text += `\n─── Transcript (last ${transcriptMessages.length}) ───\n`;
				for (const m of transcriptMessages) {
					text += `\n[${m.role}${m.model ? ` · ${m.model}` : ""}]\n${m.text}\n`;
				}
			}
			return {
				content: [{ type: "text", text }],
				details: { record: rec, transcriptMessages },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("get_subagent_session ")) +
					theme.fg("accent", args.runId),
				0,
				0,
			);
		},

		renderResult(result, _expanded, theme, _context) {
			const details = result.details as { record?: SubagentRunRecord } | undefined;
			const text = result.content[0];
			if (!details?.record) {
				return new Text(text?.type === "text" ? text.text : "No run", 0, 0);
			}
			const rec = details.record;
			const icon =
				rec.status === "completed"
					? theme.fg("success", "✓")
					: rec.status === "running"
						? theme.fg("warning", "⏳")
						: theme.fg("error", "✗");
			const duration = formatDuration(rec.durationMs);
			return new Text(
				`${icon} ${theme.fg("toolTitle", rec.agent)} ${theme.fg("accent", rec.runId)} ${theme.fg("dim", `[${rec.mode}] ${rec.status} · ${duration} · $${rec.usage.cost.toFixed(4)}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to subagents with isolated context windows.",
			"Pick the agent that fits the work: scout (recon), planner (plan), worker (TDD implementation), reviewer (review), general (all-rounder fallback). Run list_agents to see the live catalog with per-agent tools and models.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), workflow (steps with conditions, error handlers, approval gates, parallelGroup).",
			`Every dispatch is recorded to the on-disk run store (record.json + the child's own pi session file); inspect with list_subagent_sessions / get_subagent_session or the /runs command.`,
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet: "Delegate research, implementation, or review to an isolated subagent with its own context window",
		promptGuidelines: [
			"Reach for subagent (don't just default to bash/edit in the main context) when: you'd need to read/grep/explore ~10+ files whose contents you won't need again once you have the answer; the work splits into ~3+ independent pieces (different files/subsystems, multiple failing tests) that can run in parallel; or you're about to declare something done and want an unbiased second opinion — dispatch reviewer on the diff instead of grading your own work.",
			"Don't dispatch a subagent for: a task doable in one bash command or a quick focused read; a tightly sequential chain where each step needs the full prior context (keep that in this conversation); or edits to the same file another in-flight change touches (same-file parallel edits conflict).",
			"Call list_agents first if unsure which role fits; pick scout (recon), planner (plan, no edits), worker (TDD implementation), reviewer (independent review/second opinion), or general (fallback).",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasWorkflow = (params.workflow?.length ?? 0) > 0;
			const modeCount =
				Number(hasChain) +
				Number(hasTasks) +
				Number(hasSingle) +
				Number(hasWorkflow);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const agentUi: UiHooks = {
				setWidget: (id, lines) => {
					try {
						ctx.ui.setWidget(id, lines);
					} catch {
						/* ignore */
					}
				},
				setStatus: (id, text) => {
					try {
						ctx.ui.setStatus(id, text);
					} catch {
						/* ignore */
					}
				},
			};

			if (modeCount !== 1) {
				const available =
					agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain)
					for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks)
					for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.workflow)
					for (const s of params.workflow) requestedAgentNames.add(s.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{ type: "text", text: "Canceled: project-local agents not approved." },
							],
							details: makeDetails(
								hasChain ? "chain" : hasTasks ? "parallel" : "single",
							)([]),
						};
				}
			}

			// Workflow mode: same semantics as run_workflow, driven from the subagent tool.
			if (params.workflow && params.workflow.length > 0) {
				const wfState = createWorkflowState(params.workflow, params.workflowName, params.workflowBudgetTokens);
				const makeWfDetails = (s: WorkflowState): { workflow: WorkflowState } => ({
					workflow: s,
				});
				const wfExec: WorkflowRunContext = {
					pi,
					ctx: {
						cwd: ctx.cwd,
						hasUI: ctx.hasUI,
						ui: { confirm: (title, message) => ctx.ui.confirm(title, message) },
					},
					dispatchDefaults,
					agents,
					signal,
					session: buildSessionLink(ctx.sessionManager),
					ui: agentUi,
					onUpdate: (s) => {
						if (onUpdate) {
							const completed = s.results.filter(
								(r) => r.status === "completed",
							).length;
							onUpdate({
								content: [
									{
										type: "text",
										text: `Workflow: ${completed}/${s.steps.length} steps completed`,
									},
								],
								details: makeWfDetails(s),
							});
						}
					},
				};
				const {
					state: wfFinal,
					failed: wfFailed,
					failureText: wfFailure,
				} = await executeWorkflowSteps(
					wfState,
					0,
					{ output: "", exitCode: 0 },
					wfExec,
				);
				if (wfFailed) {
					return {
						content: [{ type: "text", text: wfFailure ?? "Workflow failed" }],
						details: makeWfDetails(wfFinal),
						isError: true,
					};
				}
				const wfDone = wfFinal.results.filter(
					(r) => r.status === "completed",
				).length;
				const wfSkipped = wfFinal.results.filter(
					(r) => r.status === "skipped",
				).length;
				let wfText = `Workflow ${params.workflowName ?? wfFinal.id}: ${wfDone}/${wfFinal.steps.length} steps succeeded`;
				if (wfSkipped > 0) wfText += `, ${wfSkipped} skipped`;
				return {
					content: [{ type: "text", text: wfText }],
					details: makeWfDetails(wfFinal),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						{
							task: taskWithContext,
							cwd: step.cwd,
							step: i + 1,
							signal,
							onUpdate: chainUpdate,
							makeDetails: makeDetails("chain"),
							mode: "chain",
							session: buildSessionLink(ctx.sessionManager),
							pi,
							timeoutMs: step.timeoutMs,
							contextFiles: step.contextFiles,
							expect: step.expect,
							ui: agentUi,
						},
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(results[results.length - 1].messages) || "(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = Array.from({
					length: params.tasks.length,
				});

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							t.agent,
							{
								task: t.task,
								cwd: t.cwd,
								signal,
								// Per-task update callback
								onUpdate: (partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails: makeDetails("parallel"),
								mode: "parallel",
								session: buildSessionLink(ctx.sessionManager),
								pi,
								timeoutMs: t.timeoutMs,
								contextFiles: t.contextFiles,
								expect: t.expect,
								ui: agentUi,
							},
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					{
						task: params.task,
						cwd: params.cwd,
						signal,
						onUpdate,
						makeDetails: makeDetails("single"),
						mode: "single",
						session: buildSessionLink(ctx.sessionManager),
						pi,
						timeoutMs: params.timeoutMs,
						contextFiles: params.contextFiles,
						expect: params.expect,
						ui: agentUi,
					},
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				if (result.structuredOutput !== undefined) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(result.structuredOutput, null, 2),
							},
						],
						details: makeDetails("single")([result]),
					};
				}
				return {
					content: [
						{
							type: "text",
							text: getFinalOutput(result.messages) || "(no output)",
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available =
				agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			// Workflow-mode results carry a workflow state instead of per-agent results.
			if (details?.workflow) {
				return expanded
					? renderWorkflowExpanded(details.workflow, theme)
					: renderWorkflowCollapsed(details.workflow, theme);
			}
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0)
					text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded
							? item.text
							: item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason)
						header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason)
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage)
							container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage)
							container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Watchdog: live in-session review (see watchdog.ts, IMPROVEMENT-PLAN.md Gap 1) ──
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const watchdogStateFile = () =>
		path.join(os.homedir(), ".pi", "agent", "watchdog", "state.json");
	const readWatchdogEnabled = (): boolean => {
		try {
			return JSON.parse(fs.readFileSync(watchdogStateFile(), "utf8")).enabled === true;
		} catch {
			return false;
		}
	};
	let watchdogEnabled = readWatchdogEnabled();
	const writeWatchdogEnabled = (on: boolean) => {
		try {
			fs.mkdirSync(path.dirname(watchdogStateFile()), { recursive: true });
			fs.writeFileSync(
				watchdogStateFile(),
				JSON.stringify({ enabled: on }, null, 2),
				"utf8",
			);
		} catch {
			/* state file unwritable — in-memory toggle for this session */
		}
	};
	let watchdogHinted = false;
	let watchdogErrorNotified = false;
	let watchdogRunning = false;
	const watchdogTrigger: WatchdogTriggerState = newWatchdogTriggerState();
	const watchdogStalemate: WatchdogStalemateState = newWatchdogStalemateState();

	pi.on("before_agent_start", () => {
		if (isSubagentChild || !watchdogEnabled || watchdogHinted) return;
		watchdogHinted = true;
		return {
			message: {
				customType: "watchdog-state",
				content:
					"The watchdog is ON: a reviewer subagent will periodically check recent changes (at a mutating turn, or every few tool calls) for correctness risk, test gaps, loop risk, scope drift, and unsafe changes, and steer you once if it finds something. Advisory, event-driven, never blocks. Disable with /watchdog.",
				display: true,
			},
		};
	});

	pi.on("tool_execution_start", (event) => {
		if (isSubagentChild || !watchdogEnabled) return;
		recordWatchdogTool(watchdogTrigger, event.toolName);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (isSubagentChild || !watchdogEnabled || watchdogRunning) return;
		if (!shouldRunWatchdog(watchdogTrigger)) return;
		resetWatchdogTriggerState(watchdogTrigger);

		watchdogRunning = true;
		try {
			const outcome = await dispatchWatchdogReview({
				cwd: ctx.cwd,
				sessionManager: ctx.sessionManager,
			});
			if ("error" in outcome) {
				if (!watchdogErrorNotified) {
					watchdogErrorNotified = true;
					ctx.ui.notify(`Watchdog review failed: ${outcome.error}`, "warning");
				}
				return;
			}
			const hash = hashWatchdogFindings(outcome.findings);
			const suppressed = trackWatchdogStalemate(watchdogStalemate, hash);
			if (outcome.findings.length > 0 && !suppressed) {
				pi.sendUserMessage(formatWatchdogSteer(outcome.findings), {
					deliverAs: "steer",
				});
			}
		} finally {
			watchdogRunning = false;
		}
	});

	pi.registerCommand("watchdog", {
		description:
			"Toggle the watchdog (persisted): periodically dispatches a reviewer subagent to check recent changes for correctness risk, test gaps, loop risk, scope drift, and unsafe changes, steering once if it finds something.",
		handler: async (_args, ctx) => {
			watchdogEnabled = !watchdogEnabled;
			writeWatchdogEnabled(watchdogEnabled);
			if (watchdogEnabled) watchdogHinted = false;
			resetWatchdogTriggerState(watchdogTrigger);
			ctx.ui.notify(
				watchdogEnabled
					? "Watchdog ON: a reviewer subagent will periodically check recent changes and steer once if it finds something."
					: "Watchdog OFF.",
				watchdogEnabled ? "info" : "warning",
			);
		},
	});
}
