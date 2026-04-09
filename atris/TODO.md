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

**Slug:** harden-rl-loop
**Picked:** 2026-04-09 03:40
**Horizon:** All 4 failure modes identified by Codex (gpt-5.4) are addressed: judge corruption, proxy collapse, search collapse, state incompleteness. Each fix validated by calling Codex as the reviewer. When Codex re-audits and finds no critical failures, the loop is hardened.
**Source:** codex exec audit 2026-04-09 03:35am — 4 failure modes returned

**Prior endgame closed:** `ship-rl-to-npm` — v3.1.0 committed, pushed, npm pending OTP.

---

## Backlog
- **H2b:** In `commands/autopilot.js` `runTaskOnce`, add a guard: if `getVerifyCommand()` returns the default `'npm test'` (no explicit verify field on the task), halt the tick and write a lesson instead of silently succeeding. One file: `commands/autopilot.js`. Exit: ticks without an explicit `**Verify:**` field refuse to run. [execute] [endgame]
  **Verify:** codex exec "Read commands/autopilot.js runTaskOnce. If a task has no Verify field in TODO.md, does the tick halt or does it proceed? Answer HALTS or PROCEEDS only." --output-last-message /tmp/h2b-check.txt --full-auto && grep -qi "halts" /tmp/h2b-check.txt
- **H3:** Fix search collapse. Replace fixed 80/20 with adaptive explore rate based on scorecard diversity. If last 5 endgames are all the same type, boost explore to 50%. Add a minimum horizon difficulty floor so easy wins don't starve hard work. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js scoreEndgameCandidates. Does the explore rate adapt based on recent horizon diversity? Can it starve hard/novel work? Answer ADAPTIVE or FIXED only." --output-last-message /tmp/h3-check.txt --full-auto && grep -qi "adaptive" /tmp/h3-check.txt
- **H4:** Fix state incompleteness. Add a delayed regression check: each tick records its commit hash, and every 10th tick re-runs verify on the last 10 commits. If a past verify now fails, charge the original tick with a -5 retroactive penalty and write a lesson. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js. Is there a mechanism to retroactively penalize a past tick if its verify command fails on a later run? Answer YES or NO only." --output-last-message /tmp/h4-check.txt --full-auto && grep -qi "yes" /tmp/h4-check.txt
- **H5:** (eliminate) Remove the npm test double-default from getVerifyCommand. If a task has no verify field, the tick should refuse to run it, not silently default to npm test. [endgame]
  **Verify:** grep -q "refuse\|skip\|no verify" commands/autopilot.js

## In Progress

- **H2a:** Remove the generic auto-pass fallback in `verifyChange()` at `commands/verify.js:447-452`. Change the return from `pass: true` to `pass: false` with details explaining no specific check was possible. One file: `commands/verify.js`. Exit: `verifyChange()` never returns `pass: true` without a real check. [execute] [endgame]
  **Claimed by:** Executor at 2026-04-09T11:56:13.654Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

- **C23:** Add a research-lab workspace template and init path so Atris can scaffold RL-ready research environments without resetting the current endgame. `atris research init <name>` now ships a research-shaped workspace with eval-first reward policy and member lanes. [validated]

- **S3:** Add RL loop section to README.md (3 bullets, plain English, matches /launch format) [endgame]
  **Verify:** grep -q "reward" README.md
- **S6:** Create a private Presidio memory surface for flywheel docs and scorecards
  **Verify:** node --test test/commands.test.js

---
