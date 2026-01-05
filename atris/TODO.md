# TODO.md

> **Last updated:** 2025-12-30

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.

---

## Backlog

- [ ] Add "Learned" field to Handoff prompt (commands/workflow.js)
- [ ] Surface last 3 completions at activate (commands/activate.js)
- [ ] Validator prompts "Any learnings?" at review end (commands/workflow.js)
- [ ] INTUITION.md template at init (Tripwires/Preferences/Dead Ends)
- [ ] atris search <keyword> - grep across journal history

---

## In Progress

- [ ] Install atris skill into Codex skills
- [ ] Run end-to-end atris feature test

---

## FEAT-001: Add CLI version to autopilot banner

**Files:**
- `commands/autopilot.js:223-227` — PRD-driven autopilot banner (primary)
- `commands/brainstorm.js:493-497` — Legacy full-cycle autopilot banner

**Tasks:**
- [ ] Import package.json version in autopilot.js
- [ ] Update banner to show `Atris Autopilot v2.0.21`
- [ ] Update legacy banner in brainstorm.js (same pattern)
- [ ] Test with `atris autopilot --dry-run`

---

## Completed

- [x] Define Atris system skill (autopilot/validated outputs)
- [x] Simulate atris skill behavior + publish distro
- [x] Run atris skill behavior smoke test
- [x] Validate atris skill behavior
- [x] Tighten auth utils: chmod credentials, dedupe helpers, add request timeout

---
