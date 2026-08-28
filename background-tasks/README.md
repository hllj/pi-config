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
  timeout?: number;         // Optional hard timeout in ms (kills the task)
  warnAtMs?: number;        // Optional soft warn threshold in ms (flags + notifies, does NOT kill)
}
```

Returns a task ID immediately. The task runs in a background child process.

The `warnAtMs` threshold pairs with `timeout`: after `warnAtMs` the running task
is flagged with a ⚠ marker, a UI notification fires (with output-so-far), and
the task **keeps running** — useful for detecting long-running (docker/backend)
tasks without killing them. `timeout` remains the hard kill.

### `task_stop` — Stop a running task

```typescript
// Parameters
{
  taskId: string;  // Full or short (first 8 chars) task ID
}
```

Sends SIGTERM, then SIGKILL after a 5-second grace period. The task stays in
`task_list` as a `stopped` record.

### `task_remove` — Remove a task permanently

```typescript
// Parameters
{
  taskId: string;  // Full or short (first 8 chars) task ID
}
```

Stop the process if it is still running (SIGTERM → SIGKILL), then drop the
task from the in-memory list completely and record a tombstone so it is *not*
restored on the next session reload. Unlike `task_stop` no record is left
behind — ideal for cleaning up stray docker containers / backend dev servers.

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

Opens a TUI dialog showing all tasks with colored status icons. The list is
**interactive**:

- `↑`/`↓` or `j`/`k` — move selection
- `s` — stop the selected task (SIGTERM, only if running)
- `d` — remove the selected task permanently (press `d` again to confirm,
  `Esc` to cancel). Equivalent to `task_remove`
- `Enter` — close and show task status via `task_status`
- `Esc`/`Ctrl+C` — close

Works in terminal mode; falls back to console print in non-TUI modes.

> Note: in non-TUI mode a static row is simply printed; the live selection UI
> requires the TUI.

## Architecture

```
Task Lifecycle:
  Created → Running → Completed (exitCode=0)
                    → Failed    (exitCode≠0)
                    → Stopped   (SIGTERM)
                    → Timeout   (timeout exceeded)
  Removed → deleted from store + tombstone (won't restore)

Process Management:
  • child_process.spawn() with shell:true
  • Captured stdout/stderr (up to 512KB/128KB)
  • SIGTERM → 5s grace → SIGKILL
  • Soft warn threshold (warnAtMs): flags ⚠ + notifies, never kills
  • Signal-aware: respects abort signal from agent

Persistence:
  • In-memory Map<taskId, TaskInfo> for live tasks
  • pi.appendEntry("background-task", data) for session persistence
  • pi.appendEntry("background-task-removed", {id}) tombstones removed tasks
    so they are skipped when restoring session entries
  • Restored from session entries on session_start (removed ids filtered out)

### Shared store (`store.ts`)

The in-memory `tasks` map and `TaskInfo`/`TaskStatus` types live in `store.ts`,
which is imported by **both** this extension and the `todo` tool. Because pi
loads extensions through the same jiti module registry, both see the same live
task state. The `todo` tool uses `getTaskStatus(id)` to render a live status
marker (`⏳` running / `⚠` failed) next to any checklist item created with a
`taskId`. The two extensions keep their own data models and persistence layers
separate — a task is only linked, never merged into a todo.

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

### Linking a task to a todo

A background task can be attached to a checklist item with `todo add` by
passing its `taskId`. The todo list then shows the task's live status — `⏳`
while it runs, `⚠` if it ends failed/stopped/timed out — without merging the
two tools:

```text
User: Run a long build in the background
Agent: ✓ task_run started (#abc12345): npm run build

User: Track that build as a todo
Agent: ✓ todo add "wait for npm run build" (taskId: abc12345)

User: (todo widget) #1 wait for npm run build  ⏳ running

User: The build broke
Agent: ✗ #abc12345 npm run build [failed]

User: (todo widget) #1 wait for npm run build  ⚠ failed
```
