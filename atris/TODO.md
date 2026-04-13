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

- **T1:** Fix two stale refs in cli-ux-simplification validate.md: (1) Check 4 bullet 1 says "workflow.js:84 comment" but actual comment is at line 83, (2) Check 6 bullet 1 says "atris.md Phase 3 reframed" but atris.md no longer uses Phase numbering — correct to "atris.md TASK RULES section (line 101) defines TODO.md-based task system". File: atris/features/cli-ux-simplification/validate.md. Done when: both line refs match actual source and grep confirms no "Phase 3" in atris.md. [execute]
  **Claimed by:** Executor at 2026-04-13T08:56:46.771Z
  **Stage:** DO

- **T2:** Make `atris business onboard` work from sparse input and emit a safe starter action
  **Stage:** DO
  **Claimed by:** Codex at 2026-04-13 13:05

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
