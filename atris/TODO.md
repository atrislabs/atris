# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** autopilot-runner-agnostic
**Picked:** 2026-06-15 23:32
**Horizon:** the autopilot/run heartbeat is engine-agnostic like missions already are — a claude -p pricing change, model retirement, or runner swap is a config flag, not a code change or a silent overnight outage
**Source:** user-prompt (Agent SDK credit-pause email surfaced the exposed flank: run.js + autopilot.js hardcode `claude -p` with no `--model`, while mission.js already resolves runner+model)

## Backlog

- **[CLI-762]** Ship npm auto-update for packaged installs (git checkouts stay manual) [update]
- **[CLI-761]** Ship ax connector turn isolation and Gmail receipt previews [ax]
- **[CLI-760]** Close runner-agnostic heartbeat gap: verify autopilot/run use shared runner-command flags [runner]

## In Progress

- **[CLI-763]** Ship atris launchpad command-center card with tests and MAP entry [launchpad]
  **Claimed by:** Executor at 2026-07-01T06:43:52.146Z
- **[CLI-744]** Mission XP: Decide and start the next useful mission after: Make mission-run continuation choose and start a concrete follow-up mission instead of marking choose_next_mission work ready on git diff --check [agent-xp]
  **Claimed by:** mission-lead
- **[CLI-742]** Mission XP: Decide and start the next useful mission after: Make atris mission run preflight messy operator input through Mission Room before visible-goal ack, so shower and overnight requests become crisp goals, task spines, receipts, and next actions instead of copying raw messy text into the native goal [agent-xp]
  **Claimed by:** mission-lead
- **[CLI-731]** Add timeline filter display object to mission timeline JSON output [loop]
  **Claimed by:** auto-improver
- **[CLI-573]** Mission XP: work overnight and see where we can self improve. goal after goal nonstop 6 hours [agent-xp]
  **Claimed by:** auto-improver

## Review

- **[CLI-758]** Make atris go execute one useful bounded slice [autonomy]
  **Verify:** node --test test/check-command-regression.test.js

## Blocked

- **[CLI-759]** Mission XP: go go go [agent-xp]
- **[CLI-501]** Design 24/7 functional team member factory [team-members]
- **[CLI-500]** Replace generic codex-executor ownership with functional team roles [team-roles]
- **[CLI-407]** Generate Atris Labs recruiting sync conflict packet [recruiting-sync]
- **[CLI-331]** Store YouTube analysis for Ec7VbXHg0uI [wiki]
- **[CLI-325]** Auto-improver: Next tick will stop until a human looks at the error. [auto-improver]
- **[CLI-223]** skill audit: no-xml-tags flags placeholders inside code blocks (9 skills false-FAIL) [cli-ux]
- **[CLI-222]** Revalidate 8 stale feature packs: heal drifted line refs, rerun rubric checks, bump last_compiled [wiki]
- **[CLI-221]** Recompile stale wiki pages that feed agent boot (systems/atris-cli, overview brief, concepts) [wiki]
- **[CLI-220]** Heal workspace drift: 82 stale MAP.md refs + archive 33 old journals via atris clean [maintenance]
- **[CLI-216]** Ship launch post: post linkedin-post.md, capture URL in journal, delete the file
- **[CLI-200]** Auto-improver: Recurring log pattern: Next tick will stop until a human looks at the error. [auto-improver]

(7 older blocked tasks archived in `atris task list --status failed` and `atris task events`.)

## Completed

- **[CLI-757]** Mission XP: to ensure mission run works again [agent-xp]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-756]** Mission XP: to ensure mission run works [agent-xp]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-755]** Mission XP: Messy Input Goal Chain Mission Room with mission-lead: turn "Dogfood Atris mission loop one more time: prove it can turn messy intent into the right next goal, choose only fresh work, or stop..." into one visible goal, task spine, proof receipt, and next action. [agent-xp]
  **Verify:** git diff --check
- **[CLI-754]** Mission XP: Decide and start the next useful mission after: Add timeline receipt display object to mission timeline JSON output [agent-xp]
  **Verify:** git diff --check
- **[CLI-753]** Mission XP: Add timeline receipt display object to mission timeline JSON output [agent-xp]
  **Verify:** git diff --check
- **[CLI-752]** Mission XP: Decide and start the next useful mission after: Add timeline filter display object to mission timeline JSON output [agent-xp]
  **Verify:** git diff --check
- **[CLI-751]** Mission XP: Add timeline filter display object to mission timeline JSON output [agent-xp]
  **Verify:** git diff --check
- **[CLI-750]** Mission XP: Decide and start the next useful mission after: make continuation missions auto-select a concrete follow-up mission from Atris state instead of returning a <next useful mission> placeholder [agent-xp]
  **Verify:** git diff --check

(464 older completed tasks archived in `atris task list --status done` and `atris task events`.)
