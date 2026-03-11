# TODO.md

> **Last updated:** 2026-03-11

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.

---

## Backlog

---

## In Progress

- **T2:** Add per-phase duration tracking to `atris run` — collect `{plan, do, review}` times (ms) per cycle in the loop at `commands/run.js:255-285`, store in array. Update `logRunCompletion()` at line 168 to accept and log the breakdown. Print summary table after run at lines 319-323 showing each cycle's phase durations (plan Xs, do Xs, review Xs). [execute]
  - **Claimed by:** Executor at 2026-03-10T00:22:49.323Z

---

## Completed

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
