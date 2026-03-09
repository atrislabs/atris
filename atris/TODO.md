# TODO.md

> **Last updated:** 2026-03-09

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.

---

## Backlog

---

## In Progress

- **T1:** Add `atris run` section to CLAUDE.md — document purpose (autonomous plan→do→review loop), flags (`--once`, `--cycles=N`, `--verbose`, `--no-push`, `--dry-run`), when to use it vs manual plan/do/review, and the auto-push + self-heal behavior. Reference `commands/run.js` and MAP.md lines 275-308. [execute]
  - **Claimed by:** Executor at 2026-03-09T12:51:28.937Z

---

## Completed

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
