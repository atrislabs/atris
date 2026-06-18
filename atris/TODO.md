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

(Empty)

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
