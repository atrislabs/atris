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
- **R5:** /endgame reads last 10 scorecards when picking a new horizon. Weight candidates by historical reward of similar horizon types. 80/20 exploit/explore split. [endgame]

## In Progress

- **R4:** Add `atris/scorecards.md` and write a scorecard when an endgame closes. Fields: slug, tasks shipped/attempted, wall-clock time, halt ratio, total reward, lessons generated. [endgame]
  **Claimed by:** executor at 2026-04-09T07:41:14.440Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed
- **B1:** Canonicalize business workspace creation. `atris business init <name>` now creates the cloud record plus a standalone canonical workspace with `.atris/business.json` and business templates. `atris business create <name> --workspace` routes to the same local-first shape. [validated]

---
