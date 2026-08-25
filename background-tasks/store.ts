/**
 * Shared background-task store.
 *
 * Both `background-tasks/index.ts` (the task_* tools) and `todo.ts` import this
 * module so they observe the SAME in-memory `tasks` map. Because pi loads every
 * extension through the same jiti module registry, importing this path resolves
 * to one shared module instance — no duplicate state, no IPC.
 *
 * The todo tool uses `getTaskStatus` to render a live status marker next to any
 * checklist item that carries a `taskId`, while the two extensions keep their
 * own data models and persistence layers entirely separate.
 */

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

/** In-memory live task store (shared across extensions). */
export const tasks = new Map<string, TaskInfo>();

/**
 * Resolve a full or short (first 8 chars) task ID and return its status.
 * Returns `undefined` when the task is not (yet) known — e.g. the task was
 * spawned in a prior session and never restored, or the ID is just wrong.
 */
export function getTaskStatus(input: string): TaskStatus | undefined {
	const exact = tasks.get(input);
	if (exact) return exact.status;
	for (const [id, task] of tasks.entries()) {
		if (id.startsWith(input)) return task.status;
	}
	return undefined;
}
