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

**Slug:** check-before-acting
**Picked:** 2026-04-10 16:30
**Horizon:** The loop never proposes action from a resolved lesson or a stale fact. I4 (lesson-still-applies) shipped. `atris release` auto-drafts version bumps and /launch posts. v3.2.0 story is complete: "the loop checks before it acts."
**Source:** staleness-gate closed, I4 from inbox, user said "keep going"

---

## Backlog
- **L2:** Add `atris release` command. Reads git log since last tag, bumps version (patch/minor from scorecard count), commits, tags, pushes, creates GitHub release, drafts /launch post. [endgame]
  **Verify:** node bin/atris.js release --dry-run 2>&1 | grep -q "draft"
- **L3:** Bump to v3.2.0 final, commit release notes to README. [endgame]
  **Verify:** node -e "process.exit(require('./package.json').version==='3.2.0'?0:1)"

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed
- **L1c-1:** Write `test/lesson-gate.test.js` — 3 isLessonResolved cases (nonexistent file→true, matching keyword→false, no file refs→false). ✅
- **L1c-2:** Test proposeCandidateHorizons filter path — stubs execSync, confirms resolved lessons throw + [resolved] tag written. ✅

---
