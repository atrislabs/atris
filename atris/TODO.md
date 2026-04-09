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

**Slug:** ship-rl-to-npm
**Picked:** 2026-04-09 02:10
**Horizon:** atris v3.1.0 ships to npm with the complete RL loop (verify fields, reward scoring, scorecards, policy update). README documents the RL loop. Other repos can `npm install -g atris` and get the flywheel. GitHub release + /launch post ready.
**Source:** inbox I8+I9 shipped, rl-validates-itself closed, user said "keep going"

---

## Backlog
- **S2:** Bump package.json to v3.1.0 [endgame]
  **Verify:** node -e "const p=require('./package.json'); process.exit(p.version==='3.1.0'?0:1)"
- **S3:** Add RL loop section to README.md (3 bullets, plain English, matches /launch format) [endgame]
  **Verify:** grep -q "reward" README.md
- **S4:** (eliminate) Remove stale inbox items I8 and I9 from 2026-04-08 journal — they shipped [endgame]
  **Verify:** node -e "const c=require('fs').readFileSync('atris/logs/2026/2026-04-08.md','utf8'); process.exit(c.includes('I8:') && c.includes('[shipped]') ? 0 : 1)"
- **S5:** npm publish + GitHub release + /launch post [endgame]
  **Verify:** npm view atris version | grep -q 3.1.0

## In Progress

- **S1:** Commit all uncommitted RL work as one clean commit. Stage: atris/lessons.md, atris/scorecards.md, lib/scorecard.js, atris/MAP.md, atris/TODO.md, atris/wiki/systems/horizon-type-convention.md (deleted). Exclude .autopilot-prompt.tmp. [execute] [endgame]
  **Claimed by:** Executor at 2026-04-09T09:03:48.616Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
