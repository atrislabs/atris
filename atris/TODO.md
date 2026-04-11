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
- **L1c:** Test lesson-still-applies gate end-to-end. Create a temp lessons.md with a known-resolved lesson (references a file+pattern that doesn't exist). Run `isLessonResolved` → expect true. Run `proposeCandidateHorizons` dry-path → confirm resolved lessons are skipped. [endgame] [explore]
  **Exit:** manual verification that the gate works on real and synthetic lessons.
- **L2:** Add `atris release` command. Reads git log since last tag, bumps version (patch/minor from scorecard count), commits, tags, pushes, creates GitHub release, drafts /launch post. [endgame]
  **Verify:** node bin/atris.js release --dry-run 2>&1 | grep -q "draft"
- **L3:** Bump to v3.2.0 final, commit release notes to README. [endgame]
  **Verify:** node -e "process.exit(require('./package.json').version==='3.2.0'?0:1)"

## In Progress
- **L1a:** Add `isLessonResolved(lessonLine, cwd)` helper to `commands/autopilot.js`. [endgame] [execute]
  **Claimed by:** Executor at 2026-04-11T04:18:03.518Z
  **Stage:** DO
- **L1b:** Add post-filter in `proposeCandidateHorizons`. [endgame] [execute]
  **Claimed by:** Executor at 2026-04-11T04:18:03.518Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
