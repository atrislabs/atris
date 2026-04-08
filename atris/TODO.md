# TODO.md

> **Last updated:** 2026-04-07

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.

---

## Backlog

- **T2:** Update `atris/features/team-member-standard/validate.md` to match — fix "7 built-in members" → 6, add `upgrade` to verification commands, bump `last_compiled` to 2026-04-07. [execute]

---

## In Progress

- **T3:** Fix broken MAP.md ref for `statusAtris()` in Critical Files section. MAP.md line 814 says `commands/status.js:5-156`; verified actual range is `commands/status.js:15-216` (function declaration at line 15, closing `}` at line 216). One-line edit to MAP.md only. Exit: MAP.md line 814 reads `` `statusAtris()` → `commands/status.js:15-216` ``. [execute]
  **Claimed by:** Executor at 2026-04-08T06:15:43.186Z
  **Stage:** DO

---

## Completed

- [x] Build wiki upkeep loop — `atris loop`, `/loop`, stale/orphan detection, status/log refresh, tests
- [x] Fix experiments CLI review findings — console fallback + single-pack validate
- [x] Add `atris experiments` to CLI — scaffold, validate, benchmark
- [x] Audit runtime/CLI regressions — fixed `taskContexts` ReferenceError crash in doAtris (workflow.js:513,565), cataloged dead auth code in bin/atris.js
- [x] Audit journal/log merge behavior (lib/journal.js + commands/log-sync.js)
- [x] Install all skills to Codex (8 skills → ~/.codex/skills/)
- [x] Add frontmatter to email-agent, memory, autopilot skills
- [x] Clean up stale files, duplicate folders, gitignore
- [x] FEAT-001: CLI version in autopilot banner
- [x] Define Atris system skill
- [x] Publish skill distro + smoke test
- [x] Auth utils: chmod, dedupe, timeout
- [x] `atris search` command
- [x] INTUITION.md template
- [x] Last 3 completions at activate
- [x] "Learned" field in Handoff
- [x] "Any learnings?" validator prompt

---
