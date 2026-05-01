# AGENTS.md — Universal Agent Instructions

> Works with: Claude Code, Cursor, Codex, Windsurf, and any AI coding agent.

## Quick Start

```bash
atris
```

Run this first. Follow the output.

## Core Files

| File | Purpose |
|------|---------|
| `atris/PERSONA.md` | Communication style (read first) |
| `atris task` | Current tasks, claims, dialogue, proof |
| `.atris/state/tasks.projection.json` | Readable task projection for UIs/agents |
| `atris/TODO.md` | Rendered/legacy task view only |
| `atris/MAP.md` | Navigation (where is X?) |

## Workflow

```
PLAN  → atris plan   (break ideas into tasks)
BUILD → atris do     (execute tasks)
CHECK → atris review (verify + cleanup)
```

## Rules

- [ ] 3-4 sentences max per response
- [ ] Use ASCII visuals for planning
- [ ] Check MAP.md before touching code
- [ ] Run `atris task list` or `atris task next` before picking work
- [ ] Claim tasks with `atris task claim <id> --as <agent>`
- [ ] Finish tasks with proof via `atris task finish <id> --proof "..."`
- [ ] Treat `atris/TODO.md` as a rendered view; do not manually use it as the source of truth

## Anti-patterns

- Don't explore codebase manually (use MAP.md)
- Don't skip visualization step
- Don't leave stale tasks
- Don't hand-edit TODO.md for active task ownership
- Don't write verbose docs

---

**Protocol:** See `atris/atris.md` for full spec.

<!-- ATRIS_BRAIN_COMPILE:START -->
## Atris Brain Compile

This workspace has a compiled agent brain.

Load these first:
- `atris/brain/STATUS.md`
- `atris/brain/self_improvement_ledger.md`
- `atris/MAP.md`
- `atris task list`

Re-run after meaningful work:
`atris brain compile --root /Users/keshavrao/arena/atris-cli`
<!-- ATRIS_BRAIN_COMPILE:END -->
