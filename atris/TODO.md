# TODO.md

> **Last updated:** 2026-04-08

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.
The `## Endgame` section below holds the current horizon; `[endgame]`-tagged
tasks in `## Backlog` are pursued by /autopilot in priority order until done,
then /endgame picks the next horizon at the boundary.

---

## Endgame

**Slug:** verifiable-reward-loop
**Picked:** 2026-04-09 09:45
**Horizon:** Every autopilot tick produces a binary reward signal from mechanical checks (tests pass/fail, build compiles, exit codes). Scorecards accumulate per endgame. /endgame reads past scorecards to pick better horizons. The loop learns from its own outcomes without retraining the model.
**Source:** inbox I8 + I9, conversation 2026-04-09 "are we an RL environment" + AMP frontier flywheel parallel

**Prior endgame closed:** `loop-self-seeds-horizons` — M1-M4, T8-T47 shipped. Self-seeding + idle detection + candidate horizon imaginer all live.

---

## Backlog
- **T1:** [explore] Document horizon type categorization convention in atris/wiki. What prefixes exist (wiki, verify, refactor, loop, etc.)? What do they mean? Exit: Type guide written, examples clear. [endgame]
  **Claimed by:** Executor at 2026-04-09T08:18:08.665Z
  **Stage:** DO
- **T2:** [explore] Audit current + past horizon slugs. Are they consistent with the type-prefix pattern? Are there edge cases (e.g., hyphenated types like "verify-and-fix")? Exit: List of type patterns found, any issues logged.
- **T3:** [explore] Propose type validation rules for /endgame horizon suggestions. Should new candidates be checked against known types? Exit: Brief design for type-aware validation.
- **R9:** (Optional refinement) Refactor type inference if T2 finds inconsistencies. If prefix-only breaks down, add explicit type registry. Exit: Type inference handles all past horizons correctly.

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
