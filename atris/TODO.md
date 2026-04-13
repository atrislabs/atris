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

## In Progress

- **T1:** Fix two stale line refs in `atris/features/cli-ux-simplification/validate.md`: Check 1 bullet 1 end-line 220-334 → 220-335 (line 335 = `help` entry under Other), Check 6 bullet 4 MAP.md lines 477-505 → 481-509 (section shifted ~4 lines). Done when: both ranges match source. [execute]
  **Claimed by:** Executor at 2026-04-13T09:20:10.233Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
