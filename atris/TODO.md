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
- **T#1:** Understand scorecard format + horizon type inference. Read `lib/scorecard.js` and `atris/scorecards.md` structure. Determine how to categorize horizons by type (e.g., "wiki-*" vs "verify-*" vs "refactor-*"). Document in nav journal. [explore]
- **T#2:** Add `scoreEndgameCandidates(cwd, candidates)` function to `commands/autopilot.js` (~line 1040, near `proposeCandidateHorizons`). Read last 10 scorecards via `readScorecards()`. For each candidate, find similar past horizons by type prefix. Calculate mean reward per type. Score each candidate by historical expected value. Apply 80/20 policy: 80% return best, 20% return random for exploration. Exit: function exists, returns 1 candidate, 4 tests cover nominal/edge cases. [execute]
- **T#3:** Wire scoring into horizon picking. Replace line 206-207 in `commands/autopilot.js` — instead of `proposeCandidateHorizons` → pick best by confidence, call `scoreEndgameCandidates` to weight by history. Update MAP.md line refs. Exit: `npm test` passes, autopilot dry-run picks a candidate informed by scorecard history. [execute]

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed
- **R5:** /endgame reads last 10 scorecards when picking a new horizon. Weight candidates by historical reward of similar horizon types. 80/20 exploit/explore split. [endgame] [validated]
- **R4:** Add `atris/scorecards.md` and write a scorecard when an endgame closes. Fields: slug, tasks shipped/attempted, wall-clock time, halt ratio, total reward, lessons generated. [endgame] [validated]
- **B1:** Canonicalize business workspace creation. `atris business init <name>` now creates the cloud record plus a standalone canonical workspace with `.atris/business.json` and business templates. `atris business create <name> --workspace` routes to the same local-first shape. [validated]

---
