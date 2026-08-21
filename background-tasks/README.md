# Background Tasks Extension

A full task system for Pi coding agent implementing **background execution, status tracking, and task lifecycle management**.

## Overview

This extension allows Pi to:

- Run shell commands/tasks **in the background** without blocking the agent
- **Track status** of all tasks (running, completed, failed, stopped, timeout)
- **Stop/cancel** running tasks with graceful SIGTERM → SIGKILL fallback
- **Wait** for a task to complete and get its final output
- **Persist** task history across sessions via session entries
- **Monitor** tasks via TUI widget showing running count

## Tools

### `task_run` — Run a task in the background

```typescript
// Parameters
{
  command: string;          // Shell command to execute
  label?: string;           // Optional human-readable label
  cwd?: string;             // Working directory (defaults to current)
  timeout?: number;         // Optional timeout in ms
}
```

Returns a task ID immediately. The task runs in a background child process.

### `task_stop` — Stop a running task

```typescript
// Parameters
{
  taskId: string;  // Full or short (first 8 chars) task ID
}
```

Sends SIGTERM, then SIGKILL after a 5-second grace period.

### `task_list` — List all tasks

```typescript
// Parameters
{
  status?: string;  // Optional filter: "running", "completed", "failed", "stopped", "timeout"
}
```

Shows all tasks sorted newest-first with status, duration, and output size.

### `task_status` — Get detailed task status

```typescript
// Parameters
{
  taskId: string;       // Full or short task ID
  showOutput?: boolean; // Include stdout/stderr (default: true)
}
```

Shows full task metadata, exit code, duration, stdout, and stderr.

### `task_wait` — Wait for task completion

```typescript
// Parameters
{
  taskId: string;               // Full or short task ID
  pollIntervalMs?: number;      // Poll interval (default: 1000)
  maxWaitMs?: number;           // Max wait time (default: 300000 = 5 min)
}
```

Polls until the task completes or the max wait is reached. Streams progress via `onUpdate`.

## Commands

### `/tasks` — Interactive task viewer

Opens a TUI dialog showing all tasks with colored status icons. Works in terminal mode; falls back to console print in non-TUI modes.

## Architecture

```
Task Lifecycle:
  Created → Running → Completed (exitCode=0)
                    → Failed    (exitCode≠0)
                    → Stopped   (SIGTERM)
                    → Timeout   (timeout exceeded)

Process Management:
  • child_process.spawn() with shell:true
  • Captured stdout/stderr (up to 512KB/128KB)
  • SIGTERM → 5s grace → SIGKILL
  • Signal-aware: respects abort signal from agent

Persistence:
  • In-memory Map<taskId, TaskInfo> for live tasks
  • pi.appendEntry("background-task", data) for session persistence
  • Restored from session entries on session_start

UI:
  • Widget showing running task count + labels + elapsed time
  • Status line indicator: "⏳ N bg tasks"
  • Interactive /tasks command for full overview
```

## Session Shutdown

On `session_shutdown`, all running tasks are stopped with a SIGTERM. This prevents orphan processes when the session ends. The task history remains accessible via session entries.

## Example Usage

```
User: Run a long build in the background
Agent: ✓ task_run started (#abc12345): npm run build

User: Check on that build
Agent: ✓ #abc12345 npm run build [running, 2m 15s, out: 42KB]
       → running for 2 minutes, still compiling...

User: Stop it, it's too slow
Agent: ✗ #abc12345 stopped (SIGTERM sent)

User: List completed tasks
Agent: Background Tasks: 3 total, 0 running
       ✓ #abc12344 lint [completed, 5s]
       ✓ #abc12343 test [completed, 30s]
       ✗ #abc12342 dep-install [failed, 10s]
```
