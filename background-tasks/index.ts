/**
 * Background Tasks Extension - Full Task System
 *
 * Implements background task execution, status tracking, and task lifecycle
 * management for Pi coding agent.
 *
 * Features:
 *   - `task_run`: Spawn a shell command/task in the background
 *   - `task_stop`: Stop/cancel a running task by ID
 *   - `task_list`: List all tasks (running, completed, failed, stopped)
 *   - `task_status`: Get detailed status/output of a specific task
 *   - `/tasks` command: Interactive TUI view of all tasks
 *   - Widget showing running task count
 *   - Persistence via session entries for task history
 *   - Auto-cleanup on session shutdown
 */

import { spawn, type ChildProcess } from "node:child_process";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus =
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "timeout";

export interface TaskInfo {
	id: string;
	label: string;
	command: string;
	cwd: string;
	status: TaskStatus;
	pid: number | null;
	createdAt: number;
	startedAt: number | null;
	completedAt: number | null;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timeout: number | null; // ms, null = no timeout
	error?: string;
	stopReason?: string;
}

interface TaskDetails {
	tasks: TaskInfo[];
	runningCount: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_STORAGE_TYPE = "background-task";
const WIDGET_ID = "background-tasks";
const STATUS_ID = "bg-tasks";
const STOP_GRACE_MS = 5000; // SIGTERM → SIGKILL grace period
const MAX_LOG_LINES = 200;

// ─── In-memory task store ────────────────────────────────────────────────────

const tasks = new Map<string, TaskInfo>();
const processes = new Map<string, ChildProcess>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function truncateOutput(text: string, maxLines = MAX_LOG_LINES): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return (
		lines.slice(0, maxLines).join("\n") +
		`\n\n... [${lines.length - maxLines} more lines truncated]`
	);
}

function formatDuration(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

function formatBytes(text: string): string {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getTaskSummary(task: TaskInfo): string {
	const icon =
		task.status === "running"
			? "⏳"
			: task.status === "completed"
				? "✓"
				: task.status === "failed"
					? "✗"
					: task.status === "stopped"
						? "⊘"
						: "⏰";
	const elapsed =
		task.completedAt && task.startedAt
			? formatDuration(task.completedAt - task.startedAt)
			: task.startedAt
				? formatDuration(Date.now() - task.startedAt)
				: "—";
	const label = task.label || task.command.slice(0, 60);
	return `${icon} #${task.id.slice(0, 8)} ${label} [${task.status}, ${elapsed}]`;
}

function persistTask(
	ctx:
		| { appendEntry?: (type: string, data?: unknown) => void }
		| { sessionManager?: unknown },
	task: TaskInfo,
): void {
	// Attempt to persist via session appendEntry — safe to call without session
	try {
		const append = (
			ctx as { appendEntry?: (type: string, data?: unknown) => void }
		).appendEntry;
		if (append) {
			append(TASK_STORAGE_TYPE, {
				id: task.id,
				label: task.label,
				command: task.command,
				cwd: task.cwd,
				status: task.status,
				pid: task.pid,
				createdAt: task.createdAt,
				startedAt: task.startedAt,
				completedAt: task.completedAt,
				exitCode: task.exitCode,
				stdout: truncateOutput(task.stdout, 50),
				stderr: truncateOutput(task.stderr, 20),
				timeout: task.timeout,
				error: task.error,
				stopReason: task.stopReason,
			});
		}
	} catch {
		// Silently fail — persistence is best-effort
	}
}

function updateWidget(ctx: {
	setWidget?: (id: string, lines?: string[]) => void;
	setStatus?: (id: string, text: string) => void;
	theme?: { fg?: (color: string, text: string) => string };
}) {
	const running = Array.from(tasks.values()).filter(
		(t) => t.status === "running",
	);
	const total = tasks.size;

	const lines: string[] = [];
	lines.push(`Tasks: ${running.length} running / ${total} total`);

	if (running.length > 0 && running.length <= 10) {
		for (const task of running) {
			const elapsed = task.startedAt
				? formatDuration(Date.now() - task.startedAt)
				: "—";
			const label = task.label || task.command.slice(0, 40);
			lines.push(`  ⏳ ${label} (${elapsed})`);
		}
	}

	try {
		ctx.setWidget?.(WIDGET_ID, lines);
		if (running.length > 0) {
			ctx.setStatus?.(
				STATUS_ID,
				`⏳ ${running.length} bg task${running.length > 1 ? "s" : ""}`,
			);
		} else {
			ctx.setStatus?.(STATUS_ID, "");
		}
	} catch {
		// Ignore UI errors (e.g. in non-TUI mode)
	}
}

// ─── Background execution ────────────────────────────────────────────────────

type UiHelpers = {
	setWidget?: (id: string, lines?: string[]) => void;
	setStatus?: (id: string, text: string) => void;
	notify?: (message: string, level?: string) => void;
	appendEntry?: (type: string, data?: unknown) => void;
	signal?: AbortSignal;
};

async function startBackgroundTask(
	task: TaskInfo,
	ui: UiHelpers,
): Promise<void> {
	task.startedAt = Date.now();
	task.status = "running";
	tasks.set(task.id, task);

	const proc = spawn(task.command, [], {
		cwd: task.cwd,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});

	task.pid = proc.pid ?? null;
	processes.set(task.id, proc);
	persistTask(ui, task);
	updateWidget(ui);

	// Setup abort signal listener
	if (ui.signal && !ui.signal.aborted) {
		const onAbort = () => {
			stopTask(task.id, "aborted");
		};
		ui.signal.addEventListener("abort", onAbort, { once: true });
		proc.on("exit", () => {
			ui.signal?.removeEventListener("abort", onAbort);
		});
	}

	// Capture stdout
	proc.stdout?.on("data", (data: Buffer) => {
		task.stdout += data.toString("utf-8");
		if (task.stdout.length > 1024 * 1024) {
			task.stdout =
				task.stdout.slice(-512 * 1024) + "\n... [stdout truncated at 512KB]";
		}
	});

	// Capture stderr
	proc.stderr?.on("data", (data: Buffer) => {
		task.stderr += data.toString("utf-8");
		if (task.stderr.length > 256 * 1024) {
			task.stderr =
				task.stderr.slice(-128 * 1024) + "\n... [stderr truncated at 128KB]";
		}
	});

	// Handle timeout
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	if (task.timeout && task.timeout > 0) {
		timeoutHandle = setTimeout(() => {
			if (task.status === "running") {
				task.status = "timeout";
				task.stopReason = `timeout after ${formatDuration(task.timeout)}`;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 2000);
				persistTask(ui, task);
				updateWidget(ui);
			}
		}, task.timeout);
	}

	// Handle process exit
	proc.on("close", (exitCode) => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		processes.delete(task.id);

		// Only update if not already stopped/timeout (which may have set status)
		if (task.status === "running") {
			task.status = exitCode === 0 ? "completed" : "failed";
		}
		task.completedAt = Date.now();
		task.exitCode = exitCode;
		persistTask(ui, task);
		updateWidget(ui);
	});

	proc.on("error", (err) => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		processes.delete(task.id);
		if (task.status === "running") {
			task.status = "failed";
			task.error = err.message;
			task.completedAt = Date.now();
		}
		persistTask(ui, task);
		updateWidget(ui);
	});
}

function stopTask(taskId: string, reason = "manual"): boolean {
	const proc = processes.get(taskId);
	const task = tasks.get(taskId);
	if (!task) return false;

	if (task.status !== "running") return false;

	task.status = "stopped";
	task.stopReason = reason;
	task.completedAt = Date.now();

	if (proc) {
		proc.kill("SIGTERM");
		// Force kill after grace period
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, STOP_GRACE_MS);
		processes.delete(taskId);
	}

	return true;
}

// ─── Persist running tasks to session on shutdown ────────────────────────────

function stopAllTasks(reason = "session_shutdown") {
	for (const [id] of processes) {
		stopTask(id, reason);
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Lifecycle: clean up on session shutdown ──
	pi.on("session_shutdown", () => {
		stopAllTasks("session_shutdown");
	});

	// ── Lifecycle: restore widget on new session ──
	pi.on("session_start", (_event, ctx) => {
		// Restore previously persisted tasks from session entries
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			const type = (entry as { type: string }).type;
			const data = (entry as { data?: unknown }).data;
			if (
				type === TASK_STORAGE_TYPE &&
				data &&
				typeof data === "object" &&
				"id" in (data as Record<string, unknown>)
			) {
				if (!tasks.has((data as Record<string, unknown>).id as string)) {
					const restoredTask: TaskInfo = {
						id: (data as Record<string, unknown>).id as string,
						label: ((data as Record<string, unknown>).label as string) || "",
						command: ((data as Record<string, unknown>).command as string) || "",
						cwd: ((data as Record<string, unknown>).cwd as string) || ctx.cwd,
						status:
							((data as Record<string, unknown>).status as TaskStatus) || "completed",
						pid: null,
						createdAt: ((data as Record<string, unknown>).createdAt as number) || 0,
						startedAt:
							((data as Record<string, unknown>).startedAt as number) || null,
						completedAt:
							((data as Record<string, unknown>).completedAt as number) || null,
						exitCode: ((data as Record<string, unknown>).exitCode as number) || null,
						stdout: ((data as Record<string, unknown>).stdout as string) || "",
						stderr: ((data as Record<string, unknown>).stderr as string) || "",
						timeout: ((data as Record<string, unknown>).timeout as number) || null,
						error: ((data as Record<string, unknown>).error as string) || undefined,
						stopReason:
							((data as Record<string, unknown>).stopReason as string) || undefined,
					};
					tasks.set(restoredTask.id, restoredTask);
				}
			}
		}
		updateWidget({
			setWidget: (id, lines) => ctx.ui.setWidget(id, lines ?? []),
			setStatus: (id, text) => ctx.ui.setStatus(id, text),
		});
	});

	// ── Tool: task_run ──
	pi.registerTool({
		name: "task_run",
		label: "Run Task in Background",
		description: [
			"Run a shell command or task in the background.",
			"Returns immediately with a task ID for status tracking.",
			"Use task_status to check output and task_stop to cancel.",
			"Use task_list to see all tasks.",
		].join(" "),
		parameters: Type.Object({
			command: Type.String({
				description: "Shell command to execute in the background",
			}),
			label: Type.Optional(
				Type.String({
					description: "Optional human-readable label for this task",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory (defaults to current)",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Optional timeout in milliseconds. Task is killed if it exceeds this.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const taskId = uuidv7();
			const now = Date.now();

			const task: TaskInfo = {
				id: taskId,
				label: params.label || params.command.slice(0, 80),
				command: params.command,
				cwd: params.cwd || ctx.cwd,
				status: "running",
				pid: null,
				createdAt: now,
				startedAt: null,
				completedAt: null,
				exitCode: null,
				stdout: "",
				stderr: "",
				timeout: params.timeout || null,
			};

			startBackgroundTask(task, {
				setWidget: (id, lines) => ctx.ui.setWidget(id, lines ?? []),
				setStatus: (id, text) => ctx.ui.setStatus(id, text),
				notify: (msg, level) =>
					ctx.ui.notify(msg, level as "info" | "warning" | "error"),
				appendEntry: (type, data) => pi.appendEntry(type, data),
				signal,
			});

			ctx.ui.notify(
				`Task started: ${task.label} (#${taskId.slice(0, 8)})`,
				"info",
			);

			return {
				content: [
					{
						type: "text",
						text: [
							`Background task started: #${taskId.slice(0, 8)}`,
							`  Label: ${task.label}`,
							`  Command: ${task.command}`,
							`  CWD: ${task.cwd}`,
							`  ID: ${taskId}`,
							``,
							`Use task_status with this ID to check output.`,
							`Use task_stop with this ID to cancel.`,
							`Use task_list to see all tasks.`,
						].join("\n"),
					},
				],
				details: {
					tasks: [task],
					runningCount: Array.from(tasks.values()).filter(
						(t) => t.status === "running",
					).length,
				} satisfies TaskDetails,
			};
		},
	});

	// ── Tool: task_stop ──
	pi.registerTool({
		name: "task_stop",
		label: "Stop a Background Task",
		description: "Stop or cancel a running background task by ID.",
		parameters: Type.Object({
			taskId: Type.String({
				description: "ID of the task to stop (full or short ID)",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolvedId = resolveTaskId(params.taskId);
			if (!resolvedId) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: {
						tasks: Array.from(tasks.values()),
						runningCount: 0,
					} satisfies TaskDetails,
					isError: true,
				};
			}

			const task = tasks.get(resolvedId)!;
			const stopped = stopTask(resolvedId, "manual");

			if (!stopped) {
				return {
					content: [
						{
							type: "text",
							text: `Task #${resolvedId.slice(0, 8)} is already ${task.status} (not running). No action taken.`,
						},
					],
					details: {
						tasks: Array.from(tasks.values()),
						runningCount: Array.from(tasks.values()).filter(
							(t) => t.status === "running",
						).length,
					} satisfies TaskDetails,
				};
			}

			persistTask(
				{ appendEntry: (type, data) => pi.appendEntry(type, data) },
				task,
			);
			updateWidget({
				setWidget: (id, lines) => ctx.ui.setWidget(id, lines ?? []),
				setStatus: (id, text) => ctx.ui.setStatus(id, text),
			});
			ctx.ui.notify(`Task stopped: ${task.label}`, "warning");

			return {
				content: [
					{
						type: "text",
						text: `Task #${resolvedId.slice(0, 8)} ("${task.label}") has been stopped (SIGTERM sent).`,
					},
				],
				details: {
					tasks: Array.from(tasks.values()),
					runningCount: Array.from(tasks.values()).filter(
						(t) => t.status === "running",
					).length,
				} satisfies TaskDetails,
			};
		},
	});

	// ── Tool: task_list ──
	pi.registerTool({
		name: "task_list",
		label: "List Background Tasks",
		description: "List all background tasks with their status.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.String({
					description:
						"Optional filter: running, completed, failed, stopped, timeout",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let allTasks = Array.from(tasks.values());
			if (params.status) {
				allTasks = allTasks.filter((t) => t.status === params.status);
			}

			// Sort by creation time, newest first
			allTasks.sort((a, b) => b.createdAt - a.createdAt);

			if (allTasks.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.status
								? `No tasks with status "${params.status}".`
								: "No background tasks have been run yet.",
						},
					],
					details: { tasks: [], runningCount: 0 } satisfies TaskDetails,
				};
			}

			const running = allTasks.filter((t) => t.status === "running");
			const summary = [
				`Background Tasks: ${allTasks.length} total, ${running.length} running`,
				"",
				...allTasks.map((t) => {
					const icon =
						t.status === "running"
							? "⏳"
							: t.status === "completed"
								? "✓"
								: t.status === "failed"
									? "✗"
									: t.status === "stopped"
										? "⊘"
										: "⏰";
					const elapsed =
						t.completedAt && t.startedAt
							? formatDuration(t.completedAt - t.startedAt)
							: t.startedAt
								? formatDuration(Date.now() - t.startedAt)
								: "pending";
					const label = t.label || t.command.slice(0, 80);
					const shortId = t.id.slice(0, 8);
					const outputSize = formatBytes(t.stdout + t.stderr);
					return `  ${icon} #${shortId} ${label} [${t.status}, ${elapsed}, out:${outputSize}]`;
				}),
			].join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					tasks: allTasks,
					runningCount: running.length,
				} satisfies TaskDetails,
			};
		},
	});

	// ── Tool: task_status ──
	pi.registerTool({
		name: "task_status",
		label: "Get Task Status",
		description:
			"Get detailed status and output of a specific background task by ID.",
		parameters: Type.Object({
			taskId: Type.String({ description: "ID of the task (full or short ID)" }),
			showOutput: Type.Optional(
				Type.Boolean({
					description: "Include stdout/stderr in the response (default: true)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const resolvedId = resolveTaskId(params.taskId);
			if (!resolvedId) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: { tasks: [], runningCount: 0 } satisfies TaskDetails,
					isError: true,
				};
			}

			const task = tasks.get(resolvedId)!;
			const showOutput = params.showOutput ?? true;

			const parts: string[] = [
				`Task: #${task.id.slice(0, 8)} (full: ${task.id})`,
				`  Label:     ${task.label}`,
				`  Command:   ${task.command}`,
				`  CWD:       ${task.cwd}`,
				`  Status:    ${task.status}`,
				`  PID:       ${task.pid ?? "—"}`,
				`  Created:   ${formatTimestamp(task.createdAt)}`,
				`  Started:   ${task.startedAt ? formatTimestamp(task.startedAt) : "—"}`,
				`  Completed: ${task.completedAt ? formatTimestamp(task.completedAt) : "—"}`,
				`  Duration:  ${task.startedAt ? formatDuration((task.completedAt ?? Date.now()) - task.startedAt) : "—"}`,
				`  Exit Code: ${task.exitCode ?? "—"}`,
			];

			if (task.error) parts.push(`  Error:     ${task.error}`);
			if (task.stopReason) parts.push(`  Stop Reason: ${task.stopReason}`);
			if (task.timeout) parts.push(`  Timeout:   ${formatDuration(task.timeout)}`);

			if (showOutput) {
				const stdout = task.stdout.trim();
				const stderr = task.stderr.trim();
				if (stdout) parts.push("", "─── stdout ───", truncateOutput(stdout, 100));
				if (stderr) parts.push("", "─── stderr ───", truncateOutput(stderr, 50));
				if (!stdout && !stderr && task.status === "running") {
					parts.push("", "(no output yet — task is still running)");
				}
				if (!stdout && !stderr && task.status !== "running") {
					parts.push("", "(no output)");
				}
			}

			return {
				content: [
					{
						type: "text",
						text: parts.join("\n"),
					},
				],
				details: {
					tasks: [task],
					runningCount: Array.from(tasks.values()).filter(
						(t) => t.status === "running",
					).length,
				} satisfies TaskDetails,
			};
		},
	});

	// ── Tool: task_wait ──
	pi.registerTool({
		name: "task_wait",
		label: "Wait for Task Completion",
		description:
			"Wait for a background task to complete and return its final output.",
		parameters: Type.Object({
			taskId: Type.String({
				description: "ID of the task to wait for (full or short ID)",
			}),
			pollIntervalMs: Type.Optional(
				Type.Number({
					description: "Poll interval in milliseconds (default: 1000)",
					default: 1000,
				}),
			),
			maxWaitMs: Type.Optional(
				Type.Number({
					description:
						"Maximum time to wait in milliseconds (default: 300000 = 5 min)",
					default: 300000,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			const resolvedId = resolveTaskId(params.taskId);
			if (!resolvedId) {
				return {
					content: [{ type: "text", text: `Task not found: ${params.taskId}` }],
					details: { tasks: [], runningCount: 0 } satisfies TaskDetails,
					isError: true,
				};
			}

			const task = tasks.get(resolvedId)!;
			const pollMs = params.pollIntervalMs ?? 1000;
			const maxWaitMs = params.maxWaitMs ?? 300000;
			const startTime = Date.now();

			// If already done, return immediately
			if (task.status !== "running") {
				const stdout = truncateOutput(task.stdout.trim(), 50);
				const stderr = truncateOutput(task.stderr.trim(), 20);
				return {
					content: [
						{
							type: "text",
							text: [
								`Task #${task.id.slice(0, 8)} is already ${task.status}.`,
								`Exit code: ${task.exitCode ?? "—"}`,
								`Duration: ${formatDuration(task.completedAt && task.startedAt ? task.completedAt - task.startedAt : null)}`,
								stdout ? `\n─── stdout ───\n${stdout}` : "",
								stderr ? `\n─── stderr ───\n${stderr}` : "",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: { tasks: [task], runningCount: 0 } satisfies TaskDetails,
				};
			}

			// Poll until done or timeout
			while (true) {
				const elapsed = Date.now() - startTime;
				if (elapsed >= maxWaitMs) {
					return {
						content: [
							{
								type: "text",
								text: `Waited ${formatDuration(maxWaitMs)} for task #${task.id.slice(0, 8)} but it's still running. Use task_stop to cancel or task_status to check again.`,
							},
						],
						details: { tasks: [task], runningCount: 1 } satisfies TaskDetails,
					};
				}

				await sleep(pollMs);
				const current = tasks.get(resolvedId)!;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Waiting for task #${current.id.slice(0, 8)}... (${formatDuration(Date.now() - startTime)} elapsed, status: ${current.status}${current.stdout ? ", output so far: " + truncateOutput(current.stdout.trim(), 5) : ""})`,
						},
					],
					details: { tasks: [current], runningCount: 1 } satisfies TaskDetails,
				});

				if (current.status !== "running") {
					const stdout = truncateOutput(current.stdout.trim(), 50);
					const stderr = truncateOutput(current.stderr.trim(), 20);
					return {
						content: [
							{
								type: "text",
								text: [
									`Task #${current.id.slice(0, 8)} completed with status: ${current.status}`,
									`Exit code: ${current.exitCode ?? "—"}`,
									`Duration: ${formatDuration(current.completedAt && current.startedAt ? current.completedAt - current.startedAt : null)}`,
									stdout ? `\n─── stdout ───\n${stdout}` : "",
									stderr ? `\n─── stderr ───\n${stderr}` : "",
								]
									.filter(Boolean)
									.join("\n"),
							},
						],
						details: { tasks: [current], runningCount: 0 } satisfies TaskDetails,
					};
				}
			}
		},
	});

	// ── Command: /tasks ──
	pi.registerCommand("tasks", {
		description: "Show all background tasks with interactive TUI view",
		handler: async (_args, ctx) => {
			const allTasks = Array.from(tasks.values()).sort(
				(a, b) => b.createdAt - a.createdAt,
			);

			if (allTasks.length === 0) {
				ctx.ui.notify("No background tasks.", "info");
				return;
			}

			if (ctx.mode !== "tui") {
				// Fallback: print to console
				for (const task of allTasks) {
					console.log(getTaskSummary(task));
				}
				return;
			}

			// Interactive TUI view
			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const renderTasks = (width: number): string[] => {
					const lines: string[] = [];
					const th = theme;

					lines.push("");
					lines.push(
						th.fg("accent", th.bold(" Background Tasks ")) +
							th.fg("muted", ` (${allTasks.length} total)`),
					);
					lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, 60))));
					lines.push("");

					for (const task of allTasks) {
						const icon =
							task.status === "running"
								? th.fg("accent", "⏳")
								: task.status === "completed"
									? th.fg("success", "✓")
									: task.status === "failed"
										? th.fg("error", "✗")
										: task.status === "stopped"
											? th.fg("warning", "⊘")
											: th.fg("warning", "⏰");

						const shortId = th.fg("dim", `#${task.id.slice(0, 8)}`);
						const label = task.label || task.command.slice(0, 60);
						const time = task.startedAt
							? th.fg(
									"muted",
									formatDuration((task.completedAt ?? Date.now()) - task.startedAt),
								)
							: "";

						lines.push(`  ${icon} ${shortId} ${label} ${time}`);
					}

					lines.push("");
					lines.push(th.fg("dim", " Press Escape or Ctrl+C to close"));
					lines.push("");

					return lines;
				};

				return {
					render: (width: number) => renderTasks(width),
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

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a short ID (first 8 chars) or full ID to a full task ID.
 */
function resolveTaskId(input: string): string | undefined {
	// Exact match first
	if (tasks.has(input)) return input;

	// Short ID match
	for (const id of tasks.keys()) {
		if (id.startsWith(input)) return id;
	}

	return undefined;
}
