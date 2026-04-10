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

**Slug:** close-codex-gaps
**Picked:** 2026-04-09 11:40
**Horizon:** Codex said YES on H1 (judge corruption) and H2 (proxy collapse). Fix both until Codex says NO. The loop's own reward function and verification path must be tamper-proof.
**Source:** harden-rl-loop scorecard — H1/H2 rejected by Codex, H3/H4 approved

---

## Backlog

## In Progress
- **G3:** Fix H2 gap: audit every code path in runTaskOnce that can return verifyPass=true. Ensure none bypass the actual verify command execution. [endgame]
  **Verify:** codex exec "Read commands/autopilot.js runTaskOnce end to end. Is there ANY path where verifyPass is true without executing a real verify command? Answer YES or NO only." --output-last-message /tmp/g3-check.txt --full-auto && grep -qi "no" /tmp/g3-check.txt
- **G4:** Fix H1 gap: prevent same-commit checksum update. Add a test that the REWARD_CHECKSUM in reward-config.js matches the committed version, not the working tree. [endgame]
  **Verify:** npm test

## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
