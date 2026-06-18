# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** autopilot-runner-agnostic
**Picked:** 2026-06-15 23:32
**Horizon:** the autopilot/run heartbeat is engine-agnostic like missions already are — a claude -p pricing change, model retirement, or runner swap is a config flag, not a code change or a silent overnight outage
**Source:** user-prompt (Agent SDK credit-pause email surfaced the exposed flank: run.js + autopilot.js hardcode `claude -p` with no `--model`, while mission.js already resolves runner+model)

## Backlog

(Empty)

## In Progress

- **T1:** Reconcile the 4 drifted frontmatter source refs + bump dates in `atris/features/wiki-loop/validate.md` [execute]
  **Claimed by:** Executor at 2026-06-18T10:43:04.208Z
  **Stage:** DO
  Re-read confirmed 4 of 8 refs accurate (`commands/loop.js:1-114`, `commands/wiki.js:549-557`, `lib/wiki.js:436-619`, `lib/wiki.js:620-704`) — leave those untouched. The other 4 drifted because bin/atris.js + test/commands.test.js grew past 10k lines. Fix only these in the frontmatter `sources:` block: `bin/atris.js:686-700 (showLoopHelp)` → `bin/atris.js:702-715 (showLoopHelp)` (686-700 is now showServeHelp); `bin/atris.js:1739-1742 (top-level loop route)` → `bin/atris.js:1835-1843 (top-level loop route)`; `test/commands.test.js:13891 (loop help coverage)` → `test/commands.test.js:14430 (loop help coverage)`; `test/commands.test.js:15443-15499 (loop stale/suggest coverage)` → `test/commands.test.js:15982-16051 (loop stale/suggest coverage)`. Bump `last_compiled: 2026-06-10` → `2026-06-18` and `> **Validated:** 2026-05-10` → `2026-06-18`. Out of scope: the "Current Repo Report" snapshot numbers (15 pages/13 stale/2 orphans/3 candidates) — that is live `atris loop --dry-run` output, a different drift class, not a source ref.
  - **Files:** `atris/features/wiki-loop/validate.md` (edit); read-only sources to verify against: `bin/atris.js`, `test/commands.test.js`
  - **Exit:** the 4 drifted refs in validate.md resolve to live line numbers, `last_compiled` and `Validated` both read 2026-06-18, zero stale tokens (686-700, 1739-1742, :13891, 15443-15499, 2026-06-10) remain, and the 4 already-accurate refs are unchanged
  - **Verify:** sed -n '702p' bin/atris.js | grep -q 'function showLoopHelp' && sed -n '1835p' bin/atris.js | grep -q "command === 'loop'" && sed -n '14430p' test/commands.test.js | grep -q 'loop --help prints usage' && sed -n '15982p' test/commands.test.js | grep -q 'loop flags stale wiki pages' && grep -q 'last_compiled: 2026-06-18' atris/features/wiki-loop/validate.md && grep -q '702-715' atris/features/wiki-loop/validate.md && grep -q '1835-1843' atris/features/wiki-loop/validate.md && grep -q '14430' atris/features/wiki-loop/validate.md && grep -q '15982-16051' atris/features/wiki-loop/validate.md && ! grep -qE '686-700|1739-1742|:13891|15443-15499|2026-06-10' atris/features/wiki-loop/validate.md
  - **Rollback:** git checkout -- atris/features/wiki-loop/validate.md before commit, or git revert HEAD --no-edit after commit

## Review

- **[CLI-300]** Spaceship: 4-hour unattended member run emails operator progress [spaceship]
- **[CLI-299]** Make codex-executor activation ready [member]

## Blocked

- **[CLI-223]** skill audit: no-xml-tags flags placeholders inside code blocks (9 skills false-FAIL) [cli-ux]
- **[CLI-222]** Revalidate 8 stale feature packs: heal drifted line refs, rerun rubric checks, bump last_compiled [wiki]
- **[CLI-221]** Recompile stale wiki pages that feed agent boot (systems/atris-cli, overview brief, concepts) [wiki]
- **[CLI-220]** Heal workspace drift: 82 stale MAP.md refs + archive 33 old journals via atris clean [maintenance]
- **[CLI-216]** Ship launch post: post linkedin-post.md, capture URL in journal, delete the file
- **[CLI-200]** Auto-improver: Recurring log pattern: Next tick will stop until a human looks at the error. [auto-improver]
- **[CLI-162]** Refresh control packets after b20be master advance [review]
- **[CLI-161]** Refresh certified review acceptance packet after BCK-339 [review]
- **[CLI-160]** Refresh certified review acceptance packet after BCK-334 [review]
- **[CLI-89]** Dogfood business computer lifecycle with proof-backed AgentXP loop [computer]
- **[CLI-88]** AgentXP Mode first rep: complete one proof-backed customer-motion mission [agent-xp]
- **[CLI-62]** Emit Career XP game event on accepted proof [career-xp]

(1 older blocked task archived in `atris task list --status failed` and `atris task events`.)

## Completed

- **[CLI-298]** Onboard first-time users like a human host [onboarding]
  **Verify:** node --test test/context-gatherer.test.js test/cli-smoke.test.js
- **[CLI-297]** Clean README and release-facing help flags [docs]
  **Verify:** node --test test/commands.test.js --test-name-pattern=workspace-free
- **[CLI-296]** Autolog task completion to member and general logs [task]
- **[CLI-295]** Pulse heartbeat: durable overnight self-improvement loop (atris pulse) — OS cron runs mission engine, verifies, writes pulse receipts + reward scorecards; closes the open loop's 3 breaks (ignition, dry-run actor, reward feedback) [rsi]
- **[CLI-294]** Make self-improvement proof readable for nonengineers [rsi]
  **Verify:** node --test test/recap.test.js
- **[CLI-293]** Self-improvement proof tick: agent finds and fixes one verifier-backed repo weakness [rsi]
- **[CLI-292]** beliefs: gate-saturation-regime — when codebase hardens + accept gate saturates, shift from volume to depth (break the pin streak)
  **Verify:** node --test test/typed-lessons.test.js
- **[CLI-291]** test: cover loop.js buildReport (atris loop/upkeep wiki-health report, previously untested) — good-shape + orphan cascade
  **Verify:** node --test test/loop-build-report.test.js

(277 older completed tasks archived in `atris task list --status done` and `atris task events`.)
