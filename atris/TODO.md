# TODO.md

> **Last updated:** 2026-04-13

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.
The `## Endgame` section below holds the current horizon; `[endgame]`-tagged
tasks in `## Backlog` are pursued by /autopilot in priority order until done,
then /endgame picks the next horizon at the boundary.

---

## Endgame

**Slug:** forge-loop
**Picked:** 2026-04-16 01:02
**Horizon:** Cron-fired forge ticks in this repo write a local scorecard, pick the next queued task, and append lessons without backend changes or manual bookkeeping.
**Source:** user-prompt ("forge needs to be synced here")

---

## Backlog

## In Progress

- **T3:** Meta-validator for smoke.sh — `scripts/smoke_falsifier_check.sh` runs 3 known breaks (syntax, exec bit, fake MAP ref), restores after each, asserts each fails. Catches scorecard regressions. [endgame]
  **Verify:** `bash scripts/smoke_falsifier_check.sh`
  **Claimed by:** Executor at 2026-04-16T09:58:37.904Z
  **Stage:** DO

- **T4:** Add `scripts/forge_pick_idea.sh` — reads `atris/TODO.md` `[endgame]` tasks, emits highest-priority unclaimed one as JSON `{slug, title, verify}`. Becomes the work-pool reader the EC2 dispatch calls. [endgame]
  **Verify:** `bash scripts/forge_pick_idea.sh | jq -e .slug`
- **T5:** Append-helper `atris lesson add <slug> <pass|fail> "<text>"` — appends correctly-formatted line to `atris/lessons.md`. Forge bots write learnings here. [endgame]
  **Verify:** `node bin/atris.js lesson add forge-test pass "smoke" && tail -1 atris/lessons.md | grep -q forge-test`
- **T6:** Add `scripts/forge_overnight.sh` — start/stop/status wrapper for the caffeinated overnight forge loop so the repo has a real control surface instead of ad hoc nohup commands. [endgame]
  **Verify:** `bash scripts/forge_overnight.sh status | grep -qE "running|not running"`

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->
<!-- forge-loop endgame queue: T2-T5 above; horizon = smoke→scorecard→idea-picker→lesson-write,
     so cron-fired forgepilot ticks have a complete pipeline against this repo without backend changes -->

---

## Completed

- **T2:** Add `scripts/forge_scorecard.sh` — emits last-commit + smoke result as JSON to `atris/.forge/scorecard.jsonl`. Becomes the per-tick RL signal the EC2 box reads. [endgame]
- **T1:** Re-read sources and update atris/features/cli-ux-simplification/validate.md — all 6 source refs current, zero drift [execute → done]

---
