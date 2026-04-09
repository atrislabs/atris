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

- **T27 [In Progress, Claimed by: Executor at 2026-04-09T00:27:18.359Z]:** Validate T20 end-to-end — run `atris autopilot --auto --iterations=1` against this repo, copy the new Notes block into `atris/features/human-output/validate.md` under a `## T20 heartbeat` section, mark pass/fail against: (i) ≤20 lines × ≤80 chars, (ii) matches `examples.md` shape, (iii) idle case contains `0 tasks in 0s`, (iv) `getIdleTickCount` returns ≥1 after an idle tick. Exit: validate.md has the block + 4 check results. [explore]
- **T27a [In Progress, Claimed by: Executor at 2026-04-09T00:28:33.562Z]:** Run `node bin/atris.js autopilot --auto --iterations=1` from this repo and capture the resulting `## Notes` block (the `appendTickSummary` heartbeat) from today's journal `atris/logs/2026/2026-04-08.md`. Save raw block to scratch for T27b. Exit: heartbeat block captured. [execute]
- **T27b [In Progress, Claimed by: Executor at 2026-04-09T00:29:49.403Z]:** Append a new `## T20 heartbeat` section to `atris/features/human-output/validate.md` containing the captured raw block in a fenced `text` codeblock + measured line count + max line width. Exit: section exists with raw block + measurements. [execute]
- **T27c:** Under the same `## T20 heartbeat` section, score the 4 checks in a markdown table: (i) ≤20 lines × ≤80 chars, (ii) matches one of `examples.md` shapes (happy/idle/validator-pass), (iii) if idle tick → block contains literal `0 tasks in 0s`, (iv) `getIdleTickCount(process.cwd())` returns ≥1 after the idle tick (smoke via `node -e`). Append surface verdict line. Exit: 4 rows + verdict. [execute]

---

## In Progress

---

## Completed

- [x] T25a: Re-verified T25 wiring at `commands/autopilot.js:1271-1289` — `appendTickSummary` called with horizon from `readHorizonSlug` (:631), idle = `tickOutcome === 'idle' || (completed === 0 && tickOutcome !== 'halted')` (:1279), halted branch sets `tickNextStep='stop until a human looks at the error'` (:1254), block wrapped in try/catch (:1273-1289). All four conditions hold; T25b/c dropped (2026-04-08)
- [x] T26: Replaced the autopilot SKILL.md rule wording with the canonical "The CLI writes the heartbeat Notes block. Do not hand-write tick summaries to the journal." line and added the same rule under loop SKILL.md `## Rules`. Grep for `Notes` in both files now only shows the canonical rule (autopilot) and no agent-written heartbeat guidance (loop) (2026-04-08)
- [x] T25: Verified `appendTickSummary` wiring already shipped via T20 at `commands/autopilot.js:1271-1289` — calls helper with horizon from `readHorizonSlug` (:631), idle = `completed===0 && tickOutcome!=='halted'` (:1279), halted branch sets `tickNextStep='stop until a human looks at the error'` (:1254), whole block try/catch-guarded. All four T25a conditions hold; T25b/c can drop (2026-04-08)
- [x] T23: Confirmed T20 scope note in `atris/features/human-output/idea.md:129-134` — CLI heartbeat writer = `commands/autopilot.js:575-626` (`appendTickSummary`, called ~:1271); `run.js:188-196` writes a per-cycle header, not per-tick; today's `- HH:MM PDT — ...` lines are agent-only (skill-violation of `atris/skills/autopilot/SKILL.md:100`). T24 can cite without re-grepping (2026-04-08)
- [x] T21e: Wrote `## Verdict` at the bottom of `atris/features/human-output/validate.md` — surface|pass/fail|notes table for all 3 in-scope surfaces (autopilot tick FAIL, status default FAIL, review FAIL), overall FAIL line, top-fixes list, and shipping-history link chain back to T15/T16/T17/T18/T20/T21/T21a-d (2026-04-08) [reviewed]
- [x] T21d: Re-captured `atris review` default stdout into `atris/features/human-output/validate.md` under `## Surface: review` against a no-op workspace state. 6 content lines, max 93 chars. Command succeeded (no "needs in-progress task" error), so existing check results stand: (i) ≤20 lines PASS, (ii) ≤80 chars FAIL (93), (iii) plain-language PARTIAL (pre-run banner, not verdict), (iv) approve/hold FAIL. Surface verdict: FAIL — needs T19 rewrite (2026-04-08)
- [x] T21c: Captured `atris status` default + verbose stdout into `atris/features/human-output/validate.md` under `## Surface: status`. Default: 24 lines / ≤78 chars / sections present / approve-or-hold PARTIAL → surface FAIL. Verbose captured for reference only (2026-04-08)
- [x] T21b: Re-captured `atris autopilot --auto --iterations=1` default non-verbose stdout (no `--dry-run`) and replaced the `## Surface: autopilot tick` block in `atris/features/human-output/validate.md`. Measured 36 lines, max 78 chars. Result: FAIL on (i) ≤20 lines; PASS on (ii) ≤80 chars / (iii) plain-language / (iv) horizon + next step readable. Root cause unchanged from T21 — horizon paragraph rendered in full on every tick (2026-04-08)
- [x] T21a: Confirmed `atris/features/human-output/validate.md` already contains `## Surfaces under test` with 3 entries (autopilot tick, status default, review) — each row has a capture command and an `examples.md` shape reference. Exit condition (≥3 surfaces with command + shape ref) met without edits (2026-04-08)
- [x] T21: Validated human-output end-to-end — captured autopilot tick, status (default), and review surfaces; appended pass/fail-per-check verdict table to `atris/features/human-output/validate.md`. Overall FAIL: autopilot tick blows 20-line budget (39 lines), status is 2 lines / 3 chars over and lacks explicit decision line, review emits a pre-run banner with a 93-char line instead of a validator-pass block. Flagged `atris status` routing bug (`.atris/business.json` hijacks default status to `businessStatus('pallet')`) (2026-04-08)
- [x] T20: Added `appendTickSummary(cwd, ...)` to `commands/autopilot.js` and wired it into `autopilotAtris` end-of-tick (happy/idle/halted branches). Plain-language block lands in today's journal `## Notes`; idle ticks keep the `0 tasks in 0s` marker so `getIdleTickCount` still counts. `/autopilot` SKILL.md now instructs agents not to hand-write heartbeat lines. Smoke: `getIdleTickCount` → 1 after idle write; `node --test test/commands.test.js` 37/37 green (2026-04-08)
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
