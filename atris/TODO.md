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

(none — verifiable-reward-loop closed 2026-04-09. Next endgame TBD.)

---

## Backlog
- **T2:** [explore] Audit current + past horizon slugs. Are they consistent with the type-prefix pattern? Are there edge cases (e.g., hyphenated types like "verify-and-fix")? Exit: List of type patterns found, any issues logged.
- **T3:** [explore] Propose type validation rules for /endgame horizon suggestions. Should new candidates be checked against known types? Exit: Brief design for type-aware validation.
- **R9:** (Optional refinement) Refactor type inference if T2 finds inconsistencies. If prefix-only breaks down, add explicit type registry. Exit: Type inference handles all past horizons correctly.
- **T1:** [execute] Fix validate.md check #1.3 for cli-ux-simplification. Lines 345, 361, 377 don't exist in showHelp(). Either remove this check (help descriptions don't need to mention TODO.md) or redirect to docs references (GETTING_STARTED.md, PERSONA.md). Exit: Validation check either removed or corrected with valid source references.

## In Progress

- **V1:** [execute] Validate verifiable-reward-loop patch claims against committed code and current working tree. Exit: review the shipped R1-R5 logic, run the full test suite, and confirm whether the loop is actually ready to ship.
  **Claimed by:** validator at 2026-04-09 20:27 PDT
  **Stage:** REVIEW

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
