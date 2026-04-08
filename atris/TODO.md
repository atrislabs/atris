# TODO.md

> **Last updated:** 2026-04-08

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.
The `## Endgame` section below holds the current horizon; `[endgame]`-tagged
tasks in `## Backlog` are pursued by /autopilot in priority order until done,
then /endgame picks the next horizon at the boundary.

---

## Endgame

**Slug:** wiki-from-atris-labs
**Picked:** 2026-04-08
**Horizon:** atris-cli wiki has 3 new pages ingested from `/Users/keshavrao/arena/atris-business/atris-labs/`, with `index.md`, `log.md`, and `STATUS.md` updated to reflect them. Zero broken refs. Zero stale pages from this ingest.
**Identity:** A wiki that is alive — not write-once. Sources land here as soon as they exist; the loop keeps memory fresh without a human pulling the trigger.
**Source:** user-prompt (Keshav, 2026-04-08, "wiki to update would be great. you can work with atris-business/atris-labs as our wiki")

---

## Backlog

- **W2:** Ingest `/Users/keshavrao/arena/atris-business/atris-labs/atris.md` into `atris/wiki/` as a synthesis page (slug: `atris-labs-workspace-protocol`). Frontmatter contract: type/slug/title/sources/created/updated/tags. Cite absolute path in sources. [endgame] [execute]
- **W3:** Ingest `/Users/keshavrao/arena/atris-business/atris-labs/goals.md` into `atris/wiki/` as a concept or entity page (slug: `atris-labs-goals`). Same frontmatter contract, cite absolute path. [endgame] [execute]
- **W4:** Ingest `/Users/keshavrao/arena/atris-business/atris-labs/MEMBER.md` into `atris/wiki/` as an entity page (slug: `atris-labs`). Same frontmatter contract, cite absolute path. [endgame] [execute]
- **T2:** Update `atris/features/team-member-standard/validate.md` to match — fix "7 built-in members" → 6, add `upgrade` to verification commands, bump `last_compiled` to 2026-04-08. [execute]

---

## In Progress

---

## Completed

- [x] W5a/b/c: Refresh wiki index.md, log.md, STATUS.md for atris-labs ingest (2026-04-08)
- [x] W1: Scan atris-labs and pick top 3 ingest sources (atris.md, goals.md, MEMBER.md) — SCAN entry in atris/wiki/log.md
- [x] T3: Fix broken MAP.md ref for `statusAtris()` (commit c9a299e)
- [x] Refine Project Endstate one level deeper — neutral naming, `endgame`, Level 1 contract, shared artifact schema, and runnable experiment pack scaffolds
- [x] Define Project Endstate benchmark pack — feature spec, build plan, validation script, and features index entry
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
