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

- **T2a:** Add `--name` flag to `parseOnboardFlags` and auto-scaffold `.atris/business.json` in `onboardBusiness()` when missing but name provided — so `atris business onboard --name "Foo" --website foo.com` works from a bare directory without `atris business init` first [execute]
  **Files:** `commands/business.js` (parseOnboardFlags ~:167, readWorkspaceBusinessMeta ~:208, onboardBusiness ~:439)
  **Exit:** `onboardBusiness('--name', 'Acme', '--website', 'https://acme.com')` succeeds in a directory with no `.atris/business.json`

- **T2b:** Write the starter action as a task to `atris/TODO.md` under Backlog after onboarding — so the loop can pick it up instead of it being prose-only in the cheat sheet [execute]
  **Files:** `commands/business.js` (onboardBusiness, after cheat sheet write ~:634)
  **Exit:** after onboard, `atris/TODO.md` contains one backlog task derived from `suggestStarterAction()` output

- **T2c:** Add `business onboard` to help text and add test for bare-directory bootstrap [execute]
  **Files:** `bin/atris.js` (showHelp ~:275), `test/commands.test.js`
  **Exit:** `atris help` lists `business onboard`; new test passes for onboard from empty dir with `--name`

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
