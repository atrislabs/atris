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

**Slug:** loop-self-seeds-horizons
**Picked:** 2026-04-08 (M2 from the 7-day plan)
**Horizon:** When `atris/TODO.md` has zero `[endgame]` tasks AND no inbox items AND no reactive signals, the autopilot loop reads recent commits + `wiki/STATUS.md` + `lessons.md` + the idle-tick history, asks the LLM to propose 3 candidate horizons with confidence scores, picks the highest, writes it to `## Endgame` + tagged backlog, and the next tick executes the first step. End state: the loop never silently idles for more than one tick — it always either has work or has just imagined some.
**Source:** session conversation 2026-04-08 — "set goal, solve problem, validate truth, update beliefs, set new goal" + the 24+ idle ticks observed today proving the gap is real.

**Prior endgame closed:** `wiki-for-atrisos-web` — E1-E5 + T1-T4 (~14 tasks, 6+ commits across atris-cli + atrisos-web). Boundary auto-pickup from inbox proven. M1 self-improving close shipped mid-stream (`488fb50`).

---

## Backlog
- **T14:** Implement M4 — wire `proposeCandidateHorizons` into `suggestNextTask` as the imagined-fallback. Three coupled edits in `commands/autopilot.js`, must land together: (1) `commands/autopilot.js:25` — change signature `function suggestNextTask(cwd, skipped = new Set())` → `async function suggestNextTask(cwd, skipped = new Set())`. (2) `commands/autopilot.js:203` — replace `if (suggestions.length === 0) return null;` with a try/catch that calls `await proposeCandidateHorizons(cwd)`, picks the candidate with the highest `confidence` (use a `reduce`, not `sort` — the array is exactly 3), and returns `{ task: top.title, why: top.rationale, kind: 'imagined', priority: 99 }`; on any throw (the helper validates strictly and rejects with `proposeCandidateHorizons: ...` errors) `return null` so the loop's existing `if (!suggestion) → "nothing to do. workspace is clean."` path still works. (3) `commands/autopilot.js:895` — update the only caller to `const suggestion = await suggestNextTask(cwd, skipped);`. The call site is inside the already-async `autopilotAtris` for-loop but **outside** any try/catch — leaving it sync would silently return a Promise and break the `if (!suggestion)` branch, which is the bug the try/catch in step 2 protects against. Do NOT touch the 9 reactive signals above line 203, the lessons-harvest fallback (lines 182-201), the sort/return at lines 205-206, or `module.exports.suggestNextTask` at line 1008 (function reference export — async wrapper passes through fine). Do NOT add a new `skipped`-key kind for `imagined` — the fallback only fires when `suggestions.length === 0`, so dedupe is unnecessary. Pattern to mirror: existing return shapes at lines 35-40 (endgame) and 49-54 (resume). No tests reference `suggestNextTask` (grep'd), so no test updates required. Exit: (a) `node -e "console.log(require('./commands/autopilot').suggestNextTask.constructor.name)"` from atris-cli root prints `AsyncFunction`; (b) `npm test` shows no new failures vs the pre-existing 121/123 baseline (the 2 known T7 `getContextFiles-dead-return` fails are unrelated and pre-date this task). End-to-end `imagined`-suggestion verification and journaling are owned by M5 — do not duplicate that work in T14. [execute]

---

## In Progress
---

## Completed

- [x] T12: Smoke-test M3's `proposeCandidateHorizons(cwd)` in isolation — live `claude -p` call returned `isArray=true`, `len=3`, `allReal=true`; top candidate was the known `getContextFiles-dead-return` bug (0.93). `npm test` 121/123 (baseline — same 2 pre-existing fails). Journal entry `### M3 smoke — 13:42` appended (2026-04-08)
- [x] T8: Smoke-test M2's `getRecentSignals(cwd)` regression check post M3/M4/M5 — commits=20, commitsType=true, wikiType='string', lessons=10, lessonsType=true; `npm test` 121/123 (matches baseline, the 2 fails are pre-existing `getContextFiles-dead-return`); journal entry `### M2 smoke — 13:30` appended (2026-04-08)
- [x] T13: Fan out the wiki `briefs/` rename to local business workspaces — safely migrated `doordash`, `pallet-canonical`, `vitalize-canonical`, and `atris-labs-canonical-stale-2026-04-08` by running the scaffold migration logic plus targeted markdown rewrites; no `atris/wiki/syntheses/` directories remain in those workspaces (2026-04-08)
- [x] T11: Verify the wiki `briefs/` rename end-to-end — focused tests + migration smoke + `clean --dry-run` green; no old-name refs remain in source-of-truth files outside legacy-compat code/tests (2026-04-08)
- [x] T10: Migrate the atris-cli wiki content/docs from `syntheses/` to `briefs/` — moved checked-in wiki pages, rewrote internal links, and refreshed protocol/index/STATUS/log/docs text (2026-04-08)
- [x] T9: Rename the wiki analysis folder from `syntheses/` to `briefs/` in the source of truth — scaffold code, prompts, canonical business templates, and sync migration path now point at `briefs/` (2026-04-08)
- [x] M2: Add `getRecentSignals(cwd)` helper to `commands/autopilot.js:684` — `{ recentCommits, wikiHealth, recentLessons }` from `git log --oneline -20` + `atris/wiki/STATUS.md` + last 10 lines of `atris/lessons.md`. Smoke: commits=20, wikiType='string', lessons=10. No production callers (2026-04-08)
- [x] M1: Add `getIdleTickCount(cwd)` helper to `commands/autopilot.js` — scans today's journal `## Notes` bottom-up for `0 tasks in 0s` markers (case-insensitive substring), counts consecutive matches, returns 0 when journal absent or no `## Notes` section. Pure read-only, no callers yet. Tests 119/119 green (2026-04-08)
- [x] T7: Split Endstate into real baseline vs stack live runners — per-pack runner profiles now drive different benchmark prompt strategies and are captured in receipts (2026-04-08)
- [x] T4e: Closeout endgame `wiki-for-atrisos-web` — `atris clean --dry-run` from atrisos-web reports 0 stale tasks / 0 broken refs / 0 stale wiki pages; closeout Notes line appended to atris-cli journal (2026-04-08)
- [x] T4d: Refresh atrisos-web/atris/wiki/STATUS.md — Health 4/2, Next-ingests horizon met with I1 dir enumeration, T2/T3 rationale appended to Notes (2026-04-08)
- [x] T4c: Refresh atrisos-web/atris/wiki/index.md — added client-primitives entity bullet + auth-flow synthesis bullet (2026-04-08)
- [x] T4b: Refresh atrisos-web/atris/wiki/log.md — prepended SYNTHESIS T3 (auth-flow) + INGEST T2 (client-primitives) above E5 entry (2026-04-08)
- [x] T4a: Fix drift in atrisos-web/atris/wiki/syntheses/atrisos-web-auth-flow.md:22 — bare `payment/` → `/payment/success`, `/payment/cancel` (2026-04-08)
- [x] T1: Scan `atrisos-web/{components,lib,hooks}/` + wiki health for endgame `wiki-for-atrisos-web` — gap list posted to journal, `atris clean --dry-run` from atrisos-web all green, T2 scope confirmed as-is (2026-04-08)
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
