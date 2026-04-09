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

**Slug:** rl-validates-itself
**Picked:** 2026-04-09 01:45
**Horizon:** The improved RL loop runs a full tick on itself, auto-writes a scorecard, and proves every connection works end-to-end. The loop that fixed its own bugs now validates its own fixes.
**Source:** user-prompt "validate while i shower" + Feynman audit proving 5 gaps existed

---

## Backlog
- **T2:** Export `writeLesson` from `commands/autopilot.js` module.exports and add a unit test in `test/commands.test.js` that: creates a temp dir with a lessons.md, calls writeLesson, asserts the file grew by one lesson line. Exit: `npm test` passes with the new test. [execute]
  **Verify:** npm test
- **T3:** Run F2's verify command to close the task. If it passes, move F2 to Completed. Exit: verify exit code 0. [execute]
  **Verify:** node -e "const c=require('fs').readFileSync('atris/lessons.md','utf8').split('\\n').length; process.exit(c > 33 ? 0 : 1)"
- **F3:** Confirm scorecard auto-writes when endgame completes — check scorecards.md exists and has content after this endgame closes [endgame]
  **Verify:** test -f atris/scorecards.md

## In Progress

- **F1:** Run `atris autopilot --auto --iterations=1` and confirm the tick completes with a reward score in the journal [endgame]
  **Verify:** grep -q "Reward:" atris/logs/2026/2026-04-09.md
  **Claimed by:** Executor at 2026-04-09T08:44:02.227Z
  **Stage:** DO

- **F2:** Confirm verify failure writes a lesson automatically — trigger a failing verify and check lessons.md grows [endgame]
  **Verify:** node -e "const c=require('fs').readFileSync('atris/lessons.md','utf8').split('\\n').length; process.exit(c > 33 ? 0 : 1)"
  **Claimed by:** Executor at 2026-04-09T08:48:24.091Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
