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
- **M4:** Modify `suggestNextTask(cwd)` in `commands/autopilot.js` — at the very END (after all 9 reactive signals + the existing fallback), if `suggestions.length === 0`, call `proposeCandidateHorizons(cwd)`, pick the highest-confidence one, return `{ task: candidate.title, why: candidate.rationale, kind: 'imagined', priority: 99 }`. Additive — only fires when nothing else does. Exit: dry-run from a clean workspace returns an `imagined` suggestion. [endgame]
- **M5:** Verify M4 end-to-end and journal the result — run `atris autopilot --dry-run` from the current clean workspace, observe an `imagined` suggestion fire, append a `### M2 verification — HH:MM` entry to today's journal `## Notes` with the candidate that was proposed and a one-line takeaway. Exit: dry-run shows `kind: imagined` for at least one suggestion AND journal has the verification entry. [endgame]
- **T8:** Smoke-test M2's `getRecentSignals(cwd)` in isolation (before M3 consumes it). From atris-cli root run `node -e "const s=require('./commands/autopilot').getRecentSignals(process.cwd()); console.log(JSON.stringify({commits: s.recentCommits.length, commitsType: Array.isArray(s.recentCommits), wikiType: typeof s.wikiHealth, lessons: s.recentLessons.length, lessonsType: Array.isArray(s.recentLessons)}, null, 2));"` and confirm: `commits >= 1`, `commitsType === true`, `wikiType === 'string'` (atris/wiki/STATUS.md exists in this repo), `lessons === 10`, `lessonsType === true`. Then run `npm test` and confirm 119/119 still green (no regression). Append a one-line `### M2 smoke — HH:MM` entry to today's journal `## Notes` with the result. Pattern to mirror: `getIdleTickCount` at `commands/autopilot.js:649` (pure read, try/catch each source, safe defaults on failure). Exit: smoke output matches the four assertions, tests still 119/119, journal entry exists. [execute]
- **T12:** Smoke-test M3's `proposeCandidateHorizons(cwd)` in isolation after it ships — M5 only verifies M4's end-to-end suggestNextTask path, not the helper itself, and `[2026-04-08] benchmark-prompt-paths` warns that prompt-building changes need a live-path assertion before closeout. Unlike T8 (pure read), M3 spawns real `claude -p` so the smoke must invoke the subprocess and validate the parsed array. From atris-cli root run `node -e "(async () => { const fn = require('./commands/autopilot').proposeCandidateHorizons; const out = await fn(process.cwd()); console.log(JSON.stringify({ isArray: Array.isArray(out), len: out && out.length, allReal: Array.isArray(out) && out.every(c => c && typeof c.title === 'string' && c.title.trim().length > 0 && !/placeholder|TODO|FIXME|^candidate \d+$/i.test(c.title.trim()) && typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1 && typeof c.rationale === 'string' && c.rationale.trim().length > 0), titles: (out || []).map(c => c && c.title) }, null, 2)); })().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });"` and confirm: `isArray === true`, `len === 3`, `allReal === true`, all 3 `titles` are real strings (no `placeholder` / `TODO` / `candidate 1` substrings). Expect ~30-60s runtime since it hits `claude -p`. Then run `npm test` and confirm the suite is still green (no regression from the new helper). Append a `### M3 smoke — HH:MM` entry to today's journal `## Notes` with the three candidate titles and a one-line takeaway about whether the LLM proposals look plausible vs the current workspace state. Pattern to mirror: T8 above — same shape, adapted for async + subprocess. Exit: smoke output matches all four assertions, tests still green, journal entry exists. [execute]

---

## In Progress

- **M3:** Add `proposeCandidateHorizons(cwd)` async helper to `commands/autopilot.js` — combines `getIdleTickCount` + `getRecentSignals`, builds a prompt asking the LLM "the loop has been idle N ticks. recent commits/wiki/lessons say X. propose 3 next horizons with one-line title + confidence 0-1 + one-sentence rationale", spawns `claude -p` with the prompt, parses the JSON response into `[{ title, confidence, rationale }]`. Exit: function exists, returns an array of 3 candidates when called, all candidates are real strings (not placeholders). [endgame]
  **Claimed by:** executor at 2026-04-08T19:29:52.364Z
  **Stage:** DO

---

## Completed

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
