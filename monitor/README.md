# Monitor / Background Watcher Extension

Monitor command output or WebSocket streams with pattern-based reactivity.
Lets Pi tail logs, watch CI builds, follow WebSocket feeds, and react when
patterns are matched.

## Tools

### `monitor_start` — Start a Monitor

```typescript
// Parameters
{
  type: "command" | "websocket",    // Monitor mode
  label?: string,                    // Optional human-readable label
  // Command mode
  command?: string,                  // Shell command to run (required for type="command")
  cwd?: string,                      // Working directory (defaults to current)
  restart?: boolean,                 // Auto-restart command on exit
  // WebSocket mode
  url?: string,                      // WebSocket URL (required for type="websocket")
  headers?: Record<string, string>,  // Optional WS headers
  reconnect?: boolean,               // Auto-reconnect on close
  // Pattern matching
  patterns?: Array<{
    pattern: string,                 // Text or regex pattern
    useRegex?: boolean,              // Treat pattern as regex (default: false)
    action?: "notify" | "log" | "interrupt",  // Action on match (default: log)
    cooldown?: number                // Min ms between triggers (default: 0)
  }>
}
```

Returns a monitor ID immediately. The monitor starts in background.

### `monitor_stop` — Stop a Monitor

```typescript
{
  monitorId: string  // Full or short (first 8 chars) ID
}
```

Sends SIGTERM (process) or `ws.close()` (WebSocket).

### `monitor_list` — List All Monitors

```typescript
{
  status?: string  // Optional filter: "running", "stopped", "error", "interrupted", "starting"
}
```

Shows all monitors sorted newest-first with status, duration, and event count.

### `monitor_status` — Get Detailed Monitor Status

```typescript
{
  monitorId: string,         // Full or short ID
  showEvents?: boolean,       // Include events (default: true)
  eventLimit?: number         // Max events to show (default: 50, max: 200)
}
```

Shows monitor metadata, configuration, patterns, and recent events.

### `monitor_pattern` — Manage Patterns

```typescript
{
  monitorId: string,              // ID of the monitor
  action: "add" | "remove" | "list",  // What to do
  pattern?: string,               // Text/regex pattern (required for add)
  useRegex?: boolean,             // Treat pattern as regex (default: false)
  patternAction?: "notify" | "log" | "interrupt",  // Action on match
  patternId?: string,             // Pattern ID to remove (required for remove)
  cooldown?: number               // Min ms between triggers
}
```

Add, remove, or inspect patterns on any monitor (running or stopped).

## Commands

### `/monitors` — Interactive Monitor Viewer

Opens a TUI dialog showing all monitors with colored status icons, type tags,
and elapsed time. Works in terminal mode; falls back to console print in
non-TUI modes.

## Pattern Actions

| Action | Behavior |
| -------- | ---------- |
| `log` | Record the matched line in the events list (default) |
| `notify` | Send a TUI notification with the matched content |
| `interrupt` | Set monitor status to "interrupted" + notify; shows in widget as ⚠️ |

All actions respect per-pattern cooldowns. The `interrupt` action also has a
global throttle (max 1 per second across all monitors).

## Architecture

```
Monitor Lifecycle:
  Created → Starting → Running → Stopped  (user stop)
                                     → Error    (process/WS error)
                                     → Interrupted (pattern match with interrupt action)

Command Mode:
  • child_process.spawn() with shell:true
  • Line-buffered stdout/stderr via readline.createInterface()
  • Auto-restart on exit (optional)
  • SIGTERM → 5s grace → SIGKILL

WebSocket Mode:
  • ws library (npm package)
  • Exponential backoff reconnect (1s → 2s → 4s ... max 60s)
  • Max 10 reconnect attempts before giving up
  • Auto-reconnect on close (optional)

Pattern Matching:
  • Simple string.includes for fast path (default)
  • RegExp.test for regex patterns (useRegex: true)
  • Per-pattern cooldown to prevent notification spam
  • Global interrupt throttle (1/sec)

Persistence:
  • In-memory Map<id, MonitorInfo> for live monitors
  • pi.appendEntry("monitor", data) for session persistence
  • Restored from session entries on session_start (as stopped)
  • Max 200 events in memory, 50 persisted

UI:
  • Widget showing active/interrupted monitor count + labels
  • Status line indicator: "👁 N monitor(s)"
  • Interactive /monitors command for full overview

Session Shutdown:
  • All running/starting monitors are stopped
  • History persists via session entries
  • Monitors are NOT auto-restarted on resume
```

## Permission Gating

Command monitors (`type: "command"`) require user confirmation before spawning.
WebSocket monitors do not require confirmation.

## Example Usage

```
User: Watch the build output for errors
Agent: ✓ monitor_start started (#abc12345): tail -f build.log

User: Tell me when you see "ERROR"
Agent: ✓ monitor_pattern added to #abc12345: pattern="ERROR" action=notify

User: Check what it's seen so far
Agent: ✓ #abc12345 status: running, 142 events, 3 matches
       → Last events: ... ERROR in module xyz

User: Stop the watch
Agent: ✓ #abc12345 stopped
```
