---
type: concept
slug: plan-do-review-loop
title: Plan Do Review Loop
sources:
  - README.md
  - atris/atris.md
last_compiled: 2026-04-08
created: 2026-04-07
updated: 2026-04-08
tags:
  - workflow
  - core-loop
  - atris
---
# Plan Do Review Loop

Atris is organized around a strict loop. `README.md` brands it as `plan -> do -> review`, but the protocol in `atris/atris.md` opens the loop with an explicit reading pass, so the full shape is:

```
scout → plan → do → review
```

## Stages

- **SCOUT** — Read the relevant files first. Understand the territory before touching it. Report what you found.
- **PLAN** — ASCII visualization, approval gate, **no code yet**. Planning is only planning.
- **DO** — Execute step-by-step. Update the journal as you go so the next session inherits the work.
- **REVIEW** — Test, validate, clean up, delete completed tasks. Capture lessons.

No stage is optional, and no stage can be skipped. Every task walks the full path.

## Agents per stage

Each CLI command binds to a team member spec in `atris/team/`:

| Command | Agent | Stage | Guardrail |
|---------|-------|-------|-----------|
| `atris brainstorm` | brainstormer | pre-scout | Ideas only, no code |
| `atris plan` | navigator | PLAN | Plans only, no code |
| `atris do` | executor | DO | Builds only, no unplanned work |
| `atris review` | validator | REVIEW | Checks only, no new features |

The three execution agents — navigator, executor, validator — each own one stage and stay in their lane. Brainstormer sits upstream when the queue is empty.

## REVIEW pass/fail

REVIEW is the only gate that can close a task:

- **Pass** → move the task to `## Completed` in the journal, show DONE.
- **Fail** → stay in DO, show the issues, re-execute.

A failing review never auto-advances and never skips back to PLAN. The work stays at DO until the validator's checks go green.

## Auto-chain modes

The loop can be walked by hand (`atris plan` → `atris do` → `atris review`) or chained:

- **`atris run`** — Autonomous `plan → do → review` loop. No human in the middle; intended for batch clearing of inbox/backlog.
- **`atris autopilot`** — Guided loop with approval checkpoints between stages. Same shape, human still in the loop.

Both modes walk the same four stages in the same order. Auto-chaining changes who presses enter, not what the loop does.

## Persistence rule

The loop only works because nothing important is allowed to live only in the context window:

> Context window = cache. Disk = truth. Route discoveries as they happen.

| You discover...           | Write to...           |
|---------------------------|-----------------------|
| Code location             | `MAP.md`              |
| New task                  | `TODO.md`             |
| Decision / tradeoff       | journal → Notes       |
| Durable project knowledge | `wiki/` + STATUS      |
| Something learned         | `lessons.md`          |
| Work finished             | journal → Completed   |

Discoveries get routed at the moment they happen, not batched at session end. The loop is project-local: `atris/MAP.md` is navigation, `atris/TODO.md` is the queue, `atris/logs/` is the daily operating memory, and `atris/wiki/` is the durable knowledge layer that compounds across sessions.

## Cross-References

- [[atris/wiki/briefs/atris-cli-overview.md]] - repo-level summary of how the CLI, workspace, and wiki fit together
