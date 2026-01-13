# TODO.md

> **Last updated:** 2025-12-30

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.

---

## Backlog

(Clean! All items implemented.)

---

## In Progress

- [ ] Install atris skill into Codex skills
- [ ] Run end-to-end atris feature test

---

## FEAT-001: Add CLI version to autopilot banner [DONE]

Already implemented:
- `commands/autopilot.js:227` — Shows `Atris Autopilot v${pkg.version}`
- `commands/brainstorm.js:497` — Shows `Atris Autopilot v${pkg.version}`

---

## Completed

- [x] Define Atris system skill (autopilot/validated outputs)
- [x] Simulate atris skill behavior + publish distro
- [x] Run atris skill behavior smoke test
- [x] Validate atris skill behavior
- [x] Tighten auth utils: chmod credentials, dedupe helpers, add request timeout
- [x] atris search <keyword> - grep across journal history (already implemented)
- [x] INTUITION.md template at init (already implemented in init.js:308-342)
- [x] Surface last 3 completions at activate (already implemented in activate.js:40-113)
- [x] Add "Learned" field to Handoff prompt (already implemented in workflow.js:1018)
- [x] Validator prompts "Any learnings?" at review end (already implemented in workflow.js:1024-1058)

---
