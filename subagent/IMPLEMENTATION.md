# Subagent Features Implementation

This document describes the three new features implemented in the pi-config/subagent extension.

## Feature 1: list_agents Tool

**File**: `pi-config/subagent/index.ts` (lines ~460-590)

### Description

A new tool that lists available subagents with optional filtering capabilities.

### Parameters

- `scope` (optional): 'user' | 'project' | 'both' - Which agent directories to search
- `namePattern` (optional): string - Filter agents by name pattern (substring match)

### Implementation Details

- Reuses existing `discoverAgents()` function from `agents.ts`
- Returns agent list with full details:
  - name
  - description
  - tools array
  - model (if specified)
  - source (user/project)
  - filePath

### Custom TUI Rendering

- **Call rendering**: Shows scope and filter pattern
- **Result rendering**:
  - Collapsed: Shows first 5 agents with brief info
  - Expanded: Shows full details for all agents with color-coded source indicators

## Feature 2: Messaging System

**Files**:

- `pi-config/subagent/messaging.ts` (new file, 105 lines)
- `pi-config/subagent/index.ts` (integration)

### Components

#### 1. Data Types (`messaging.ts`)

```typescript
interface SubagentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  deliveryStatus: "pending" | "delivered" | "failed";
}
```

#### 2. Message Management Functions

- `sendMessage(from, to, content)` - Create and store a message
- `getMessages(agentName, filter?)` - Retrieve messages for an agent
- `markAsDelivered(messageId)` - Update message status to delivered
- `markAsFailed(messageId)` - Update message status to failed
- `initializeMessageStore(messages)` - Load persisted messages from entries
- `getPendingMessages(recipient)` - Get undelivered messages

#### 3. Tools

**send_message**

- Parameters: `from`, `to`, `content`
- Persists messages via `ctx.appendEntry()` with type `"subagent-message"`
- Returns message ID and timestamp

**get_messages**

- Parameters: `agent`, `filter` (optional: "sent" | "received" | "all")
- Retrieves and displays messages for the specified agent
- Shows delivery status with icons (✓ delivered, ✗ failed, ⏳ pending)

#### 4. Entry Renderer

Registered for `"subagent-message"` type entries, displays:

- Status icon
- From/to agents
- Timestamp
- Message content

#### 5. Session Integration

- `session_start` hook loads persisted messages from entries
- Messages are automatically restored when a session resumes

## Feature 3: Workflow Engine

**Files**:

- `pi-config/subagent/workflow-engine.ts` (new file, 235 lines)
- `pi-config/subagent/workflow-renderer.ts` (new file, 175 lines)
- `pi-config/subagent/index.ts` (integration)

### Components

#### 1. Core Types (`workflow-engine.ts`)

**WorkflowStep**

```typescript
interface WorkflowStep {
  agent: string;
  task: string;
  cwd?: string;
  condition?: StepCondition;
  errorHandler?: ErrorHandler;
  requiresApproval?: boolean;
}
```

**StepCondition**

```typescript
interface StepCondition {
  type: "outputContains" | "exitCodeEquals";
  value: string | number;
}
```

**ErrorHandler**

```typescript
interface ErrorHandler {
  strategy: "retry" | "skip" | "fallback" | "abort";
  maxRetries?: number;
  fallbackAgent?: string;
  fallbackTask?: string;
}
```

**WorkflowState**

```typescript
interface WorkflowState {
  id: string;
  name?: string;
  steps: WorkflowStep[];
  results: WorkflowStepResult[];
  currentStepIndex: number;
  status: "running" | "completed" | "failed" | "paused";
  startTime: number;
  endTime?: number;
  error?: string;
}
```

#### 2. Engine Functions

- `evaluateCondition()` - Check if a condition is met
- `shouldExecuteStep()` - Determine if a step should run based on conditions
- `handleStepError()` - Determine error recovery strategy
- `createWorkflowState()` - Initialize workflow
- `updateWorkflowState()` - Update step results
- `completeWorkflow()` - Mark workflow as completed
- `failWorkflow()` - Mark workflow as failed
- `pauseWorkflow()` - Pause for approval gates
- `resumeWorkflow()` - Resume after approval
- `getWorkflowSummary()` - Generate human-readable summary

#### 3. run_workflow Tool

**Parameters**:

- `steps` - Array of WorkflowStep objects
- `name` (optional) - Workflow name
- `agentScope` (optional) - Agent discovery scope
- `confirmProjectAgents` (optional) - Prompt for project agents

**Features**:

- ✅ Condition evaluation before each step
- ✅ Error recovery strategies (retry/skip/fallback/abort)
- ✅ Approval gates (requires user confirmation)
- ✅ State persistence via `ctx.appendEntry()`
- ✅ Streaming updates during execution
- ✅ `{previous}` placeholder substitution

**Execution Flow**:

1. Initialize workflow state
2. For each step:
   - Evaluate condition (skip if not met)
   - Check approval gate (pause if required)
   - Execute step with retry logic
   - Handle errors according to strategy
   - Update state and emit progress
3. Complete or fail workflow
4. Persist final state

#### 4. TUI Renderers (`workflow-renderer.ts`)

**Status Icons**:

- ✓ completed (green)
- ⏳ running (yellow)
- ⏸ waiting_approval (yellow)
- ✗ failed (red)
- ⊘ skipped (muted)
- ○ pending (dim)

**renderWorkflowCollapsed()**

- Shows workflow status and progress bar
- Displays first 3 steps with icons
- Shows "+ N more steps" for remaining steps

**renderWorkflowExpanded()**

- Full workflow details with status
- All steps with individual status
- Conditions and error handlers displayed
- Output preview for completed steps
- Duration tracking per step

#### 5. Entry Renderer

Registered for `"subagent-workflow"` type entries, uses collapsed view for session history.

#### 6. SubagentParams Extension

Added `workflow` parameter to the base `subagent` tool parameters schema:

```typescript
workflow: Type.Optional(
  Type.Array(WorkflowStepSchema, {
    description: "Array of workflow steps with conditions, error handling, and approval gates."
  })
)
```

#### 7. Session Hooks

- `session_start` - Could be extended to restore paused workflows
- `session_shutdown` - Placeholder for persisting running workflow state

## Architecture Decisions

### Persistence Strategy

- Messages and workflow states are persisted via `pi.appendEntry()`
- Entry types: `"subagent-message"` and `"subagent-workflow"`; `"subagent-session"` (one compact pointer per run)
- In-memory stores are hydrated from entries at session start
- Full subagent conversations are NOT parent entries: each run gets its own real pi session file (see Run Store below)

### Error Recovery

The workflow engine supports four strategies:

1. **retry** - Reattempt the step (with maxRetries limit)
2. **skip** - Continue to next step
3. **fallback** - Execute alternative agent/task
4. **abort** - Stop workflow immediately

### Condition Evaluation

Two condition types are supported:

1. **outputContains** - Check if previous output contains a string
2. **exitCodeEquals** - Check if previous exit code matches

### Approval Gates

When `requiresApproval: true`:

- Workflow pauses before executing the step
- User is prompted via `ctx.ui.confirm()`
- Step is skipped if denied, executed if approved

## Usage Examples

### List Agents

```typescript
// List all user agents
pi.tools.list_agents({ scope: "user" })

// List project agents matching "test"
pi.tools.list_agents({ scope: "project", namePattern: "test" })

// List all agents (user + project)
pi.tools.list_agents({ scope: "both" })
```

### Messaging

```typescript
// Send a message
pi.tools.send_message({
  from: "scout",
  to: "implementer",
  content: "Found 3 files that need updates"
})

// Get received messages
pi.tools.get_messages({ agent: "implementer", filter: "received" })

// Get all messages
pi.tools.get_messages({ agent: "scout", filter: "all" })
```

### Workflow

```typescript
pi.tools.run_workflow({
  name: "Build and Test Pipeline",
  steps: [
    {
      agent: "builder",
      task: "Build the project"
    },
    {
      agent: "tester",
      task: "Run unit tests",
      condition: {
        type: "exitCodeEquals",
        value: 0
      },
      errorHandler: {
        strategy: "retry",
        maxRetries: 2
      }
    },
    {
      agent: "deployer",
      task: "Deploy to staging",
      requiresApproval: true,
      errorHandler: {
        strategy: "fallback",
        fallbackAgent: "rollback-agent",
        fallbackTask: "Rollback deployment"
      }
    }
  ]
})
```

## Testing Recommendations

1. **list_agents**: Test with different scopes and patterns
2. **Messaging**: Test send/receive across multiple agents
3. **Workflow**: Test each error strategy and approval gates
4. **Persistence**: Verify messages and workflows survive session restarts
5. **TUI**: Check collapsed/expanded views for all features

## 2026-08 Feature Expansion (8 Improvements)

### A. Workflow persistence + resume

- `run_workflow` / `subagent workflow` now persist **every state transition** via `pi.appendEntry("subagent-workflow", state)` (see `executeWorkflowSteps`' internal `commit`).
- `get_workflow` (id optional → latest) shows step statuses/outputs via `getWorkflowSummary` + the workflow renderers.
- `resume_workflow` (id optional → latest, `fromStep` optional) uses `prepareResume` to reset steps at/after the resume point (widened to the enclosing `parallelGroup` start), reconstructs `previousOutput` from the last completed step, then runs the shared `executeWorkflowSteps` from that index.
- `session_start` hydrates workflows last-wins by id and marks running/paused states as **paused** (never auto-resume — mirrors the monitor extension's rule).
- Shared runner: `executeWorkflowSteps(state, startIndex, previous, exec)` + `executeSingleWorkflowStep` (retry/skip/fallback/abort). Both `run_workflow` and `resume_workflow` and the `subagent` workflow mode route through them.

### B. /agents TUI command + widget

- `pi.registerCommand("agents")` renders `renderAgentsScreen` (available agents + running subagents); Escape/Ctrl+C closes.
- `runningAgents` registry + `updateSubagentWidget` drive a `subagents` widget/status showing in-flight processes; every `runSingleAgent` registers on spawn and settles on completion/failure/timeout; entries are pruned after 10 minutes.
- `mode` labels (`single`/`parallel`/`chain`/`workflow`) identify each entry.

### C. Per-agent/step timeout

- `runSingleAgent` accepts `timeoutMs` (per-call) which overrides `agent.timeoutMs` (frontmatter). On expiry: SIGTERM then SIGKILL after 2s; result gets `timedOut: true`, exit code 124, and an error message.
- Timeouts flow through the existing error-handling machinery, so `retry`/`fallback`/`skip` strategies apply to timeouts for free.

### D. Real message delivery

- `runSingleAgent` pulls `getPendingMessages(agentName)` and injects them into the task prompt before spawn; after the run it calls `markAsDelivered`/`markAsFailed` per message.
- `messaging.ts` now has a `setMessagePersistHook` wired in `session_start`; every send/deliver/fail mutation persists via the hook (the old explicit `appendEntry` in `send_message` was removed to avoid double-writes).
- `list_agents` reports per-agent unread message counts.

### E. Expanded agent frontmatter

`agents.ts` parses: `timeoutMs`, `thinking`, `temperature`, `env`, `readonly`, `contextFiles` — all fail-soft (`parseOptionalNumber`, `parseEnvRecord`, `parseContextFileList`, etc.). Wired in `runSingleAgent`:

- `thinking` → `--thinking` CLI flag (only when the agent has no explicit model)
- `env` → merged over `process.env` in `spawn`
- `readonly` / `temperature` → prompt-level directives (advisory; pi has no temperature CLI flag)
- `timeoutMs` / `contextFiles` → dispatch defaults overridable per call

### F. Structured output contract (`expect`)

- New `expect.ts`: `buildExpectPromptBlock` (renders the JSON Schema into the system prompt) + `validateStructuredOutput` (tolerates one markdown-fence wrapper; validates via `Value.Check` from `typebox/value`).
- `expect: { type, jsonSchema?, description? }` on single/parallel/chain items and workflow steps. On mismatch the step fails with `expectError` (feeds retry/fallback); on success `structuredOutput` is surfaced (single mode returns the JSON; workflow/chain steps substitute the JSON as step output).

### G. Parallel workflow steps

- `WorkflowStep.parallelGroup`; consecutive steps sharing the id run concurrently via `mapWithConcurrencyLimit(MAX_CONCURRENCY=4)`.
- Group condition gate evaluated on the first member; per-member approval gates resolved before launch; group fails if any member aborts; `previousOutput` aggregates completed members.

### H. Context files

- `contextFiles` on single/parallel/chain items, workflow steps, and agent frontmatter; `buildContextBlock` reads each file (relative to cwd), caps at 50KB per file, notes unreadable files inline, and injects into the system prompt.

## Run Store: Persistent, Trackable Subagent Sessions

### Storage approach

Each dispatch gets a real pi session file (the child runs with `--session-dir <store>/<runId>` and `--name subagent/<agent>` instead of `--no-session`) plus a queryable `record.json` sidecar, and leaves one compact `subagent-session` pointer entry in the parent session. The child session file is named `<timestamp>_<sessionId>.jsonl` by pi (the code discovers any `*.jsonl`, not a fixed `session.jsonl`). Rationale vs. the alternatives: appendEntry-only grows the parent JSONL unboundedly and is only queryable inside a live session; a hand-rolled JSON store would reimplement pi's SessionManager transcript durability; overloading `subagent-message`/`subagent-workflow` conflates concerns. Native session files are crash-safe (per-message appendFileSync), replayable via `pi --resume`, and concurrency-safe because each run owns its own directory.

### Files

- `session-store.ts` (new, pure module — no pi runtime dependency): `resolveStoreDir`, `recordStart`/`recordUpdate`/`recordEnd` (atomic tmp+rename), `listRuns` (agent/mode/status/workflowId/since filters, newest-first), `getRun`, `readRunTranscript` (via `SessionManager.open` from the coding-agent SDK, falling back to a line-by-line JSONL parse), `reconcileOrphans` (pid ESRCH + 10-min staleness signal for the no-pid case, plus a hard 24h `HARD_ORPHAN_WINDOW_MS` safety net so PID-reuse/EPERM can never strand a record `running` forever), `pruneStore` (14 days / 500 runs default, `PI_SUBAGENT_RETENTION_DAYS` override; a `running` record older than 24h is treated as NOT live and becomes prunable), shared `formatDuration`. Known carve-out: orphaned records set `endedAt = now` / `durationMs = now - startedAt`, which slightly overstates runtime for long-orphaned runs (accepted).
- `runs-screen.ts` (new): `renderRunsScreen(width, rows, theme)` — agent/mode/status/duration/turns/cost columns with color-coded status, footer hints.
- `index.ts`: `runEnd` one-shot finalizer (status mapping: timedOut → `timed_out`, wasAborted → `aborted`; respects `shutdownAbortFlag`; records exitCode, usage, turns, output summary ≤2000 chars; appends the truncated parent pointer); pid tracked on `RunningAgentInfo` + record right after spawn; child env gains `PI_SUBAGENT_RUN_ID` and `PI_PARENT_SESSION_FILE`; `waitForSessionFile` discovers the child's session JSONL after close (skips the wait when `exitCode !== 0`, bounded ~500ms poll); `buildSessionLink` guards all optional `?.()` access.

### Store dir resolution

`PI_SUBAGENT_SESSION_DIR` env → `<dirname(dirname(sessionDir))>/subagents` (next to pi's `sessions/`) → `~/.pi/agent/subagents` fallback.

### Session lifecycle

- `session_start`: rebuilds the in-session `sessionRuns` map from parent pointers (last-wins by runId), calls `reconcileOrphans()` (stale `running` records → `orphaned`, never auto-resume), then `pruneStore()`. Idempotent across reload/new/resume/fork.
- `session_shutdown` (new): on `reason: "quit"` only — synchronous SIGTERM + bounded ~200ms SIGKILL escalation (poll `kill(pid,0)` in a 10×20ms loop; a `setTimeout` SIGKILL would never fire because pi's quit path `process.exit(0)`s right after this handler returns), marks their records `aborted` (a module-level `shutdownAbortFlag` prevents a late `runEnd` from downgrading to `failed`). `reload`/`new`/`resume`/`fork` leave children running.

### Tracking surface

- `list_subagent_sessions` (tool): store-wide query — `{ agent?, status?, mode?, workflowId?, limit?, since? }` → compact table.
- `get_subagent_session` (tool): `{ runId, includeTranscript? }` → full record + transcript tail (≤30 messages / 20KB).
- `/runs` (command): TUI screen (merge live `runningAgents` + `listRuns({ limit: 50 })`); non-TUI prints a text table.
- Entry renderer for `subagent-session`: one dimmed line per run in the parent transcript.

### Live workflow TUI widget

- `subagent/workflow-widget.ts` (new, pure + dependency-free): `buildWorkflowWidgetLines(state, now?)` renders the plain-text `workflow` widget (current-task line for the running step(s) — or the waiting_approval step when paused — a `Tasks (N) — name` header, one icon+`agent — task` line per step with `✓/✗/⊘/⏳/⏸/○` statuses, and a `completed / pending` summary with optional `failed`/`skipped` counts). `buildWorkflowStatus(state)` returns the `wf:{completed}/{steps}` footer string while any step runs, else `""`. Both ref throughout `commit` in `executeWorkflowSteps` (and via `updateWorkflowWidget` in `index.ts`), so the widget refreshes on every state transition — initial all-pending, running, retries, waiting_approval pause/resume, per-step outcomes, fail and complete. On `session_shutdown` (quit) the widget/status are cleared so a stale workflow doesn't linger; it is intentionally NOT cleared on completion so the finished state persists until the next workflow. Rendered lines carry no theme color (UiHooks has no theme).
- Tests: `subagent/tests/run-widget.sh` + `workflow-widget.test.mjs` (dependency-free — no @earendil-works modules needed; copies the current files like `run-unit.sh`).

## Future Enhancements

- Workflow templates/presets
- Message threading and replies
- Time-based conditions
- Workflow scheduling
- Message delivery callbacks
- Workflow visualization (Mermaid diagram generation)
- Workflow branching (non-consecutive parallel groups / DAGs)
- Context-file glob patterns
