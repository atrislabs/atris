# TODO.md

> **Last updated:** 2026-04-09

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.
The `## Endgame` section below holds the current horizon; `[endgame]`-tagged
tasks in `## Backlog` are pursued by /autopilot in priority order until done,
then /endgame picks the next horizon at the boundary.

---

## Endgame

**Slug:** staleness-gate
**Picked:** 2026-04-10 00:15
**Horizon:** Before the loop acts on any fact older than 7 days, it verifies the fact is still true. Three states: actionable, [unverified], deleted. When it can't verify mechanically, it asks a local model (codex/claude) or the human. Stale follow-ups never fire.
**Source:** user conversation 2026-04-09 "pruning is so damn huge" + Backbone stale follow-up

**Prior endgame closed:** close-codex-gaps — G1-G3 shipped, Codex approved H2/H3/H4.

---

## Backlog

## In Progress
- **S5a:** Add `askHumanFreshness(taskTitle)` function near `askApproval()` (~line 284) in `commands/autopilot.js`. Readline prompt: "Is [task] still relevant? y/n". Returns `{ fresh: bool }`. [endgame] [execute]
  **Verify:** grep -q "askHumanFreshness" commands/autopilot.js
  **Claimed by:** Executor at 2026-04-11T00:01:38.807Z
  **Stage:** DO
- **S5b:** Wire human ask into staleness gate. Pass `auto` param into `suggestNextTask` (line 32). At line ~246, when `status === 'unverified'` and `!auto`: call `askHumanFreshness` instead of `askModelFreshness`. If `auto`: skip silently (keep current model-check path). Update call site at line ~1564 to pass `auto`. [endgame] [execute]
  **Verify:** grep -q "askHumanFreshness" commands/autopilot.js && node -e "require('./commands/autopilot.js')"
  **Claimed by:** Executor at 2026-04-11T00:01:38.807Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
