# TODO.md

> **Last updated:** 2026-04-12

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

- **T1:** Update cli-ux-simplification validate.md: (1) bump `last_compiled` to 2026-04-13, (2) update `validation_notes` to note 4 cosmetic commits since dc8ed07 with zero line-number drift, (3) reword Check #6 bullet "GETTING_STARTED.md references TODO.md as primary working set" → "GETTING_STARTED.md lists TODO.md in folder structure and key commands" to match the f5fd130 rewrite. All 6 source line refs confirmed current. Files: `atris/features/cli-ux-simplification/validate.md` only. **Verify:** grep validate.md for "primary working set" returns 0 hits. [execute]

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
