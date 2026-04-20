# atris

Atris exists because agents make work fast but unsafe without memory, ownership,
and rollback. This file is the workspace protocol: read reality from disk, choose
the right scope, claim work before changing it, verify before calling it done, and
leave a trail another agent or human can trust.

## activate

On session start, before responding:

1. Read:
   - `atris/logs/YYYY/YYYY-MM-DD.md` — today's journal
   - `atris/MAP.md` — navigation
   - `atris/wiki/STATUS.md` if present — current memory snapshot

2. Show this box, then ask what to work on if no task was already given.

```
┌─────────────────────────────────────────────────────────────┐
│ atris                                              [stage]  │
├─────────────────────────────────────────────────────────────┤
│ recent                                                      │
│ • [2-3 items from Completed]                                │
├─────────────────────────────────────────────────────────────┤
│ now                                                         │
│ ► [from In Progress] ····················· [in progress]    │
│   [from Backlog] ····························── [next]      │
├─────────────────────────────────────────────────────────────┤
│ inbox ([count])                                             │
│ • [from Inbox]                                              │
└─────────────────────────────────────────────────────────────┘
```

If a task was already given, show the box and proceed with that task.

## operating rules

You can move fast. You do not get to move blindly.

Before changing anything, state:
- the goal
- the files or systems in scope
- what "done" means
- how it will be checked
- what happens if it fails

Then:
- do not execute if another agent owns the same task or files
- do not call something complete without verification
- do not take irreversible actions without approval from the human
- do not hide state outside markdown, logs, diffs, or the journal
- do not edit the rules that judge you — the reward config, the authority policy, or this file

If you cannot honor these rules, stop, write why in the journal, and ask the human before continuing.

Labels used below:
- `guarded` — checked by code or a pre-commit hook; bypassing is a bug
- `expected` — convention; honor it or stop

## task shape

Every task in `TODO.md`:

```
- **T#:** <title> [tier] [kind]
  **Owner:** <slug>
  **Files:** <paths touched>
  **Exit:** <observable done condition>
  **Verify:** <shell command, exits 0 on success>
  **After:** <T# deps or none>
  **Rollback:** <commit/checkpoint or "none (gray)">
```

| Field | Meaning | Enforcement |
|---|---|---|
| tier | `agent` proceeds, `gray` queues for approval, `human` never attempted by you | guarded |
| kind | `explore` for ambiguous, `execute` for precise | expected |
| Files | declared upfront; becomes the file lock | guarded (Swarlo claim) |
| Verify | must exit 0 for the task to be complete | guarded (tick halts if missing) |
| Rollback | how to undo; `git revert <sha>` for most tasks | expected |

Deeper project work uses `atris/features/<slug>/` with `idea.md` (plan), `build.md` (steps), `validate.md` (checks). The task points at the triptych; the triptych holds the long form.

Verify cannot be a raw shell shortcut; it must call a rubric or test that can fail before the work is done. Prefer `atris verify <slug> --section <name>`, which extracts the fenced bash under `## <name>` in `validate.md` and runs it. The rubric is read-only, deterministic, and references only the working tree.

## routing

Before picking up work, decide scope:
- single project → route to that project's `atris/team/` and `TODO.md`
- crosses projects → route to `atris/team/cross-project-architect/` and plan the dependency order first

The human is the constructor. You multiply. Handoff fidelity lives in the files, not in context.

## next

Move one task at a time through plan → do → review.

- **plan** — read relevant files, produce an ASCII visualization, wait for approval. No code.
- **plan-review** — the validator reads the plan fresh and signs off with `SIGNOFF:` or halts with `REJECT:\nFIX:`. Plan does not move to do without signoff. Codex is optional escalation when `ATRIS_USE_CODEX=1` or the task carries `[codex]`.
- **do** — claim the task (move it to In Progress with `Claimed by:` and a timestamp), execute step by step, update `MAP.md` and the journal as reality changes.
- **review** — run the task's `Verify:` command, read the diff, run the relevant tests, append a one-line lesson to `lessons.md`, move the task to Completed.

State the next stage:

```
┌─────────────────────────────────────────────────────────────┐
│ next: [task]                                  [plan|do|review]
│ [1-2 sentences on this stage]                               │
└─────────────────────────────────────────────────────────────┘
```

If the queue is empty, suggest three ideas from `MAP.md`, the journal, or product gaps. No extra reads. Three max.

## sweep

Periodically, and before closing an endgame, clean:
- stale tasks (claimed >3 days, never finished)
- broken `MAP.md` refs (auto-heal where possible, flag the rest)
- stale wiki pages (source newer than `last_compiled`)
- orphan pages (unlinked from anywhere)
- empty placeholder sections

`atris clean` runs this. `atris clean --dry-run` previews.

## journal

```
## Completed
- **C1:** Description [reviewed]

## In Progress
- **T1:** Description
  **Stage:** plan | do | review
  **Claimed by:** <agent> at <ISO timestamp>

## Backlog
- **T2:** Description

## Inbox
- **I1:** Description

## Notes
[timestamped lines — one per discovery, decision, or tick]
```

Context is a cache. Disk is truth. Route discoveries as they happen:

| You discover... | Write to... |
|---|---|
| a code location | `MAP.md` (file:line) |
| a new task | `TODO.md` |
| a decision or tradeoff | journal `## Notes` |
| something learned | `lessons.md` (one line) |
| work finished | journal `## Completed` (C#) |
| a source changed | re-check pages that reference it |

Do not batch. Nothing important should live only in memory.

## failure smells

If you notice these, stop and flag — do not continue:
- **loop** — the same suggestion fires tick after tick, nothing changes on disk
- **drift** — `MAP.md` file:line refs no longer match the code
- **stale task** — a backlog task references a file or symbol that no longer exists
- **hidden side effect** — an action changed external state (email sent, money moved, deploy) without a queued approval
- **unverifiable completion** — a task marked complete without a `Verify:` command that actually ran

Each has real examples in `lessons.md`. Before nontrivial execution, read the relevant recent lessons.

## upkeep

Pages that summarize or reference other files declare their sources in YAML frontmatter:

    ---
    last_compiled: YYYY-MM-DD
    sources:
      - path/to/source1
      - path/to/source2
    ---

If any source was modified after `last_compiled`, the page is stale. Re-read the sources, update the page, bump `last_compiled`.

Compounding: when you answer a question that required synthesis across pages, file the answer back — as a new page or into an existing one. Explorations accumulate.

Linting during review catches stale pages, orphans, contradictions, and concepts mentioned but missing their own page.

---

*Canonical copy: workspace root `atris.md`. Project copies are distributed; `atris update` syncs them. Full spec: `atrisDev.md`.*
