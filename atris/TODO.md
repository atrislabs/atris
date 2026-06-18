# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** autopilot-runner-agnostic
**Picked:** 2026-06-15 23:32
**Horizon:** the autopilot/run heartbeat is engine-agnostic like missions already are — a claude -p pricing change, model retirement, or runner swap is a config flag, not a code change or a silent overnight outage
**Source:** user-prompt (Agent SDK credit-pause email surfaced the exposed flank: run.js + autopilot.js hardcode `claude -p` with no `--model`, while mission.js already resolves runner+model)

## Backlog

## In Progress

- **T1:** Re-read sources and reconcile all drifted line refs in `atris/features/team-member-standard/build.md`, then bump `last_compiled` to 2026-06-18 [execute]
  **Claimed by:** Executor at 2026-06-18T09:23:11.156Z
  **Stage:** DO
  - **Why:** Compiled 2026-06-10; `commands/member.js` has grown so nearly every frontmatter source ref drifted (memberList 2886→2988, memberCreate 2941→3043, goal block 3438→3540, memberWake 6452→6734, memberLoop 6652→6765, tick/review/block/status 6966→7079, memberCommand 7210→7411, renderMemberNowMarkdown 411→412, member route 1648→1742). The Files-Touched table (build.md:29) also contradicts the frontmatter — it cites the route at `bin/atris.js:1242-1245` while frontmatter says `:1648`; both are wrong (actual `1742`). `memberPaths` (211-223) and `memberRun` (422) start lines are still accurate — leave those.
  - **Files:** target `atris/features/team-member-standard/build.md`; sources (read-only) `commands/member.js`, `commands/mission.js`, `bin/atris.js`, `atris/team/_template/MEMBER.md`, `atris/features/team-member-standard/idea.md`. Confirmed start lines to reconcile each range to: memberList=2988, memberCreate=3043, memberGoal=3540, memberGoalFromMission=3590, memberGoalFromScore=3749, memberWake=6734, memberLoop=6765, memberTick=7079, memberReview=7141, memberBlock=7219, memberStatus=7264, memberCommand=7411; mission.js renderMemberNowMarkdown=412; bin/atris.js memberCommand route=1742. Recompute each end line from the source before writing.
  - **Exit:** every frontmatter `sources:` ref and the body Files-Touched route ref (build.md:29) point to current source locations — member.js list/create/goal/wake/loop/tick-block-status/dispatch starts = 2988/3043/3540/6734/6765/7079/7411, mission.js renderMemberNowMarkdown = 412, bin/atris.js route = 1742; `memberPaths` (211) and `memberRun` (422) unchanged; each end line recomputed from source; `last_compiled` reads 2026-06-18; none of the eight stale starts (`member.js:2886/2941/3438/6452/6652/6966/7210`, `mission.js:411`) nor the two stale route refs (`atris.js:1648`, `atris.js:1242`) nor the `2026-06-10` token remain.
  - **Verify:** grep -q "last_compiled: 2026-06-18" atris/features/team-member-standard/build.md && ! grep -q "2026-06-10" atris/features/team-member-standard/build.md && ! grep -qE "member\.js:(2886|2941|3438|6452|6652|6966|7210)|mission\.js:411|atris\.js:(1648|1242)" atris/features/team-member-standard/build.md && grep -q "member.js:2988" atris/features/team-member-standard/build.md && grep -q "member.js:3043" atris/features/team-member-standard/build.md && grep -q "member.js:3540" atris/features/team-member-standard/build.md && grep -q "member.js:6734" atris/features/team-member-standard/build.md && grep -q "member.js:6765" atris/features/team-member-standard/build.md && grep -q "member.js:7079" atris/features/team-member-standard/build.md && grep -q "member.js:7411" atris/features/team-member-standard/build.md && grep -q "mission.js:412" atris/features/team-member-standard/build.md && grep -q "atris.js:1742" atris/features/team-member-standard/build.md
  - **Rollback:** git checkout -- atris/features/team-member-standard/build.md before commit, or git revert HEAD --no-edit after commit

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
