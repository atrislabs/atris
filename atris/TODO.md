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
- **S3b:** Wire `askModelFreshness` into `suggestNextTask` at line ~238. When `checkStaleness` returns `unverified`, call `askModelFreshness`. If fresh → propose. If not → skip + log. [execute] [endgame]
  **Verify:** grep -q "askModelFreshness" commands/autopilot.js && node -e "const src=require('fs').readFileSync('commands/autopilot.js','utf8'); process.exit(src.includes('askModelFreshness')&&src.includes('unverified')?0:1)"
- **S4:** Add `[unverified]` tag to TODO parser. Tasks tagged `[unverified]` are readable but never proposed. Only human or fresh verification removes the tag. [endgame]
  **Verify:** node -e "const {parseSection}=require('./lib/todo'); process.exit(0)"
- **S5:** Add human ask path. In interactive mode, print "Is [task] still relevant? y/n" for unverified high-priority items. In auto mode, skip silently. [endgame]
  **Verify:** grep -q "still relevant" commands/autopilot.js

## In Progress
- **S3a:** Add `askModelFreshness(fact, cwd)` function in `commands/autopilot.js`. Reuse `claude -p` tmpfile pattern from `executePhaseDetailed`. Prompt: "Is this task still relevant? Check the codebase: [title]". Parse output for yes/no + reasoning. Export it. [execute] [endgame]
  **Claimed by:** Executor at 2026-04-10T23:41:01.385Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
