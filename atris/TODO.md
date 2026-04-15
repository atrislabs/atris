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

**Slug:** check-before-acting
**Picked:** 2026-04-10 16:30
**Horizon:** The loop never proposes action from a resolved lesson or a stale fact. I4 (lesson-still-applies) shipped. `atris release` auto-drafts version bumps and /launch posts. v3.2.0 story is complete: "the loop checks before it acts."
**Source:** staleness-gate closed, I4 from inbox, user said "keep going"

---

## Backlog

- **T2 [endgame:forge-loop]:** Add `scripts/forge_scorecard.sh` — emits last-commit + smoke result as JSON to `atris/.forge/scorecard.jsonl`. Becomes the per-tick RL signal the EC2 box reads. **Verify:** `bash scripts/forge_scorecard.sh && jq -e .smoke_pass atris/.forge/scorecard.jsonl | tail -1`
- **T3 [endgame:forge-loop]:** Meta-validator for smoke.sh — `scripts/smoke_falsifier_check.sh` runs 3 known breaks (syntax, exec bit, fake MAP ref), restores after each, asserts each fails. Catches scorecard regressions. **Verify:** `bash scripts/smoke_falsifier_check.sh`
- **T4 [endgame:forge-loop]:** Add `scripts/forge_pick_idea.sh` — reads `atris/TODO.md` `[endgame:*]` tasks, emits highest-priority unclaimed one as JSON `{slug, title, verify}`. Becomes the work-pool reader the EC2 dispatch calls. **Verify:** `bash scripts/forge_pick_idea.sh | jq -e .slug`
- **T5 [endgame:forge-loop]:** Append-helper `atris lesson add <slug> <pass|fail> "<text>"` — appends correctly-formatted line to `atris/lessons.md`. Forge bots write learnings here. **Verify:** `node bin/atris.js lesson add forge-test pass "smoke" && tail -1 atris/lessons.md | grep -q forge-test`

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->
<!-- forge-loop endgame queue: T2-T5 above; horizon = smoke→scorecard→idea-picker→lesson-write,
     so cron-fired forgepilot ticks have a complete pipeline against this repo without backend changes -->

---

## Completed

- **T1:** Re-read sources and update atris/features/cli-ux-simplification/validate.md — all 6 source refs current, zero drift [execute → done]

---
