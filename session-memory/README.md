# Session Notes (Memory for pi)

A pi extension that keeps a **living, structured markdown notes file for the current session** — the way you'd take notes while coding — and re-injects the notes into context when you resume the same session.

## What it stores (per session)

A `CURRENT.md` under `~/.pi/agent/memory/<session-id>/` with these sections:

- **Session Title**
- **Current State**
- **Task specification**
- **Files and Functions**
- **Workflow**
- **Errors & Corrections**
- **Codebase and System Documentation**
- **Learnings**
- **Key results**
- **Worklog** *(timestamps are added automatically on every note)*

The memory is **keyed by the pi session UUID**, not by working directory. Each
session gets its own working-memory file. Resuming the same session (`pi -c`,
`/resume`) keeps that session's memory; a brand-new session starts fresh — it no
longer inherits a stale title/state from a previous session in the same folder.

Override the storage root with env `PI_MEMORY_DIR`.

## Who writes it

Only the pi coding agent and the user. There is deliberately **no archive / new /
seed lifecycle** — the file is just the working memory of the current session.

**The agent** maintains the notes automatically via the `note` tool (read / note / write / set_title). Prompt guidelines nudge it to log results, learnings, and errors as it goes.

**The learning extension also writes here** (bridge): on the first tool failure
of a session it appends one `Errors & Corrections` line; when a failure pattern
is closed via `learn mark` (skill-created/resolved) it appends a `Learnings`
bullet with a back-link. Both go through the same `appendSection` code path as
the `note` tool, so the notes stay synchronized with `~/.pi/agent/learning/failures.json`.

**You** view and edit it directly with `/notes`:

| command | what it does |
| --- | --- |
| `/notes` | show where the current session's notes live + auto-memory state |
| `/notes edit` | open the file in the editor for manual editing |
| `/notes auto-log` | toggle periodic worklog lines (on by default, persisted) |
| `/notes auto-refresh` | toggle periodic LLM refresh of all sections (on by default, persisted); `/notes auto-refresh N` sets the cadence in runs |

## Auto-title from the session name

The notes **`# Title` is kept in sync with the pi session's display name** (set via `/name` or the SDK's `setSessionName`). On every `note` tool call the session name is read live and adopted as the notes title, so pi itself names the notes. A brand-new notes file starts with the session name directly. An existing file is re-titled only while its title is still the placeholder `Untitled session`, so a manual or previously-chosen explicit title (via `note set_title`) is never overwritten.

## TUI widget

When the notes have real content, a condensed widget is shown above the editor (like the todo list): the **Session Title**, the first line of **Current State**, and the last couple of **Worklog** entries — plus a `📝` footer status. It refreshes on session start and whenever notes change (note tool writes, `/notes edit`).

## Auto-update (auto-memory, on by default)

The agent keeps the session's memory file current on its own — **no `note` tool
call required**:

- **Self-bootstrap** — if no notes exist yet, they are created on the first
  settled agent run, so auto-memory always has a file to write into.
- **Session-close finalization** — on quit / reload / new / resume / fork, a
  timestamped worklog line (`session closed (<reason>)`) marks the boundary.
- **Auto-log** — after each settled agent run, one worklog line summarizing the
  last assistant message is appended (deduped per message, skips trivial
  outputs). On by default; toggle with `/notes auto-log`.
- **Auto-refresh** — every 5 settled runs (configurable via `/notes
  auto-refresh N`), the agent is nudged to refresh **all** sections (Current
  State, Files, Workflow, Learnings, Key results, Errors, title) via the `note`
  tool. On by default; toggle with `/notes auto-refresh`.

Both toggles and the cadence are **persisted** in
`~/.pi/agent/memory/auto-state.json`, so your preference survives restarts.

## Cross-session recall

On the **first turn of a session**, if notes exist for the current session, this extension injects a compact custom message — `Session Title / Current State / Key results / Learnings / Errors & Corrections` — into the LLM's context. That way a *resumed* session "remembers" where it left off. A brand-new session has no notes yet, so nothing is seeded.

Bounded to a few hundred characters per section so it never floods the window. A blank template (all placeholder guides, no real content) seeds nothing.

## Files

- `index.ts` — extension wiring: `note` tool, `/notes` command, `before_agent_start` seeding, storage helpers
- `lib.ts` — pure markdown manipulation (template, append/set sections, title, condense), no IO
- `lib.test.ts` — unit tests for `lib.ts` (`npm run test:notes`)

## Verification

```bash
npm run typecheck   # clean
npm run test:notes  # assertions pass
```

## Ideas for the future (not yet built)

- **Semantic recall** — instead of seeding everything, embed past notes and inject only the most relevant topic per prompt.
- **Global index** — a single `INDEX.md` across all sessions for topic search from any cwd.
