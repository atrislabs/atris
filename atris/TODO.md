# TODO.md

> **Last updated:** 2026-04-20

---

## Purpose

Tracks active tasks for Atris CLI development. Target state = 0.
The `## Endgame` section below holds the current horizon; `[endgame]`-tagged
tasks in `## Backlog` are pursued by /autopilot in priority order until done,
then /endgame picks the next horizon at the boundary.

---

## Endgame

_(none — v3.11.0 shipped proactive scanner. Oracle's 3 prescriptions + proactive-surprise inspired by the Proof talk all delivered. Next horizon TBD.)_

---

## Backlog

- **T100:** Fixture task — navigator smoke test placeholder, no source files touched [explore]
- **T101:** Fixture task — navigator smoke test sibling; exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T102:** Fixture task — navigator smoke test (2026-04-26 run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T103:** Fixture task — navigator smoke test (2026-04-26 sibling run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T105:** Fixture task — navigator smoke test (2026-04-26 follow-up); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T106:** Fixture task — navigator smoke test (2026-04-26 inbox-driven run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T107:** Fixture task — navigator smoke test (2026-04-26 navigator-invoked); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T108:** Fixture task — navigator smoke test (2026-04-26 follow-up navigator run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T109:** Fixture task — navigator smoke test (2026-04-26 next run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T110:** Fixture task — navigator smoke test (2026-04-27 run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T111:** Fixture task — navigator smoke test (2026-04-27 follow-up run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]
- **T112:** Fixture task — navigator smoke test (2026-04-27 next run); exit condition: this line exists in TODO.md Backlog. No source files touched. [explore]

## In Progress

---

## Completed

- **T1 (retired):** Guard token expiry — shipped in v3.6.0. Verify `grep -c "ensureValidCredentials" commands/workflow.js` returns 6.
- **T2/T3 (retired):** Agent-commands-solid endgame superseded by self-heal work (v3.6/v3.7) + typed-lessons (v3.8). `--agent` flag + e2e agent test deferred.
- **T30/T31/T32 (shipped in v3.8.0):** typed-lessons endgame
  - T30 — `parseLessons` + `loadLessonMetadata` + `runLessonDetector` added to `commands/autopilot.js`. 12 new tests in `test/typed-lessons.test.js`.
  - T31 — `isLessonResolved` runs detector when sidecar has one; legacy grep is the fallback (`isLessonResolvedLegacy`). Never auto-promotes prose lessons to resolved.
  - T32 — `atris/lessons.json` sidecar shipped with 4 real entries (2 resolved detectors, 2 observed process rules). Remaining 30+ legacy lessons stay prose-only and continue to work via fallback.
- **T40–T47 (shipped in v3.9.1):** wiki-staleness-sweep endgame
  - 8 feature/wiki pages refreshed with current file:line source refs and `last_compiled: 2026-04-20`.
  - Dogfood found `checkPageStaleness` parser bug: trailing `(annotation)` and `:line-range` suffixes weren't stripped before `fs.statSync`, causing false "missing" reports. Fixed; 5 new tests in `test/staleness-parser.test.js`.
  - `atris clean --dry-run` now reports: 0 stale tasks, 0 unhealable MAP refs, 0 stale wiki pages. Target state ✓.

---
