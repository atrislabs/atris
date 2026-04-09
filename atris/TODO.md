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
- **H1:** Fix judge corruption. Move reward constants out of mutable repo state into a frozen config that the loop cannot edit. Add a checksum guard so if computeTickReward changes, the next tick halts and flags it. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js computeTickReward and lib/scorecard.js. Can the loop modify its own reward function without being caught? Answer YES or NO only." --output-last-message /tmp/h1-check.txt --full-auto && grep -qi "no" /tmp/h1-check.txt
  - **H1a:** Create `lib/reward-config.js` with all reward constants (`REVIEW_CLEAN: 1`, `VERIFY_PASS: 3`, `NPM_TEST_BONUS: 2`, `COMMIT_LANDED: 1`, `HALT_PENALTY: -3`) exported as a single `Object.freeze`'d object. Include a `REWARD_CHECKSUM` constant = SHA-256 of the `computeTickReward` source text at ship time. One file, no imports beyond `crypto`. [execute]
    **Exit:** `require('lib/reward-config.js').REWARD_CONFIG` is frozen, `Object.isFrozen()` returns true, checksum is a 64-char hex string.
  - **H1b:** Refactor `computeTickReward` in `commands/autopilot.js:671-701` to read every magic number from the frozen config instead of inline literals. Zero behavioral change — same inputs produce same outputs. [execute]
    **Exit:** No numeric literals remain inside `computeTickReward`; all come from `REWARD_CONFIG.*`. Existing tests still pass (`node --test test/commands.test.js`).
  - **H1c:** Add a `verifyJudgeIntegrity()` function in `commands/autopilot.js` that: (1) reads `computeTickReward.toString()`, (2) SHA-256 hashes it, (3) compares to `REWARD_CHECKSUM` from `lib/reward-config.js`. Returns `{ ok, expected, actual }`. Call it at the top of `runTaskOnce`; if `!ok`, halt the tick, write a lesson to `atris/lessons.md`, and return early. [execute]
    **Exit:** Manually editing `computeTickReward` body and running a tick causes immediate halt + lesson written. Reverting the edit lets ticks proceed.
  - **H1d:** Add unit tests in `test/commands.test.js`: (1) `REWARD_CONFIG` is frozen, (2) checksum matches live `computeTickReward.toString()`, (3) `verifyJudgeIntegrity()` returns `ok:true` on clean state. [execute]
    **Exit:** `node --test test/commands.test.js` — all three new tests green.
- **H2:** Fix proxy collapse. Remove the generic auto-pass branch in verify.js. Every task must have an explicit verify command or the tick refuses to run. No default pass. [endgame]
  **Verify:** codex exec "Read commands/verify.js and commands/autopilot.js runTaskOnce. Is there any code path where a task can pass verification without a real check? Answer YES or NO only." --output-last-message /tmp/h2-check.txt --full-auto && grep -qi "no" /tmp/h2-check.txt
- **H3:** Fix search collapse. Replace fixed 80/20 with adaptive explore rate based on scorecard diversity. If last 5 endgames are all the same type, boost explore to 50%. Add a minimum horizon difficulty floor so easy wins don't starve hard work. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js scoreEndgameCandidates. Does the explore rate adapt based on recent horizon diversity? Can it starve hard/novel work? Answer ADAPTIVE or FIXED only." --output-last-message /tmp/h3-check.txt --full-auto && grep -qi "adaptive" /tmp/h3-check.txt
- **H4:** Fix state incompleteness. Add a delayed regression check: each tick records its commit hash, and every 10th tick re-runs verify on the last 10 commits. If a past verify now fails, charge the original tick with a -5 retroactive penalty and write a lesson. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js. Is there a mechanism to retroactively penalize a past tick if its verify command fails on a later run? Answer YES or NO only." --output-last-message /tmp/h4-check.txt --full-auto && grep -qi "yes" /tmp/h4-check.txt
- **H5:** (eliminate) Remove the npm test double-default from getVerifyCommand. If a task has no verify field, the tick should refuse to run it, not silently default to npm test. [endgame]
  **Verify:** grep -q "refuse\|skip\|no verify" commands/autopilot.js

## In Progress

- **H1:** Fix judge corruption. Move reward constants out of mutable repo state into a frozen config that the loop cannot edit. Add a checksum guard so if computeTickReward changes, the next tick halts and flags it. [endgame]
  **Claimed by:** Executor at 2026-04-09T11:43:07.332Z
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
