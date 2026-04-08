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

- **T20:** Rewrite cron tick summaries written into journal `## Notes` (the `/loop` heartbeat line) so a non-technical reader scanning today's journal can follow the loop's day. Exit: new heartbeat format lands in `commands/autopilot.js` (or wherever the Notes append lives); one real tick produces the new line. [execute]
- **T21:** Validate human-output end-to-end — run one full plan→do→review cycle, screenshot/capture each surface, confirm ≤20 lines × ≤80 chars and that a non-technical reader can decide approve/hold. Append verdict to `atris/features/human-output/validate.md`. Exit: validate.md exists with pass/fail per surface. [explore]

---

## In Progress

- **T19:** Rewrite validator / review-phase messages in `commands/workflow.js` (and `commands/run.js` summary) to plain language. [execute]
  - Claimed by: Executor at 2026-04-08T21:40:28.120Z
  - **T19a:** workflow.js reviewAtris() plain-language default, `--verbose` keeps boxes.
  - **T19b:** run.js cycle summary plain-language default, `--verbose` keeps banners.
  - **T19c:** Smoke-test + paste into validate.md. [explore]

---

## Completed

- [x] T18: Rewrite `atris status` to the chief-of-staff format — default output now gives short "where we are / what is queued / what is blocking" sections, `--verbose` keeps the legacy task board, and `node --test test/commands.test.js` stayed green (2026-04-08)
- [x] T17: Rewrite the autopilot visual tick block in `commands/autopilot.js` to the chief-of-staff format — default output is now plain-language briefing copy, `--verbose` keeps the legacy boxy engineering view, and `node --test test/commands.test.js` stayed green (2026-04-08)
- [x] T16: Draft the chief-of-staff output template — wrote `atris/features/human-output/examples.md` with happy-tick, idle-tick, and validator-pass examples, each 12 lines and under 80 chars wide (2026-04-08)
- [x] T15: Audited tick/status/validator output surfaces — audit table in `atris/features/human-output/idea.md` under `## Surface audit` covers `autopilot.js`, `status.js`, `workflow.js`, `run.js` with file:line + shape + what-it-prints per surface (2026-04-08)
- [x] T22: Standardize `atris-labs-canonical` from `wiki/synthesis/` to `wiki/briefs/` — moved the root wiki folder, rewrote live markdown links/docs/counts, and cleared the last old-path hits in `atris-business` (2026-04-08)
- [x] T14: M4 — wired `proposeCandidateHorizons` into `suggestNextTask` as imagined-fallback (async signature, try/catch with reduce for top confidence, caller awaited). `suggestNextTask.constructor.name === 'AsyncFunction'`, npm test 121/123 (baseline) (2026-04-08)
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
