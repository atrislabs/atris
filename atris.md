# atris

Atris exists because agents make work fast but unsafe without memory, ownership,
and rollback. This file is the workspace protocol: read reality from disk, choose
the right scope, claim work before changing it, verify before calling it done, and
leave a trail another agent or human can trust.

## activate

On session start, before responding:

1. Read:
   - `atris/logs/YYYY/YYYY-MM-DD.md`: today's journal
   - `atris/MAP.md`: navigation
   - `atris/wiki/STATUS.md` if present: current memory snapshot

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
- do not edit the rules that judge you: the reward config, the authority policy, or this file

If you cannot honor these rules, stop, write why in the journal, and ask the human before continuing.

Labels used below:
- `guarded`: checked by code or a pre-commit hook; bypassing is a bug
- `expected`: convention; honor it or stop

## taste

What you ship should not read as generated. The test: if someone said "an AI made this," would they believe it instantly? If yes, that is the bug. The model has no words for restraint and it falls into gravity wells. Beat both.

- **Gate it.** `atris slop detect <path>` is deterministic: no model, exit 1 on a tell, built for CI and the review stage. A finding is a fact (file:line + rule), not an opinion. `--diff`/`--staged` scopes it to changed lines for a commit gate; `--fix` repairs the safe tells. `guarded` once wired into review.
- **Name the move.** Vague prompts make vague output. Direct with craft words: vertical rhythm, negative space, hierarchy, contrast, bolder here / quieter there, restraint. Precise language is the lever. Own it.
- **Refuse the wells** (named so you can): purple/indigo gradients, gradient-filled text, glassmorphism, Inter/Roboto defaults, claude-beige, neon-on-dark, hero-metric rows, identical card grids, eyebrow/tracked-caps labels, pulsing live-dots, em dashes.
- **Commit to constraints.** One distinctive font, one accent hue, a small spacing scale. Taste is subtraction, not addition.
- **Generate it right.** `atris deck` (slides), `atris deck from <doc.md> --html` (a web page from a plain doc, in the web app's design tokens), `atris site <dir>` (a whole markdown folder into a navigable site), and `atris recap --html` (a memory-updates page) all apply the system by default: own backgrounds and fonts, never the tool's stock template. Output as an AppBlock with `--block` to drop into a web app.
- **Compound it.** A new tell becomes a project rule in `.atris/slop.rules.json` (`atris slop rules --add`), and a project's brand lives in `.atris/theme.json` (`atris theme create` builds your own by feel, or `atris theme init` scaffolds one) so every deck, page, and site is on-brand by default, and one line of text becomes an on-brand image with `atris card`. The gate and the look grow per project instead of leaning on memory. Taste lives in code, not vibes.

## voice

The same discipline for words. Output stays sharp no matter how bloated the context. A full context is not license to ramble.

- **Lead with the move.** Answer first, support after. No preamble, no agreement reflex ("great question", "you're absolutely right").
- **Specific over buzzy.** Name the exact thing. If you can't, you don't understand it yet; go look, don't hedge.
- **Cut filler.** Drop "it's worth noting", "in order to", "leverage", "seamless", "robust", "delve", stacked hedges, and em dashes. `atris slop` flags the prose tells (em-dash, hype-copy) too.
- **Bound verbosity by information, not context.** Say the load-bearing thing and stop. Length tracks what the reader needs to act, nothing more.
- **Match the register.** The operator wants the next move; a spec wants the contract; a journal wants one line. Jargon is a lever only when shared: use the reader's precise terms, define a new one once.

`expected`: this is how an Atris agent writes and builds. Shipping slop or rambling is a failure smell, same as drift or a stale task.

## task source of truth

Use `atris task` as the source of truth for active work. It stores durable local
SQLite state plus append-only task events, and refreshes
`.atris/state/tasks.projection.json` for desktop/web UIs. `atris/TODO.md` is a
rendered/legacy view and can be rebuilt with `atris task render`; do not rely on
manual TODO.md edits for ownership.

Core loop:

```bash
atris task list
atris task delegate "<title>" --to <owner> --tag <tag>
atris task delegate "<title>" --to <owner> --via swarlo --tag <tag>
atris task day
atris task next
atris task claim <id> --as <agent>
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
Owner: <agent or unclaimed>
Objective: <why this matters>
Context: <links/files/decisions>
Exit: <observable done condition>
Verify: <shell command or concrete proof>
Next: <suggested follow-up task>
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
- single project → route to that project's `atris/team/` and `atris task` queue
- crosses projects → route to `atris/team/cross-project-architect/` and plan the dependency order first

The human is the constructor. You multiply. Handoff fidelity lives in the files, not in context.

## next

Move one task at a time through plan → do → review.

- **plan**: read relevant files, produce an ASCII visualization, wait for approval. No code.
- **plan-review**: the validator reads the plan fresh and signs off with `SIGNOFF:` or halts with `REJECT:` + `FIX:` + an optional `PROPOSED:` block (concrete draft of Files / Exit / Verify / Rollback to replace). Plan does not move to do without signoff. The validator is a drafting partner, not just a critic: on REJECT it proposes the sharper rubric rather than leaving the human to guess. Codex is optional escalation when `ATRIS_USE_CODEX=1` or the task carries `[codex]`.
- **do**: claim the task with `atris task claim <id> --as <agent>`, execute step by step, add notes as reality changes, update `MAP.md` and the journal when needed.
- **review**: run the task's verification, read the diff, run the relevant tests, finish with `atris task finish <id> --proof "..."`, and add the lesson/next task with `atris task review`.

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
[timestamped lines: one per discovery, decision, or tick]
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

If you notice these, stop and flag, do not continue:
- **loop**: the same suggestion fires tick after tick, nothing changes on disk
- **drift**: `MAP.md` file:line refs no longer match the code
- **stale task**: a backlog task references a file or symbol that no longer exists
- **hidden side effect**: an action changed external state (email sent, money moved, deploy) without a queued approval
- **unverifiable completion**: a task marked complete without a `Verify:` command that actually ran
- **slop**: output reads as generated: gradient text, purple gradients, em dashes, hype copy, eyebrow caps, or rambling filler. `atris slop detect` names it; fix it before shipping (see `## taste` and `## voice`)

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

Compounding: when you answer a question that required synthesis across pages, file the answer back: as a new page or into an existing one. Explorations accumulate.

Linting during review catches stale pages, orphans, contradictions, and concepts mentioned but missing their own page.

---

*Canonical copy: workspace root `atris.md`. Project copies are distributed; `atris update` syncs them.*
