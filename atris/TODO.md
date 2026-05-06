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

- **T116:** Add safe `atris task sync` backend contract path [agent] [execute]
  **Owner:** codex
  **Claimed by:** codex at 2026-04-28T09:13:03Z
  **Files:** `commands/task.js`, `lib/task-db.js`, `test/commands.test.js`, `README.md`, `atris/MAP.md`, `atris/lessons.md`
  **Exit:** `atris task sync --dry-run` maps local rows to `/api/business/{business_id}/work/tasks` without writing cloud state, and live sync requires an explicit direction flag.
  **Verify:** npm test
  **After:** T115
  **Rollback:** revert this task's hunks

---

## Completed

- **T126 (shipped 2026-04-30):** Added separate brain approval rows without replacing learning feedback.
  - `atris brain go` and `atris brain hold` record `.atris/state/approvals.jsonl`.
  - `atris brain approval edit` records approval edits while `atris brain edit` remains learning feedback.
  - Verified with targeted brain tests and live Atris Labs approval.
- **T125 (shipped 2026-04-29):** Added activation modes for founder taste routing.
  - `atris brain activate --member keshav --mode founder-lab` routes Keshav into idea -> wedge hypothesis -> delegation.
  - Modes also cover builder, closer, and decision queue so founder work separates from Justin's GTM/customer ops.
  - Verified with targeted brain tests and live Atris Labs activation.
- **T124 (shipped 2026-04-29):** Added activation gallery for team-member experience testing.
  - `atris brain gallery` renders activation cards for every `atris/team/<member>/MEMBER.md`.
  - Lets Keshav test how each team member or agent starts the day without switching commands manually.
  - Verified with targeted brain tests and live Atris Labs gallery.
- **T123 (shipped 2026-04-29):** Remembered the operator for first-message activation.
  - `atris brain activate --member justin` writes `.atris/state/operator.json`.
  - Future `atris brain activate` runs reuse the remembered operator and route directly into the work block.
  - Generated brain boot blocks now tell new sessions to run `atris brain activate --root ... --verify` first.
- **T122 (shipped 2026-04-29):** Made brain activation refresh-first and identity-aware.
  - `atris brain activate` now recompiles the brain before rendering the operating card.
  - If no member is supplied, it asks for operator identity instead of giving a generic task.
  - Verified with `node --check commands/brain.js`, targeted brain tests, and live Atris Labs activation.
- **T121 (shipped 2026-04-29):** Added member-aware brain activation.
  - `atris brain activate --member justin` reads `atris/team/justin/MEMBER.md`, `START_HERE.md`, and `goals.md`.
  - Prints Justin as the operator and turns his activation into one customer-moving GTM rep with workspace update and scorecard.
  - Verified with `node --check commands/brain.js`, targeted brain tests, live Atris Labs activation, and `npm test` (275/275).
- **T120 (shipped 2026-04-29):** Added `atris brain activate`.
  - Prints a simple operating card from the compiled brain: context, next move, why, proof, and yes/edit/no feedback.
  - Makes the self-improvement loop feel like a tasteful business execution surface instead of documentation.
  - Verified with `node --check commands/brain.js`, `node --test test/commands.test.js --test-name-pattern brain`, `node bin/atris.js brain activate --root /Users/keshavrao/arena/atris-business/atris-labs --verify`, and `npm test` (273/273).
- **T119 (shipped 2026-04-29):** Added one-tap `atris brain yes/edit/no` feedback aliases.
  - Lets operators record approve/edit/reject brain feedback without knowing scorecard terminology.
  - Captured the second Atris Labs reward episode from Keshav's approval of the simpler one-tap feedback interface.
  - Verified with `node --check commands/brain.js`, `node --check bin/atris.js`, `node --check test/commands.test.js`, `node --test test/commands.test.js --test-name-pattern brain`, and `npm test` (272/272).
- **T118 (shipped 2026-04-29):** Added `atris brain feedback`.
  - Records approve/edit/reject operator reactions into linked `.atris/state/scorecards.jsonl` and `.atris/state/episodes.jsonl` rows.
  - Captured the first Atris Labs reward episode from Keshav's approval of the operator-feedback-as-RLHF direction.
  - Added regression coverage for `brain compile` and `brain feedback`; verified with `node --check commands/brain.js`, `atris brain feedback ... --verify`, `atris brain compile ... --verify`, and `npm test` (271/271).
- **T117 (shipped 2026-04-29):** Added `atris brain compile`.
  - Compiles MAP, TODO, wiki status, and `.atris/state/*.jsonl` into `atris/brain/STATUS.md`, `atris/brain/self_improvement_ledger.md`, and `atris/brain/state.json`.
  - Writes generated boot pointers into `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `atris/wiki/STATUS.md` so future agents load the compiled brain first.
  - Verified with `node --check commands/brain.js`, `node --check bin/atris.js`, and `node bin/atris.js brain compile --root /Users/keshavrao/arena/atris-business/atris-labs --verify`.
- **T115 (shipped 2026-04-28):** Hardened `atris task` before backend sync.
  - Preserved imported `Verify:` metadata through the DB-backed TODO shim, kept imported in-progress tasks claimed, and made `atris task` fail clearly on Node versions without `node:sqlite`.
  - Added task command regression coverage, documented `atris task` as an additive local agent task plane, and removed tracked Python bytecode from the package path.
  - Verified with `node --test test/commands.test.js`, `npm test` (265/265), `git diff --check`, and `npm pack --dry-run --json`.
- **T114 (shipped 2026-04-27):** Added the v3.14.0 computer card release slice.
  - Added `atris computer card` and `atris computer card --write` so a workspace can print or save its owner, computer type, memory, validation, proof, visual, and artifact paths without logging in.
  - Bumped package metadata to 3.14.0, added command/help/docs coverage, fixed verifier smoke tests, and excluded generated Python cache files from npm packaging.
  - Verified with `npm test` (260/260), `git diff --check`, and `npm pack --dry-run`.
- **T113 (shipped 2026-04-27):** Exposed the Owner -> Computer model in public CLI surfaces without schema changes.
  - Updated `README.md`, `bin/atris.js` help text, and `commands/computer.js` help so readers see `Owner = User | Business`, typed computers, and `atris business init` as shared owner + first/default computer.
  - Verified with grep and a public-surface cheap-agent eval; see `atris/reports/2026-04-27-owner-computer-model-eval.md`.
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
