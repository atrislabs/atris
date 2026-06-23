---
type: concept
slug: plan-do-review-loop
title: Plan Do Review Loop
sources:
  - README.md
  - atris/atris.md
  - commands/workflow.js
  - atris/team/navigator/MEMBER.md
  - atris/team/executor/MEMBER.md
  - atris/team/validator/MEMBER.md
last_compiled: 2026-06-23
last_verified: 2026-06-23
confidence: 0.89
dependencies:
  - atris/wiki/briefs/atris-cli-overview.md
  - atris/wiki/concepts/verifiable-reward-loop.md
actionability: "Use this to decide which Atris stage owns work, proof, member behavior, and task state before editing."
created: 2026-04-07
updated: 2026-06-23
tags:
  - workflow
  - core-loop
  - atris
---
# Plan Do Review Loop

Atris is organized around a strict loop. `README.md` brands it as `plan -> do -> review`; the workspace protocol makes the precondition explicit: read reality from disk before changing anything.

```text
read reality -> plan -> plan-review -> do -> review
```

## Stages

- **READ REALITY** — Run `atris`, check `atris/MAP.md`, read current task state, and inspect relevant files before touching code or docs.
- **PLAN** — Define goal, scope, done condition, verification, rollback, and an ASCII shape. Planning does not edit runtime code.
- **PLAN-REVIEW** — Validator signs off with `SIGNOFF:` or rejects with a concrete fix before the plan moves to build.
- **DO** — Claim the task with `atris task claim <id> --as <agent>`, execute the scoped work, and add notes as reality changes.
- **REVIEW** — Run verification, inspect the diff, finish with proof, and record any lesson or next task.

No stage is optional. The loop can name residual risk, but it cannot pretend proof exists.

## Agents per stage

Each CLI command binds to a team member spec in `atris/team/`:

| Command | Agent | Stage | Guardrail |
|---------|-------|-------|-----------|
| `atris brainstorm` | brainstormer | pre-scout | Ideas only, no code |
| `atris plan` | navigator | PLAN | Plans only, no code |
| plan-review | validator | PLAN-REVIEW | Sign off or reject the plan |
| `atris do` | executor | DO | Builds only, no unplanned work |
| `atris review` | validator | REVIEW | Checks only, no new features |

The three execution agents — navigator, executor, validator — each own one stage and stay in their lane. Brainstormer sits upstream when the queue is empty.

## Member Contracts

The default member specs add stricter behavior inside each stage:

- **Navigator** scouts before planning, reads wiki status when relevant, turns messy intent into an ASCII visualization, and writes `idea.md`, `build.md`, and initial `validate.md` checks. Tasks must be one job with a clear exit condition and `[explore]` or `[execute]` intent.
- **Executor** reads `build.md`, checks MAP before file operations, executes one step at a time, runs tests after changes, updates wiki memory when durable knowledge changes, and stops for re-scope after two errors on the same task.
- **Validator** gates both plan-review and final review. Plan-review must end with literal `SIGNOFF:` or `REJECT:` output for automation. Final review runs tests, checks scope, verifies MAP/wiki state, applies anti-slop review, updates validation status, and harvests lessons only when something genuinely surprising happened.

The member files still contain older wording about moving tasks directly through `TODO.md`. Current repo-level task truth supersedes that: use `atris task` for ownership, claims, proof, and review history; treat `TODO.md` as a rendered or legacy view.

## REVIEW pass/fail

REVIEW is the only gate that can close a task, and closing splits into two gates:

- **Pass (agent)** -> `atris task ready <id> --proof "..."` moves proof-backed work to Review; `atris task done --proof` records review/RL context. `atris task review` can record lessons or create the next task.
- **Pass (human)** -> only human `atris task accept <id>` moves the task to Done and mints Career XP; `atris task revise <id> --note "..."` sends work back to Do.
- **Fail** -> stay in DO, show the issues, and re-execute against the same task.

A failing review never auto-advances and never skips back to PLAN. The work stays at DO until the validator's checks go green.

Every stage also runs the Confidence Gate: find loopholes such as stale source, missing owner, weak proof, bad rollback, or hidden risk; then patch each one with source, verifier, proof, owner, rollback, or a named residual risk.

## Auto-chain modes

The loop can be walked by hand (`atris plan` -> `atris do` -> `atris review`) or chained:

- **`atris run`** — Autonomous `plan -> do -> review` loop. No human in the middle; intended for batch clearing of inbox/backlog.
- **`atris autopilot`** — Guided loop with approval checkpoints between stages. Same shape, human still in the loop.

Both modes walk the same shape. Auto-chaining changes who presses enter, not what counts as proof.

## Persistence rule

The loop only works because nothing important is allowed to live only in the context window:

> Context window = cache. Disk = truth. Route discoveries as they happen.

| You discover...           | Write to...           |
|---------------------------|-----------------------|
| Code location             | `MAP.md`              |
| New task                  | `atris task new` or `atris task delegate` |
| Decision / tradeoff       | journal → Notes       |
| Durable project knowledge | `atris/wiki/` + STATUS |
| Something learned         | `lessons.md`          |
| Work finished             | `atris task ready --proof`, human `atris task accept` |

Discoveries get routed at the moment they happen, not batched at session end. The loop is project-local: `atris/MAP.md` is navigation, `atris task` is active ownership, `atris/TODO.md` is a rendered board, `atris/logs/` is daily operating memory, and `atris/wiki/` is the durable knowledge layer that compounds across sessions.

## Cross-References

- [[atris/wiki/briefs/atris-cli-overview.md]] - repo-level summary of how the CLI, workspace, and wiki fit together
