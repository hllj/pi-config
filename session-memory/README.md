# Session Notes (Memory for pi)

A pi extension that keeps a **living, structured markdown notes file for the current conversation** — the way you'd take notes while coding — and re-injects relevant notes into context when you come back in a later session.

## What it stores (per project directory)

A `CURRENT.md` under `~/.pi/agent/memory/<project-slug>/` with these sections:

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

When you finish a topic, the notes are snapshotted to `archives/<topic>.md` and a fresh doc starts.

Override the storage root with env `PI_MEMORY_DIR`.

## How you use it

**The agent** maintains the notes automatically via the `note` tool (read / note / write / set_title / archive). Prompt guidelines nudge it to log results, learnings, and errors as it goes.

### Auto-title from the session name

The notes **`# Title` is kept in sync with the pi session's display name** (set via `/new <name>` or the SDK's `setSessionName`). On every `note` tool call the session name is read live from the tool-call context and adopted as the notes title, so pi itself names the notes — the model doesn't need to call `set_title` just to give them a title. A brand-new notes file starts with the session name directly. An existing file is re-titled only while its title is still the placeholder `Untitled session`, so a manual or previously-chosen explicit title (via `note set_title`) is never overwritten.

**You** control it with `/notes`:

| command | what it does |
| --- | --- |
| `/notes` | show where the current notes file lives |
| `/notes edit` | open the file in the editor for manual editing |
| `/notes new [title]` | archive the current notes, start fresh |
| `/notes seed` | pick a past archived topic to load back in as the working doc |
| `/notes auto-log` | toggle periodic worklog lines (on by default) |
| `/notes auto-refresh` | toggle periodic LLM refresh of all sections (off by default) |

## TUI widget

When the notes have real content, a condensed widget is shown above the editor
(like the todo list): the **Session Title**, the first line of **Current
State**, and the last couple of **Worklog** entries — plus a `📝` footer status.
It refreshes on session start and whenever notes change (note tool writes,
`/notes edit` / `new` / `seed`).

## Auto-update (so notes stay current on their own)

Notes were previously written only when the model happened to call the `note` tool
— so some sections (often only Key results) got filled while others stayed blank.
Three automatic mechanisms keep the file living:

- **Session-close finalization** — on quit / reload / new / resume / fork, a
timestamped worklog line (`session closed (<reason>)`) marks the boundary, so the
notes track when sessions end.
- **Periodic auto-log** — after each settled agent run, one worklog line
summarizing the last assistant message is appended (deduped per message, skips
trivial output). On by default; toggle with `/notes auto-log`.
- **Optional LLM refresh** — `/notes auto-refresh` (off by default) nudges the
agent every few runs to refresh **all** sections (Current State, Files, Workflow,
Learnings, Key results, Errors) via the `note` tool, at a token cost.

## Auto-archive on compact

When a session is compacted (context summarized), the current notes are
snapshotted to `archives/compact.md` (deduped as `compact-1`, `compact-2`, …)
so their content survives independently of the summarization. Blank/
placeholder-only notes are skipped.

## Cross-session recall

On the **first turn of a session**, if notes exist for the current working directory, this extension injects a compact custom message — `Session Title / Current State / Key results / Learnings / Errors & Corrections` — into the LLM's context. That way a new or resumed session "remembers" where the previous one left off.

Bounded to a few hundred characters per section so it never floods the window. A blank template (all placeholder guides, no real content) seeds nothing.

## Files

- `index.ts` — extension wiring: `note` tool, `/notes` command, `before_agent_start` seeding, storage helpers
- `lib.ts` — pure markdown manipulation (template, append/set sections, title, condense), no IO
- `lib.test.ts` — unit tests for `lib.ts` (`npm run test:notes`)

## Verification

```bash
npm run typecheck   # clean
npm run test:notes  # 35 assertions pass
```

## Ideas for the future (not yet built)

- **Semantic recall** — instead of seeding everything, embed past notes and inject only the most relevant topic per prompt.
- **Global index** — a single `INDEX.md` across all projects for topic search from any cwd.
