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

## task source of truth

Use `atris task` as the source of truth for active work. It stores durable local
SQLite state plus append-only task events, and refreshes
`.atris/state/tasks.projection.json` for desktop/web UIs. `atris/TODO.md` is a
rendered/legacy view and can be rebuilt with `atris task render`; do not rely on
manual TODO.md edits for ownership.

Core loop:

```bash
atris task list
atris task delegate "<title>" --to <functional-member> --tag <tag>
atris task delegate "<title>" --to <functional-member> --executed-by <engine> --via swarlo --tag <tag>
atris task day
atris task next
atris task claim <id> --as <functional-member>
atris task note <id> "<context, blocker, decision, or handoff>"
atris task finish <id> --proof "<tests, screenshot, diff, or receipt>"
atris task review <id> --lesson "<what improved>" --next "<next task>"
```

Headless agents should add `--json` where available and read
`.atris/state/tasks.projection.json` for a compact board view.
Swarlo is the live coordination layer for claims, heartbeats, and reports; the
task row/event stream remains the durable source of truth.

Every task record should carry:

```
Title: <small work packet>
Owner: <functional or feature member, not an engine>
Objective: <why this matters>
Context: <links/files/decisions>
Exit: <observable done condition>
Verify: <shell command or concrete proof>
Next: <suggested follow-up task>
```

Task planning preview and landing:

```
Owner: <functional-member>
Plan: <one sentence on the intended change>
Done: <observable result>
Check: <verifier, receipt, or artifact proof>
```

Owner is accountable company role (`task-planner`, `architect`, `mission-lead`,
`validator`, `launcher`, or a feature owner). Coding agent models like Codex and
Claude are not task owners; put them in the `executed_by` section when useful.
If no existing member fits, create a member-creation task instead of assigning
broad work to an engine or generic executor.

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
- single project → route to that project's `atris/team/` and `atris task` queue
- crosses projects → route to `atris/team/cross-project-architect/` and plan the dependency order first

The human is the constructor. You multiply. Handoff fidelity lives in the files, not in context.

## next

Move one task at a time through plan → do → review.

- **plan** — read relevant files, produce an ASCII visualization, wait for approval. No code.
- **plan-review** — the validator reads the plan fresh and signs off with `SIGNOFF:` or halts with `REJECT:` + `FIX:` + an optional `PROPOSED:` block (concrete draft of Files / Exit / Verify / Rollback to replace). Plan does not move to do without signoff. The validator is a drafting partner, not just a critic — on REJECT it proposes the sharper rubric rather than leaving the human to guess. Codex is optional escalation when `ATRIS_USE_CODEX=1` or the task carries `[codex]`.
- **do** — claim the task with `atris task claim <id> --as <agent>`, execute step by step, add notes as reality changes, update `MAP.md` and the journal when needed.
- **review** — run the task's verification, read the diff, run the relevant tests, finish with `atris task finish <id> --proof "..."`, and add the lesson/next task with `atris task review`.

Every stage runs the Confidence Gate before it advances:

```
am I factually confident enough to move this forward?
  -> find loopholes: stale source, missing owner, weak proof, bad rollback, hidden risk
  -> patch each loophole with source, verifier, proof, owner, rollback, or blocked note
  -> advance only when known loopholes are patched, verified, or named as residual risk
```

100% confidence is not a vibe. It means every known loophole has been closed or explicitly carried as residual risk.

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
| a new task | `atris task new "<title>"` |
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

*Canonical copy: workspace root `atris.md`. Project copies are distributed; `atris update` syncs them.*
