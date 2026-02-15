# TODO.md

> **Last updated:** 2026-02-10

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.

---

## Backlog

- **T1:** Remove dead `launchAtris()` function from bin/atris.js [execute]
  - Function defined at `bin/atris.js:2624` but has NO command routing (not in knownCommands, no `else if` branch)
  - ~250+ lines of unreachable code
  - MAP.md previously documented it as DEPRECATED; now marked as DEAD CODE
  - **Done when:** Function deleted from bin/atris.js, MAP.md launch entry removed, file still runs without errors

- **T2:** Verify and fix remaining stale line refs in MAP.md for commands/workflow.js, commands/init.js [execute]
  - `planAtris` range claimed 5-295 (may have shifted)
  - `doAtris` range claimed 297-665
  - `reviewAtris` range claimed 667-1005
  - `initAtris` range claimed 230-644
  - These were not verified in the 2026-02-10 audit (only routing lines and new entries were fixed)
  - **Done when:** All function ranges match actual source, verified with grep

---

## In Progress

(Clean)

---

## Completed

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
