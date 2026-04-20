---
name: atris
description: Atris workflow enforcement for repos using atris/ (MAP, TODO, journal, features, plan-do-review, anti-slop). Use when the user asks to follow the Atris system or mentions atris, MAP.md, TODO.md, journal/logs, features, plan/do/review, or anti-slop policies.
version: 2.0.0
tags:
  - atris
  - workflow
  - memory
  - navigation
  - anti-slop
---

# Atris Skill

## Scope
- Use in repos that contain `atris/`, or when the user invokes Atris flow.
- If unsure, ask one question before acting.

## Required context
- Read `atris/atris.md`, `atris/PERSONA.md`, `atris/MAP.md`, `atris/TODO.md`.
- Read today's journal `atris/logs/YYYY/YYYY-MM-DD.md` when planning or executing.
- Before nontrivial execution, scan the recent entries in `atris/lessons.md` — patterns repeat.
- Read `atris/features/<slug>/` only when opening or closing a feature.

## MAP-first
- Read `atris/MAP.md` before any search.
- If MAP lacks the answer, run one search and update MAP.

## Operating rules (from atris.md)
Before changing anything, state: goal, files in scope, what "done" means, how it will be checked, what happens if it fails.

Do not:
- execute if another agent owns the same task or files
- mark complete without running the task's `Verify:` command
- take irreversible actions without approval from the human
- hide state outside markdown, logs, diffs, or the journal
- edit the reward config, authority policy, or `atris.md` itself

If you cannot honor these, stop, write why in the journal, and ask.

## Task shape
Every task in `TODO.md` declares:
```
**T#:** <title> [tier] [kind]
  **Owner:** <slug>
  **Files:** <paths touched>
  **Exit:** <observable done condition>
  **Verify:** <shell command, exits 0 on success>
  **After:** <deps or none>
  **Rollback:** <commit/checkpoint or "none (gray)">
```
Tier: `agent` proceeds, `gray` queues for approval, `human` never attempted.

## Workflow
Move one task through plan → do → review:
- **plan** — read relevant files, ASCII visualization, wait for approval. No code.
- **do** — claim the task (In Progress + `Claimed by: <agent> at <ISO>`), execute step by step, update `MAP.md` and the journal as reality changes.
- **review** — run `Verify:`, read diff, run tests, append one-line lesson to `lessons.md`, move task to Completed.

Deeper work uses `atris/features/<slug>/` with `idea.md` (plan), `build.md` (steps), `validate.md` (checks). The task points; the triptych holds the long form.

## Failure smells
If you see these, stop and flag:
- **loop** — same suggestion tick after tick, nothing changes on disk
- **drift** — MAP.md refs no longer match the code
- **stale task** — references a file or symbol that no longer exists
- **hidden side effect** — external state changed without a queued approval
- **unverifiable completion** — marked complete without `Verify:` actually running

## Policies
- Enforce `atris/policies/ANTISLOP.md` always.
- Load `atris-design.md`, `atris-backend.md`, or `writing.md` only when that domain is in scope.
- For authority tiers, see `policies/AGENT_AUTHORITY.md`.

## Improvement loop
After review, if output missed intent or failed verification, append one line to `atris/lessons.md`. If a lesson repeats 2-3 times, promote it into the relevant policy and prune.
