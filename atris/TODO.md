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
- **L4:** Commit README release notes + any unstaged v3.2.0 changes. Tag `v3.2.0`. [execute]
  **Verify:** git tag --list v3.2.0 | grep -q v3.2.0

## In Progress
- **L3:** Add v3.2.0 release notes section to README.md — summarize staleness gate, lesson gate, `atris release` command, shell injection fix, Codex hardening. Insert above `## Update` near EOF. [execute]
  **Verify:** grep -q "v3.2.0" README.md
  **Claimed by:** Executor at 2026-04-11T04:45:49.511Z
  **Stage:** DO

<!-- agent-coordinator endgame queue (queued, waits for current endgame to close) -->

---

## Completed

---
