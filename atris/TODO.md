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
- **T1:** Compute type diversity of last 5 scorecards in `scoreEndgameCandidates` (`commands/autopilot.js:1120`). Count unique types. If all 5 are the same type, set explore rate to 50%; otherwise scale between 20%-50% based on repetition. Replace the fixed `0.8` threshold on line 1172. Exit: explore rate is a computed variable, not a constant. [execute]
- **T2:** Add minimum horizon difficulty floor to `scoreEndgameCandidates` (`commands/autopilot.js:1120`). Define difficulty as inverse of historical success rate (shipped/attempted from scorecards). Filter out candidates whose inferred type has >80% success rate AND mean reward >5 unless no harder candidates exist. Exit: easy-win types can't monopolize selection when harder work is available. [execute]
- **T3:** Update existing `scoreEndgameCandidates` tests and add new ones in `test/commands.test.js:1077`. Add: (a) test that 5 same-type scorecards produce explore rate >= 0.5, (b) test that mixed-type scorecards keep explore rate ~0.2, (c) test that easy-win candidates are filtered when harder ones exist. Exit: all new + existing tests pass. [execute]
- **H3:** Fix search collapse. Replace fixed 80/20 with adaptive explore rate based on scorecard diversity. If last 5 endgames are all the same type, boost explore to 50%. Add a minimum horizon difficulty floor so easy wins don't starve hard work. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js scoreEndgameCandidates. Does the explore rate adapt based on recent horizon diversity? Can it starve hard/novel work? Answer ADAPTIVE or FIXED only." --output-last-message /tmp/h3-check.txt --full-auto && grep -qi "adaptive" /tmp/h3-check.txt
  **Claimed by:** Executor at 2026-04-09T12:14:57.142Z
  **Stage:** DO
- **H4:** Fix state incompleteness. Add a delayed regression check: each tick records its commit hash, and every 10th tick re-runs verify on the last 10 commits. If a past verify now fails, charge the original tick with a -5 retroactive penalty and write a lesson. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js. Is there a mechanism to retroactively penalize a past tick if its verify command fails on a later run? Answer YES or NO only." --output-last-message /tmp/h4-check.txt --full-auto && grep -qi "yes" /tmp/h4-check.txt
## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
