/**
 * Monitor / Background Watcher Extension for Pi Coding Agent
 *
 * Monitors command output or WebSocket streams, matching patterns and
 * triggering actions (notify, log, interrupt) when patterns are found.
 *
 * Tools:
 *   - monitor_start:   Start monitoring a command or WebSocket stream
 *   - monitor_stop:    Stop a running monitor by ID
 *   - monitor_list:    List all monitors with status
 *   - monitor_status:  Get detailed status and events of a monitor
 *   - monitor_pattern: Add/remove/list patterns on a running monitor
 *
 * TUI:
 *   - /monitors command: Interactive dialog showing all monitors
 *   - Widget: "👁 N monitor(s)" with labels and uptime
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentToolResult,
	ToolRenderResultOptions,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import WebSocket from "ws";

// A minimal text-content part used across tool result/update shapes.
type TextPart = { type: "text"; text: string };

// ─── Types ───────────────────────────────────────────────────────────────────

export type MonitorStatus =
	| "starting"
	| "running"
	| "stopped"
	| "error"
	| "interrupted";

export type MonitorType = "command" | "websocket";

export interface CommandConfig {
	type: "command";
	command: string;
	cwd: string;
	restart: boolean;
}

export interface WebSocketConfig {
	type: "websocket";
	url: string;
	headers?: Record<string, string>;
	reconnect: boolean;
}

export type MonitorConfig = CommandConfig | WebSocketConfig;

export interface PatternRule {
	id: string;
	pattern: string;
	useRegex: boolean;
	action: "notify" | "log" | "interrupt";
	cooldown: number; // ms between triggers
	lastTriggered: number | null;
}

export interface MonitorEvent {
	timestamp: number;
	type: "line" | "match" | "error" | "status";
	content: string;
	matchedPattern?: string;
}

export interface MonitorInfo {
	id: string;
	label: string;
	type: MonitorType;
	status: MonitorStatus;
	createdAt: number;
	startedAt: number | null;
	stoppedAt: number | null;
	config: MonitorConfig;
	patterns: PatternRule[];
	events: MonitorEvent[];
	error?: string;
	stopReason?: string;
	interruptionCount: number;
}

interface MonitorDetails {
	monitors: MonitorInfo[];
	runningCount: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_TYPE = "monitor";
const WIDGET_ID = "monitors";
const STATUS_ID = "monitors-active";
const MAX_EVENTS = 200;
const MAX_PERSIST_EVENTS = 50;
const MAX_ACTIVE_MONITORS = 10;
const STOP_GRACE_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const INTERRUPT_GLOBAL_THROTTLE_MS = 1000;

// ─── In-memory stores ────────────────────────────────────────────────────────

const monitors = new Map<string, MonitorInfo>();
const processes = new Map<string, ChildProcess>();
const connections = new Map<string, WebSocket>();
let lastGlobalInterrupt = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

function getStatusIcon(status: MonitorStatus): string {
	switch (status) {
		case "starting":
			return "⏳";
		case "running":
			return "👁";
		case "stopped":
			return "⊘";
		case "error":
			return "✗";
		case "interrupted":
			return "⚠️";
	}
}

function getMonitorSummary(monitor: MonitorInfo): string {
	const icon = getStatusIcon(monitor.status);
	const elapsed = monitor.startedAt
		? formatDuration((monitor.stoppedAt ?? Date.now()) - monitor.startedAt)
		: "—";
	const label = monitor.label || configLabel(monitor.config);
	const patternCount = monitor.patterns.length;
	const eventCount = monitor.events.length;
	const suffix =
		monitor.status === "running"
			? `👁 ${monitor.type}, ${patternCount}p, ${eventCount}e`
			: `${eventCount}e`;
	return `${icon} #${monitor.id.slice(0, 8)} ${label} [${monitor.status}, ${elapsed}, ${suffix}]`;
}

function configLabel(config: MonitorConfig): string {
	if (config.type === "command") {
		return config.command.slice(0, 60);
	}
	return config.url;
}

function resolveMonitorId(input: string): string | undefined {
	if (monitors.has(input)) return input;
	for (const id of monitors.keys()) {
		if (id.startsWith(input)) return id;
	}
	return undefined;
}

function pruneEvents(events: MonitorEvent[]): void {
	if (events.length > MAX_EVENTS) {
		events.splice(0, events.length - MAX_EVENTS);
	}
}

function matchesPattern(line: string, rule: PatternRule): boolean {
	try {
		if (rule.useRegex) {
			return new RegExp(rule.pattern).test(line);
		}
		return line.includes(rule.pattern);
	} catch {
		return line.includes(rule.pattern);
	}
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function persistMonitor(
	appendEntry?: (type: string, data?: unknown) => void,
	monitor?: MonitorInfo,
): void {
	if (!appendEntry || !monitor) return;
	try {
		appendEntry(STORAGE_TYPE, {
			id: monitor.id,
			label: monitor.label,
			type: monitor.type,
			status: monitor.status,
			createdAt: monitor.createdAt,
			startedAt: monitor.startedAt,
			stoppedAt: monitor.stoppedAt,
			config: monitor.config,
			patterns: monitor.patterns,
			events: monitor.events.slice(-MAX_PERSIST_EVENTS),
			error: monitor.error,
			stopReason: monitor.stopReason,
			interruptionCount: monitor.interruptionCount,
		});
	} catch {
		// Best-effort persistence
	}
}

// ─── Widget & Status ────────────────────────────────────────────────────────

function updateWidget(ctx: {
	setWidget?: (id: string, lines?: string[]) => void;
	setStatus?: (id: string, text: string) => void;
}) {
	const running = Array.from(monitors.values()).filter(
		(m) => m.status === "running" || m.status === "starting",
	);
	const total = monitors.size;
	const interrupted = Array.from(monitors.values()).filter(
		(m) => m.status === "interrupted",
	);

	const lines: string[] = [];
	lines.push(
		`Monitors: ${running.length} active / ${interrupted.length} interrupted / ${total} total`,
	);

	if (running.length > 0 && running.length <= 10) {
		for (const m of running) {
			const elapsed = m.startedAt ? formatDuration(Date.now() - m.startedAt) : "—";
			const label = m.label || configLabel(m.config).slice(0, 40);
			const icon = getStatusIcon(m.status);
			lines.push(`  ${icon} ${label} (${elapsed})`);
		}
	}

	if (interrupted.length > 0) {
		for (const m of interrupted) {
			const label = m.label || configLabel(m.config).slice(0, 40);
			lines.push(`  ⚠️ ${label} — ${m.interruptionCount} pattern(s) matched`);
		}
	}

	try {
		ctx.setWidget?.(WIDGET_ID, lines);
		if (running.length > 0 || interrupted.length > 0) {
			const parts: string[] = [];
			if (running.length > 0) {
				parts.push(`👁 ${running.length} monitor${running.length > 1 ? "s" : ""}`);
			}
			if (interrupted.length > 0) {
				parts.push(`⚠️ ${interrupted.length}`);
			}
			ctx.setStatus?.(STATUS_ID, parts.join(" "));
		} else {
			ctx.setStatus?.(STATUS_ID, "");
		}
	} catch {
		// Ignore UI errors
	}
}

// ─── Pattern matching engine ─────────────────────────────────────────────────

function handlePatternMatch(
	monitor: MonitorInfo,
	rule: PatternRule,
	line: string,
	ui: {
		notify?: (message: string, level?: string) => void;
		appendEntry?: (type: string, data?: unknown) => void;
		setWidget?: (id: string, lines?: string[]) => void;
		setStatus?: (id: string, text: string) => void;
	},
) {
	const now = Date.now();

	// Respect cooldown
	if (rule.lastTriggered && rule.cooldown > 0) {
		if (now - rule.lastTriggered < rule.cooldown) return;
	}

	rule.lastTriggered = now;

	// Record match event
	const event: MonitorEvent = {
		timestamp: now,
		type: "match",
		content: line,
		matchedPattern: rule.id,
	};
	monitor.events.push(event);
	pruneEvents(monitor.events);

	// Execute action
	switch (rule.action) {
		case "notify":
			ui.notify?.(
				`[${monitor.label || configLabel(monitor.config)}] Pattern matched: ${line.slice(0, 120)}`,
				"info",
			);
			break;

		case "interrupt": {
			// Global throttle
			if (now - lastGlobalInterrupt < INTERRUPT_GLOBAL_THROTTLE_MS) break;
			lastGlobalInterrupt = now;

			monitor.status = "interrupted";
			monitor.interruptionCount++;
			ui.notify?.(
				`⚠️ [${monitor.label || configLabel(monitor.config)}] Interrupted: ${line.slice(0, 120)}`,
				"warning",
			);
			break;
		}

		case "log":
			// Already recorded in events
			break;
	}

	persistMonitor(ui.appendEntry, monitor);
	updateWidget(ui);
}

function processLine(
	monitor: MonitorInfo,
	line: string,
	ui: {
		notify?: (message: string, level?: string) => void;
		appendEntry?: (type: string, data?: unknown) => void;
		setWidget?: (id: string, lines?: string[]) => void;
		setStatus?: (id: string, text: string) => void;
	},
) {
	// Record line event
	monitor.events.push({
		timestamp: Date.now(),
		type: "line",
		content: line,
	});
	pruneEvents(monitor.events);

	// Check patterns
	for (const rule of monitor.patterns) {
		if (matchesPattern(line, rule)) {
			handlePatternMatch(monitor, rule, line, ui);
		}
	}
}

// ─── Command mode ────────────────────────────────────────────────────────────

type UiHelpers = {
	notify?: (message: string, level?: string) => void;
	appendEntry?: (type: string, data?: unknown) => void;
	setWidget?: (id: string, lines?: string[]) => void;
	setStatus?: (id: string, text: string) => void;
	signal?: AbortSignal;
};

function startCommandMonitor(monitor: MonitorInfo, ui: UiHelpers): void {
	const config = monitor.config as CommandConfig;

	const proc = spawn(config.command, [], {
		cwd: config.cwd,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});

	monitor.status = "running";
	monitor.startedAt = Date.now();
	processes.set(monitor.id, proc);
	persistMonitor(ui.appendEntry, monitor);
	updateWidget(ui);

	// Setup abort signal
	if (ui.signal && !ui.signal.aborted) {
		const onAbort = () => stopMonitor(monitor.id, "aborted", ui);
		ui.signal.addEventListener("abort", onAbort, { once: true });
		proc.on("exit", () => {
			ui.signal?.removeEventListener("abort", onAbort);
		});
	}

	// Line-buffered stdout
	const stdoutLines = createInterface({ input: proc.stdout! });
	stdoutLines.on("line", (line: string) => processLine(monitor, line, ui));

	// Line-buffered stderr
	const stderrLines = createInterface({ input: proc.stderr! });
	stderrLines.on("line", (line: string) => processLine(monitor, line, ui));

	// Handle exit
	proc.on("exit", (exitCode) => {
		processes.delete(monitor.id);
		stdoutLines.close();
		stderrLines.close();

		if (config.restart && monitor.status === "running") {
			// Auto-restart after 1s delay
			setTimeout(() => startCommandMonitor(monitor, ui), 1000);
		} else if (monitor.status === "running" || monitor.status === "starting") {
			monitor.status = "stopped";
			monitor.stoppedAt = Date.now();
			monitor.stopReason = `exit code ${exitCode}`;
			persistMonitor(ui.appendEntry, monitor);
			updateWidget(ui);
		}
	});

	proc.on("error", (err) => {
		processes.delete(monitor.id);
		if (monitor.status === "running" || monitor.status === "starting") {
			monitor.status = "error";
			monitor.error = err.message;
			monitor.stoppedAt = Date.now();
		}
		persistMonitor(ui.appendEntry, monitor);
		updateWidget(ui);
	});
}

// ─── WebSocket mode ──────────────────────────────────────────────────────────

const wsReconnectAttempts = new Map<string, number>();

function startWebSocketMonitor(monitor: MonitorInfo, ui: UiHelpers): void {
	const config = monitor.config as WebSocketConfig;
	const attempts = wsReconnectAttempts.get(monitor.id) ?? 0;

	if (attempts >= RECONNECT_MAX_ATTEMPTS) {
		monitor.status = "error";
		monitor.error = `Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached`;
		monitor.stoppedAt = Date.now();
		wsReconnectAttempts.delete(monitor.id);
		persistMonitor(ui.appendEntry, monitor);
		updateWidget(ui);
		return;
	}

	const ws = new WebSocket(config.url, {
		headers: config.headers as Record<string, string> | undefined,
	});

	monitor.status = "starting";
	persistMonitor(ui.appendEntry, monitor);
	updateWidget(ui);

	ws.on("open", () => {
		monitor.status = "running";
		monitor.startedAt = Date.now();
		wsReconnectAttempts.delete(monitor.id);
		persistMonitor(ui.appendEntry, monitor);
		updateWidget(ui);
	});

	ws.on("message", (data: WebSocket.Data) => {
		const message =
			typeof data === "string"
				? data
				: Buffer.from(data as never).toString("utf-8");
		processLine(monitor, message, ui);
	});

	ws.on("close", () => {
		connections.delete(monitor.id);

		if (
			config.reconnect &&
			(monitor.status === "running" || monitor.status === "starting")
		) {
			const attempt = (wsReconnectAttempts.get(monitor.id) ?? 0) + 1;
			wsReconnectAttempts.set(monitor.id, attempt);

			// Exponential backoff
			const delay = Math.min(
				RECONNECT_BASE_MS * 2 ** (attempt - 1),
				RECONNECT_MAX_MS,
			);

			monitor.status = "starting";
			monitor.startedAt = null;
			persistMonitor(ui.appendEntry, monitor);
			updateWidget(ui);

			setTimeout(() => startWebSocketMonitor(monitor, ui), delay);
		} else if (monitor.status === "running" || monitor.status === "starting") {
			monitor.status = "stopped";
			monitor.stoppedAt = Date.now();
			monitor.stopReason = "connection closed";
			wsReconnectAttempts.delete(monitor.id);
			persistMonitor(ui.appendEntry, monitor);
			updateWidget(ui);
		}
	});

	ws.on("error", (err: Error) => {
		connections.delete(monitor.id);

		if (monitor.status === "running" || monitor.status === "starting") {
			monitor.status = "error";
			monitor.error = err.message;
			monitor.stoppedAt = Date.now();
		}
		wsReconnectAttempts.delete(monitor.id);
		persistMonitor(ui.appendEntry, monitor);
		updateWidget(ui);
	});

	connections.set(monitor.id, ws);
}

// ─── Monitor lifecycle ───────────────────────────────────────────────────────

function startMonitor(monitor: MonitorInfo, ui: UiHelpers): void {
	if (monitors.size >= MAX_ACTIVE_MONITORS) {
		// Count only active (running/starting)
		const active = Array.from(monitors.values()).filter(
			(m) => m.status === "running" || m.status === "starting",
		).length;
		if (active >= MAX_ACTIVE_MONITORS) {
			monitor.status = "error";
			monitor.error = `Max active monitors (${MAX_ACTIVE_MONITORS}) reached. Stop one first.`;
			monitor.stoppedAt = Date.now();
			persistMonitor(ui.appendEntry, monitor);
			return;
		}
	}

	if (monitor.config.type === "command") {
		startCommandMonitor(monitor, ui);
	} else {
		startWebSocketMonitor(monitor, ui);
	}
}

function stopMonitor(id: string, reason: string, ui?: UiHelpers): boolean {
	const monitor = monitors.get(id);
	if (!monitor) return false;
	if (
		monitor.status !== "running" &&
		monitor.status !== "starting" &&
		monitor.status !== "interrupted"
	) {
		return false;
	}

	monitor.status = "stopped";
	monitor.stopReason = reason;
	monitor.stoppedAt = Date.now();
	wsReconnectAttempts.delete(id);

	// Stop process
	const proc = processes.get(id);
	if (proc) {
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, STOP_GRACE_MS);
		processes.delete(id);
	}

	// Close WebSocket
	const ws = connections.get(id);
	if (ws) {
		ws.close();
		connections.delete(id);
	}

	if (ui) {
		persistMonitor(ui.appendEntry, monitor);
		updateWidget(ui);
	}

	return true;
}

function stopAllMonitors(reason = "session_shutdown") {
	for (const [id] of monitors) {
		if (
			monitors.get(id)?.status === "running" ||
			monitors.get(id)?.status === "starting" ||
			monitors.get(id)?.status === "interrupted"
		) {
			stopMonitor(id, reason);
		}
	}
}

// ─── Permission gating ───────────────────────────────────────────────────────

function setupPermissionGating(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "monitor_start" && event.input.type === "command") {
			const cmd = (event.input as { command?: unknown }).command;
			const ok = await ctx.ui.confirm(
				"Monitor Permission",
				`Allow monitoring: ${typeof cmd === "string" ? cmd.slice(0, 200) : ""}`,
			);
			if (!ok) {
				return {
					block: true,
					reason: "Command monitor denied by user",
				};
			}
		}
	});
}

// ─── Tool implementations ─────────────────────────────────────────────────────

interface MonitorStartParams {
	type: "command" | "websocket";
	label?: string;
	command?: string;
	cwd?: string;
	restart?: boolean;
	url?: string;
	headers?: Record<string, string>;
	reconnect?: boolean;
	patterns?: Array<{
		pattern: string;
		useRegex?: boolean;
		action?: "notify" | "log" | "interrupt";
		cooldown?: number;
	}>;
}

async function toolMonitorStart(
	params: MonitorStartParams,
	signal: AbortSignal,
	onUpdate: ((update: { content?: TextPart[] }) => void) | undefined,
	ctx: {
		ui: ExtensionContext["ui"];
		appendEntry?: ExtensionAPI["appendEntry"];
		cwd: string;
	},
): Promise<{
	content: TextPart[];
	details: MonitorDetails;
	isError?: boolean;
}> {
	const id = uuidv7();
	const now = Date.now();

	// Validate based on type
	if (params.type === "command" && !params.command) {
		return {
			content: [
				{ type: "text", text: "Error: command is required for type 'command'" },
			],
			details: { monitors: Array.from(monitors.values()), runningCount: 0 },
			isError: true,
		};
	}
	if (params.type === "websocket" && !params.url) {
		return {
			content: [
				{ type: "text", text: "Error: url is required for type 'websocket'" },
			],
			details: { monitors: Array.from(monitors.values()), runningCount: 0 },
			isError: true,
		};
	}

	const config: MonitorConfig =
		params.type === "command"
			? {
					type: "command",
					command: params.command!,
					cwd: params.cwd || ctx.cwd,
					restart: params.restart ?? false,
				}
			: {
					type: "websocket",
					url: params.url!,
					headers: params.headers,
					reconnect: params.reconnect ?? false,
				};

	const patterns: PatternRule[] = (params.patterns || []).map((p) => ({
		id: uuidv7().slice(0, 8),
		pattern: p.pattern,
		useRegex: p.useRegex ?? false,
		action: p.action ?? "log",
		cooldown: p.cooldown ?? 0,
		lastTriggered: null,
	}));

	const monitor: MonitorInfo = {
		id,
		label: params.label || configLabel(config),
		type: params.type,
		status: "starting",
		createdAt: now,
		startedAt: null,
		stoppedAt: null,
		config,
		patterns,
		events: [],
		interruptionCount: 0,
	};

	monitors.set(monitor.id, monitor);

	// Start monitoring in background
	startMonitor(monitor, {
		notify: (msg, level) =>
			ctx.ui.notify(msg, level as "info" | "warning" | "error"),
		appendEntry: ctx.appendEntry,
		setWidget: (id, lines) => ctx.ui.setWidget(id, lines ?? []),
		setStatus: (id, text) => ctx.ui.setStatus(id, text),
		signal,
	});

	onUpdate?.({
		content: [{ type: "text", text: `Monitor #${id.slice(0, 8)} starting...` }],
	});

	ctx.ui.notify(
		`Monitor started: ${monitor.label} (#${id.slice(0, 8)})`,
		"info",
	);

	return {
		content: [
			{
				type: "text",
				text: [
					`Monitor started: #${id.slice(0, 8)}`,
					`  Label: ${monitor.label}`,
					`  Type: ${params.type}`,
					params.type === "command"
						? `  Command: ${params.command}`
						: `  URL: ${params.url}`,
					`  Patterns: ${patterns.length}`,
					`  ID: ${id}`,
					``,
					`Use monitor_status with this ID to check events.`,
					`Use monitor_stop with this ID to stop.`,
					`Use monitor_pattern to add/remove patterns on the fly.`,
				].join("\n"),
			},
		],
		details: {
			monitors: [monitor],
			runningCount: Array.from(monitors.values()).filter(
				(m) => m.status === "running",
			).length,
		} satisfies MonitorDetails,
	};
}

async function toolMonitorStop(
	params: { monitorId: string },
	_ctx: {
		ui: ExtensionContext["ui"];
		appendEntry?: ExtensionAPI["appendEntry"];
	},
): Promise<{
	content: TextPart[];
	details: MonitorDetails;
	isError?: boolean;
}> {
	const resolvedId = resolveMonitorId(params.monitorId);
	if (!resolvedId) {
		return {
			content: [{ type: "text", text: `Monitor not found: ${params.monitorId}` }],
			details: { monitors: Array.from(monitors.values()), runningCount: 0 },
			isError: true,
		};
	}

	const monitor = monitors.get(resolvedId)!;
	const stopped = stopMonitor(resolvedId, "manual", {
		notify: (msg, level) =>
			_ctx.ui.notify(msg, level as "info" | "warning" | "error"),
		appendEntry: _ctx.appendEntry,
		setWidget: (id, lines) => _ctx.ui.setWidget(id, lines ?? []),
		setStatus: (id, text) => _ctx.ui.setStatus(id, text),
	});

	if (!stopped) {
		return {
			content: [
				{
					type: "text",
					text: `Monitor #${resolvedId.slice(0, 8)} is already ${monitor.status} (not running). No action taken.`,
				},
			],
			details: {
				monitors: Array.from(monitors.values()),
				runningCount: Array.from(monitors.values()).filter(
					(m) => m.status === "running",
				).length,
			} satisfies MonitorDetails,
		};
	}

	_ctx.ui.notify(`Monitor stopped: ${monitor.label}`, "info");

	return {
		content: [
			{
				type: "text",
				text: `Monitor #${resolvedId.slice(0, 8)} ("${monitor.label}") has been stopped.`,
			},
		],
		details: {
			monitors: Array.from(monitors.values()),
			runningCount: Array.from(monitors.values()).filter(
				(m) => m.status === "running",
			).length,
		} satisfies MonitorDetails,
	};
}

async function toolMonitorList(params: { status?: string }): Promise<{
	content: TextPart[];
	details: MonitorDetails;
}> {
	let all = Array.from(monitors.values());
	if (params.status) {
		all = all.filter((m) => m.status === params.status);
	}

	all.sort((a, b) => b.createdAt - a.createdAt);

	if (all.length === 0) {
		return {
			content: [
				{
					type: "text",
					text: params.status
						? `No monitors with status "${params.status}".`
						: "No monitors have been started yet.",
				},
			],
			details: { monitors: [], runningCount: 0 } satisfies MonitorDetails,
		};
	}

	const running = all.filter(
		(m) => m.status === "running" || m.status === "starting",
	);
	const summary = [
		`Monitors: ${all.length} total, ${running.length} active`,
		"",
		...all.map(getMonitorSummary),
	].join("\n");

	return {
		content: [{ type: "text", text: summary }],
		details: {
			monitors: all,
			runningCount: running.length,
		} satisfies MonitorDetails,
	};
}

async function toolMonitorStatus(params: {
	monitorId: string;
	showEvents?: boolean;
	eventLimit?: number;
}): Promise<{
	content: TextPart[];
	details: MonitorDetails;
	isError?: boolean;
}> {
	const resolvedId = resolveMonitorId(params.monitorId);
	if (!resolvedId) {
		return {
			content: [{ type: "text", text: `Monitor not found: ${params.monitorId}` }],
			details: { monitors: [], runningCount: 0 },
			isError: true,
		};
	}

	const monitor = monitors.get(resolvedId)!;
	const showEvents = params.showEvents ?? true;
	const eventLimit = params.eventLimit ?? 50;

	const parts: string[] = [
		`Monitor: #${monitor.id.slice(0, 8)} (full: ${monitor.id})`,
		`  Label:     ${monitor.label}`,
		`  Type:      ${monitor.type}`,
		monitor.type === "command"
			? `  Command:   ${(monitor.config as CommandConfig).command}`
			: `  URL:       ${(monitor.config as WebSocketConfig).url}`,
		`  Status:    ${getStatusIcon(monitor.status)} ${monitor.status}`,
		`  Created:   ${formatTimestamp(monitor.createdAt)}`,
		`  Started:   ${monitor.startedAt ? formatTimestamp(monitor.startedAt) : "—"}`,
		`  Stopped:   ${monitor.stoppedAt ? formatTimestamp(monitor.stoppedAt) : "—"}`,
		`  Duration:  ${formatDuration(monitor.startedAt ? (monitor.stoppedAt ?? Date.now()) - monitor.startedAt : null)}`,
		`  Patterns:  ${monitor.patterns.length}${monitor.patterns.length > 0 ? ` (${monitor.patterns.map((p) => `${p.id}="${p.pattern}"[${p.action}]`).join(", ")})` : ""}`,
		`  Events:    ${monitor.events.length}`,
		`  Interrupts: ${monitor.interruptionCount}`,
	];

	if (monitor.error) parts.push(`  Error:     ${monitor.error}`);
	if (monitor.stopReason) parts.push(`  Stop:      ${monitor.stopReason}`);
	if ((monitor.config as CommandConfig).restart)
		parts.push(`  Auto-restart: yes`);
	if ((monitor.config as WebSocketConfig).reconnect)
		parts.push(`  Auto-reconnect: yes`);

	if (showEvents && monitor.events.length > 0) {
		const recent = monitor.events.slice(-Math.min(eventLimit, MAX_EVENTS));
		parts.push("", `─── Recent Events (${recent.length}) ───`);
		for (const ev of recent) {
			const ts = formatTimestamp(ev.timestamp);
			const icon =
				ev.type === "match"
					? "⚡"
					: ev.type === "error"
						? "✗"
						: ev.type === "status"
							? "●"
							: " ";
			parts.push(`  ${ts} ${icon} ${ev.content.slice(0, 200)}`);
		}
	}

	if (!showEvents && monitor.events.length > 0) {
		parts.push("", `(use showEvents: true to see events)`);
	}

	return {
		content: [{ type: "text", text: parts.join("\n") }],
		details: {
			monitors: [monitor],
			runningCount: Array.from(monitors.values()).filter(
				(m) => m.status === "running",
			).length,
		} satisfies MonitorDetails,
	};
}

async function toolMonitorPattern(
	params: {
		monitorId: string;
		action: "add" | "remove" | "list";
		pattern?: string;
		useRegex?: boolean;
		patternAction?: "notify" | "log" | "interrupt";
		patternId?: string;
		cooldown?: number;
	},
	_ctx: { appendEntry?: ExtensionAPI["appendEntry"] },
): Promise<{
	content: TextPart[];
	details: MonitorDetails;
	isError?: boolean;
}> {
	const resolvedId = resolveMonitorId(params.monitorId);
	if (!resolvedId) {
		return {
			content: [{ type: "text", text: `Monitor not found: ${params.monitorId}` }],
			details: { monitors: [], runningCount: 0 },
			isError: true,
		};
	}

	const monitor = monitors.get(resolvedId)!;

	switch (params.action) {
		case "add": {
			if (!params.pattern) {
				return {
					content: [
						{ type: "text", text: "Error: pattern is required for 'add' action" },
					],
					details: { monitors: [monitor], runningCount: 0 },
					isError: true,
				};
			}
			const rule: PatternRule = {
				id: uuidv7().slice(0, 8),
				pattern: params.pattern,
				useRegex: params.useRegex ?? false,
				action: params.patternAction ?? "log",
				cooldown: params.cooldown ?? 0,
				lastTriggered: null,
			};
			monitor.patterns.push(rule);
			persistMonitor(_ctx.appendEntry, monitor);
			return {
				content: [
					{
						type: "text",
						text: `Pattern added to #${resolvedId.slice(0, 8)}: id="${rule.id}" pattern="${rule.pattern}" action=${rule.action}${rule.useRegex ? " (regex)" : ""}`,
					},
				],
				details: {
					monitors: [monitor],
					runningCount: Array.from(monitors.values()).filter(
						(m) => m.status === "running",
					).length,
				} satisfies MonitorDetails,
			};
		}

		case "remove": {
			if (!params.patternId) {
				return {
					content: [
						{
							type: "text",
							text: "Error: patternId is required for 'remove' action",
						},
					],
					details: { monitors: [monitor], runningCount: 0 },
					isError: true,
				};
			}
			const idx = monitor.patterns.findIndex((p) => p.id === params.patternId);
			if (idx === -1) {
				return {
					content: [
						{ type: "text", text: `Pattern not found: ${params.patternId}` },
					],
					details: { monitors: [monitor], runningCount: 0 },
					isError: true,
				};
			}
			const removed = monitor.patterns.splice(idx, 1)[0];
			persistMonitor(_ctx.appendEntry, monitor);
			return {
				content: [
					{
						type: "text",
						text: `Pattern removed from #${resolvedId.slice(0, 8)}: id="${removed.id}" pattern="${removed.pattern}"`,
					},
				],
				details: {
					monitors: [monitor],
					runningCount: Array.from(monitors.values()).filter(
						(m) => m.status === "running",
					).length,
				} satisfies MonitorDetails,
			};
		}

		case "list": {
			if (monitor.patterns.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No patterns on monitor #${resolvedId.slice(0, 8)}.`,
						},
					],
					details: {
						monitors: [monitor],
						runningCount: Array.from(monitors.values()).filter(
							(m) => m.status === "running",
						).length,
					} satisfies MonitorDetails,
				};
			}
			const lines = monitor.patterns.map(
				(p) =>
					`  ${p.id}: "${p.pattern}" [${p.action}]${p.useRegex ? " (regex)" : ""}${p.cooldown ? ` cooldown=${p.cooldown}ms` : ""}`,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Patterns on #${resolvedId.slice(0, 8)} (${monitor.patterns.length}):`,
							...lines,
						].join("\n"),
					},
				],
				details: {
					monitors: [monitor],
					runningCount: Array.from(monitors.values()).filter(
						(m) => m.status === "running",
					).length,
				} satisfies MonitorDetails,
			};
		}
	}
}

// ─── TUI command ─────────────────────────────────────────────────────────────

function setupTuiCommand(pi: ExtensionAPI) {
	pi.registerCommand("monitors", {
		description: "Show all monitors with interactive TUI view",
		handler: async (_args, ctx) => {
			const all = Array.from(monitors.values()).sort(
				(a, b) => b.createdAt - a.createdAt,
			);

			if (all.length === 0) {
				ctx.ui.notify("No monitors.", "info");
				return;
			}

			// Non-TUI fallback
			if (ctx.mode !== "tui") {
				for (const m of all) {
					console.log(getMonitorSummary(m));
				}
				return;
			}

			// Interactive TUI dialog
			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const renderMonitors = (width: number): string[] => {
					const lines: string[] = [];
					const th = theme;

					lines.push("");
					lines.push(
						th.fg("accent", th.bold(" Monitors ")) +
							th.fg("muted", ` (${all.length} total)`),
					);
					lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, 60))));
					lines.push("");

					for (const m of all) {
						const icon =
							m.status === "starting"
								? th.fg("accent", "⏳")
								: m.status === "running"
									? th.fg("accent", "👁")
									: m.status === "stopped"
										? th.fg("dim", "⊘")
										: m.status === "error"
											? th.fg("error", "✗")
											: th.fg("warning", "⚠️");

						const shortId = th.fg("dim", `#${m.id.slice(0, 8)}`);
						const label = m.label || configLabel(m.config).slice(0, 60);
						const elapsed = m.startedAt
							? th.fg(
									"muted",
									formatDuration((m.stoppedAt ?? Date.now()) - m.startedAt),
								)
							: "";
						const typeTag = th.fg("muted", m.type === "command" ? "cmd" : "ws");

						lines.push(`  ${icon} ${shortId} ${label} ${typeTag} ${elapsed}`);

						// Show matched patterns for interrupted monitors
						if (m.status === "interrupted" && m.interruptionCount > 0) {
							lines.push(
								`    ${th.fg("warning", `⚠️ ${m.interruptionCount} pattern(s) matched — needs attention`)}`,
							);
						}
					}

					lines.push("");
					lines.push(th.fg("dim", " Press Escape or Ctrl+C to close"));
					lines.push("");

					return lines;
				};

				return {
					render: (width: number) => renderMonitors(width),
					invalidate: () => {},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							done(undefined);
						}
					},
				};
			});
		},
	});
}

// ─── Session hooks ───────────────────────────────────────────────────────────

function onSessionStart(ctx: {
	ui: ExtensionContext["ui"];
	sessionManager?: { getEntries: () => Array<{ type: string; data?: unknown }> };
	appendEntry?: ExtensionAPI["appendEntry"];
}) {
	// Restore from session entries
	try {
		const entries =
			(
				ctx as {
					sessionManager?: {
						getEntries: () => Array<{ type: string; data?: unknown }>;
					};
				}
			).sessionManager?.getEntries() ?? [];
		for (const entry of entries) {
			if (
				entry.type === STORAGE_TYPE &&
				entry.data &&
				typeof entry.data === "object" &&
				"id" in (entry.data as Record<string, unknown>)
			) {
				const data = entry.data as Record<string, unknown>;
				if (!monitors.has(data.id as string)) {
					const restored: MonitorInfo = {
						id: data.id as string,
						label: (data.label as string) || "",
						type: (data.type as MonitorType) || "command",
						status: "stopped", // Never auto-restart
						createdAt: (data.createdAt as number) || 0,
						startedAt: null,
						stoppedAt: (data.stoppedAt as number) || Date.now(),
						config: data.config as MonitorConfig,
						patterns: (data.patterns as PatternRule[]) || [],
						events: (data.events as MonitorEvent[]) || [],
						error: (data.error as string) || undefined,
						stopReason: (data.stopReason as string) || "session_restored",
						interruptionCount: (data.interruptionCount as number) || 0,
					};
					monitors.set(restored.id, restored);
				}
			}
		}
	} catch {
		// Best-effort restore
	}

	updateWidget({
		setWidget: (id, lines) => ctx.ui.setWidget(id, lines ?? []),
		setStatus: (id, text) => ctx.ui.setStatus(id, text),
	});
}

// ─── Custom rendering ────────────────────────────────────────────────────────

function renderCall(
	args: Record<string, unknown>,
	theme: {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	},
	_context: unknown,
): Text {
	const t = theme;
	const action = args.action || "start";
	const type = args.type || args.monitorId || "";
	const label = args.label || args.command || args.url || "";

	if (action === "add" || action === "remove") {
		return new Text(
			`${t.fg?.("accent", t.bold?.("🔍 monitor_pattern") ?? "🔍 monitor_pattern")} ${action} pattern on #${String(type).slice(0, 8)}`,
			0,
			0,
		);
	}

	if (action === "list") {
		return new Text(
			`${t.fg?.("accent", t.bold?.("🔍 monitor_pattern") ?? "🔍 monitor_pattern")} list patterns on #${String(type).slice(0, 8)}`,
			0,
			0,
		);
	}

	return new Text(
		`${t.fg?.("accent", t.bold?.("🔍 monitor") ?? "🔍 monitor")} ${String(args.type || "?")} ${String(String(label).slice(0, 60))}`,
		0,
		0,
	);
}

function renderResult(
	result: AgentToolResult<{
		monitors?: MonitorInfo[];
		runningCount?: number;
	}>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	_context: unknown,
): Text {
	const t = theme;
	const monitorsList = result.details?.monitors || [];
	const active = result.details?.runningCount ?? 0;

	if (monitorsList.length === 0) {
		return new Text(t.fg?.("muted", "No monitors") ?? "No monitors", 0, 0);
	}

	const lines: string[] = [
		t.fg?.("accent", `👁 ${active} active monitor(s)`) ??
			`${active} active monitor(s)`,
	];

	for (const m of monitorsList.slice(0, 5)) {
		const icon = getStatusIcon(m.status);
		const label = m.label || configLabel(m.config).slice(0, 50);
		const elapsed = m.startedAt
			? formatDuration((m.stoppedAt ?? Date.now()) - m.startedAt)
			: "";
		lines.push(`  ${icon} #${m.id.slice(0, 8)} ${label} ${elapsed}`);
	}

	if (monitorsList.length > 5) {
		lines.push(
			t.fg?.("muted", `  ... and ${monitorsList.length - 5} more`) ??
				`  ... and ${monitorsList.length - 5} more`,
		);
	}

	return new Text(lines.join("\n"), 0, 0);
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Permission gating for command monitors
	setupPermissionGating(pi);

	// ── Tool: monitor_start ──
	pi.registerTool({
		name: "monitor_start",
		label: "Start Monitor",
		description: [
			"Start monitoring a command output or WebSocket stream.",
			"Returns immediately with a monitor ID for status tracking.",
			"Supports pattern matching: notify, log, or interrupt when a pattern is matched.",
			"Command mode requires user confirmation.",
		].join(" "),
		parameters: Type.Object({
			type: Type.Union([Type.Literal("command"), Type.Literal("websocket")], {
				description:
					"Type of monitor: command (tail logs, watch CI) or websocket (stream feeds)",
			}),
			label: Type.Optional(
				Type.String({
					description: "Optional human-readable label for this monitor",
				}),
			),
			// Command mode
			command: Type.Optional(
				Type.String({
					description: "Shell command to run (required for type='command')",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for command (defaults to current)",
				}),
			),
			restart: Type.Optional(
				Type.Boolean({
					description: "Auto-restart command on exit (default: false)",
				}),
			),
			// WebSocket mode
			url: Type.Optional(
				Type.String({
					description: "WebSocket URL to connect to (required for type='websocket')",
				}),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Optional HTTP headers for WebSocket connection",
				}),
			),
			reconnect: Type.Optional(
				Type.Boolean({
					description: "Auto-reconnect WebSocket on close (default: false)",
				}),
			),
			// Patterns
			patterns: Type.Optional(
				Type.Array(
					Type.Object({
						pattern: Type.String({ description: "Text or regex pattern to match" }),
						useRegex: Type.Optional(
							Type.Boolean({ description: "Treat pattern as regex (default: false)" }),
						),
						action: Type.Optional(
							Type.Union(
								[
									Type.Literal("notify"),
									Type.Literal("log"),
									Type.Literal("interrupt"),
								],
								{
									description:
										"Action on match: notify user, log to events, or interrupt (default: log)",
								},
							),
						),
						cooldown: Type.Optional(
							Type.Number({ description: "Minimum ms between triggers (default: 0)" }),
						),
					}),
					{ description: "Patterns to match against stream lines" },
				),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return toolMonitorStart(
				params as MonitorStartParams,
				signal,
				onUpdate as ((update: { content?: TextPart[] }) => void) | undefined,
				ctx as {
					ui: ExtensionContext["ui"];
					appendEntry?: ExtensionAPI["appendEntry"];
					cwd: string;
				},
			);
		},
		renderCall,
		renderResult,
	});

	// ── Tool: monitor_stop ──
	pi.registerTool({
		name: "monitor_stop",
		label: "Stop Monitor",
		description:
			"Stop a running monitor by ID. Sends SIGTERM (process) or close (WebSocket).",
		parameters: Type.Object({
			monitorId: Type.String({
				description: "ID of the monitor to stop (full or short ID)",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolMonitorStop(
				params as { monitorId: string },
				ctx as {
					ui: ExtensionContext["ui"];
					appendEntry?: ExtensionAPI["appendEntry"];
				},
			);
		},
		renderCall,
		renderResult,
	});

	// ── Tool: monitor_list ──
	pi.registerTool({
		name: "monitor_list",
		label: "List Monitors",
		description:
			"List all monitors with their status, type, uptime, and event count.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.String({
					description:
						"Optional filter: running, stopped, error, interrupted, starting",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return toolMonitorList(params as { status?: string });
		},
		renderCall,
		renderResult,
	});

	// ── Tool: monitor_status ──
	pi.registerTool({
		name: "monitor_status",
		label: "Get Monitor Status",
		description:
			"Get detailed status and recent events of a specific monitor by ID.",
		parameters: Type.Object({
			monitorId: Type.String({
				description: "ID of the monitor (full or short ID)",
			}),
			showEvents: Type.Optional(
				Type.Boolean({
					description: "Include events in the response (default: true)",
				}),
			),
			eventLimit: Type.Optional(
				Type.Number({ description: "Max events to show (default: 50, max: 200)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return toolMonitorStatus(
				params as { monitorId: string; showEvents?: boolean; eventLimit?: number },
			);
		},
		renderCall,
		renderResult,
	});

	// ── Tool: monitor_pattern ──
	pi.registerTool({
		name: "monitor_pattern",
		label: "Manage Monitor Patterns",
		description: [
			"Add, remove, or list patterns on a running or stopped monitor.",
			"Patterns can trigger notify, log, or interrupt actions when matched against stream lines.",
		].join(" "),
		parameters: Type.Object({
			monitorId: Type.String({ description: "ID of the monitor" }),
			action: Type.Union(
				[Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")],
				{
					description:
						"Action: add a pattern, remove by patternId, or list all patterns",
				},
			),
			pattern: Type.Optional(
				Type.String({
					description: "Text or regex pattern to match (required for add)",
				}),
			),
			useRegex: Type.Optional(
				Type.Boolean({ description: "Treat pattern as regex (default: false)" }),
			),
			patternAction: Type.Optional(
				Type.Union(
					[Type.Literal("notify"), Type.Literal("log"), Type.Literal("interrupt")],
					{ description: "Action on match (default: log)" },
				),
			),
			patternId: Type.Optional(
				Type.String({ description: "Pattern ID to remove (required for remove)" }),
			),
			cooldown: Type.Optional(
				Type.Number({ description: "Minimum ms between triggers (default: 0)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolMonitorPattern(
				params as {
					monitorId: string;
					action: "add" | "remove" | "list";
					pattern?: string;
					useRegex?: boolean;
					patternAction?: "notify" | "log" | "interrupt";
					patternId?: string;
					cooldown?: number;
				},
				ctx as { appendEntry?: ExtensionAPI["appendEntry"] },
			);
		},
		renderCall,
		renderResult,
	});

	// ── Command: /monitors ──
	setupTuiCommand(pi);

	// ── Lifecycle: session hooks ──
	pi.on("session_start", (_event, ctx) => {
		onSessionStart(
			ctx as {
				ui: ExtensionContext["ui"];
				sessionManager?: {
					getEntries: () => Array<{ type: string; data?: unknown }>;
				};
				appendEntry?: ExtensionAPI["appendEntry"];
			},
		);
	});

	pi.on("session_shutdown", () => {
		stopAllMonitors("session_shutdown");
		updateWidget({
			setWidget: () => {},
			setStatus: () => {},
		});
	});
}
