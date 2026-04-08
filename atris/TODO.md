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

**Slug:** wiki-for-atrisos-web
**Picked:** 2026-04-08 (boundary auto-pickup from inbox I1)
**Horizon:** `/Users/keshavrao/arena/atrisos-web/atris/wiki/` exists with the standard scaffold (`index.md`, `log.md`, `STATUS.md`, `wiki.md` protocol), 3 entity pages for the major subsystems (app/, components/, lib/), and 1 synthesis page tying them together. Zero broken refs. Seeded from a real codebase scan, not guesses.
**Identity:** A wiki that bootstraps any project — proving the Memex pattern is portable beyond atris-cli. Same shape, different repo, same intelligence loop.
**Source:** inbox I1 (Keshav, 2026-04-08, "create wiki for arena/atrisos-web from scratch")

**Note:** atrisos-web already has an `atris/` folder with the standard scaffold (`MAP.md`, `TODO.md`, `team/`, `skills/`, `logs/`, `features/`) but NO `wiki/` directory. This endgame creates and seeds it.

**Prior endgame closed:** `wiki-from-atris-labs` — W1, W2, W3, W3b, W4a, W4b, W5a/b/c shipped (9 tasks, ~10 commits). Parser bug found and fixed mid-flight (`4db14d9`). Commits: cfd3030, bb4051d, 7ed4d3b, 6129a32, 7fa29ef, 40db84c, plus follow-ups.

---

## Backlog

- **T2:** Update `atris/features/team-member-standard/validate.md` to match — fix "7 built-in members" → 6, add `upgrade` to verification commands, bump `last_compiled` to 2026-04-08. [execute]

---

## In Progress

- **T8:** Refresh `atris/features/wiki-loop/validate.md` — bump `last_compiled` to 2026-04-08, drop `atris/skills/loop/SKILL.md` from sources (that file is now the autopilot heartbeat scheduler v2.0.0, not wiki upkeep — the wiki upkeep prompt was renamed to `/upkeep` and lives at `~/.claude/skills/upkeep/SKILL.md`, outside this repo), and update Pass 3 `npm test` count from `pass (98/98)` → `pass (118/118)`. CLI surface (`atris loop`, `atris wiki loop`, `loopAtris`, `buildReport`) is unchanged. [execute]
  **Claimed by:** Executor at 2026-04-08T11:54:54.674Z
  **Stage:** DO

---

## Completed

- [x] T6c: Refresh `atris/MAP.md` for the Endstate run surface and clear the last broken MAP ref blocking a green verifier pass (2026-04-08)
- [x] T6d: Rewrite `atris/features/endstate/validate.md` around shipped dry-run commands, exit condition, and focused harness checks (2026-04-08)
- [x] T6e: Promote `endstate` from Active Features to Completed Features with shipped status and date (2026-04-08)
- [x] T6b: Extend `test/experiments.test.js` with a parallel `endstate-stack` dry-run smoke so both benchmark tracks are exercised (2026-04-08)
- [x] T6a: Stop dry-run receipts from leaking uncommitted tree state into `changed_files` — dry-run artifacts now force `changed_files = []`, covered by test and verified with a real baseline receipt (2026-04-08)
- [x] T5: Fix drifted bin/atris.js ref in team-member-standard/build.md (1035-1038 → 1056), bump last_compiled (2026-04-08)
- [x] E5: Wrote atrisos-web-overview.md synthesis (request flow) + refreshed index/STATUS (2026-04-08)
- [x] E4: Wrote atrisos-web-middleware.md entity page + refreshed log/STATUS/index (2026-04-08)
- [x] E3: Wrote atrisos-web-routes.md entity page + refreshed log/STATUS/index (2026-04-08)
- [x] W4b: Refresh wiki log.md (added MEMBER.md ingest entry) + STATUS.md for atris-labs entity (2026-04-08)
- [x] W4a: Ingest atris-labs MEMBER.md → atris/wiki/systems/atris-labs.md (2026-04-08)
- [x] T4: Fix MAP.md broken ref `commands/verify.js:14-47` → `13-35` (2026-04-08)
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
