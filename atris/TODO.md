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
- **L2a:** Create `commands/release.js` with `releaseAtris()` function. Reads git log since last tag (`git describe --tags --abbrev=0` → `git log <tag>..HEAD --oneline`), computes changelog, determines bump type (minor if any scorecard has reward≥5, else patch), bumps `package.json` version via `semver`-style string replace, commits, tags `vX.Y.Z`, pushes + pushes tags, calls `gh release create` with changelog body. Support `--dry-run` flag that prints draft without mutating. [endgame] [execute]
  **Verify:** node bin/atris.js release --dry-run 2>&1 | grep -q "draft"
- **L2b:** Wire `release` into CLI router. Add `'release'` to `knownCommands` array at `bin/atris.js:427`. Add `else if (command === 'release')` dispatch block near line ~1005 that parses `--dry-run` flag and calls `require('../commands/release').releaseAtris({ dryRun })`. [endgame] [execute]
  **Verify:** node bin/atris.js help 2>&1 | grep -q "release"
- **L2c:** Add `/launch` post draft output to `releaseAtris()`. After release succeeds (or in dry-run), print a 3-emoji-bullet launch post (Twitter+LinkedIn format per launch skill) summarizing the version, top changes, and link placeholder. [endgame] [execute]
  **Verify:** node bin/atris.js release --dry-run 2>&1 | grep -q "launch"
- **L3:** Bump to v3.2.0 final, commit release notes to README. [endgame]
  **Verify:** node -e "process.exit(require('./package.json').version==='3.2.0'?0:1)"

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed
- **L2a:** Create `commands/release.js` with `releaseAtris()` function [endgame] [reviewed]
- **L2b:** Wire `release` into CLI router [endgame] [reviewed]
- **L2c:** Add `/launch` post draft output to `releaseAtris()` [endgame] [reviewed]

---
