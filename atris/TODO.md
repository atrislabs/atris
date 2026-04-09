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
## In Progress

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
