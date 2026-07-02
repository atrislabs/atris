# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** mission-run-fleet
**Picked:** 2026-07-02 12:20
**Horizon:** `atris mission run --fleet` staffs every idle installed engine on the board's claimable safe-lane tasks — one mission per task with a verifier, one worktree per engine, arrivals landed serially with rebase-before-ship so every task ends merged-or-reaped, receipt-backed, orb-signed. Falsifiable: one command on this repo's real board produces >=3 merged PRs from >=3 different engines with zero manual git surgery. Humble name outside, the full loop inside.
**Source:** user-prompt (manual 3-engine flight 2026-07-02 landed PRs #191-193; founder: try first, endgame after — this is the reverse path from that flight)

## Backlog

- **T1:** Dispatch primitive in lib/fleet.js: buildFleetPrompt(task) generates the bounded prompt from the task's own Done:/Check: lines; dispatchToEngine(task, engine, worktreePath) spawns via RUNNER_PROFILE_DEFS and captures the report as plain data. Eliminate: hand-written dispatch prompts, and fleet NEVER gets its own state file — flight state is missions + worktrees + receipts. [endgame]
  **Verify:** node --test test/fleet.test.js
- **T2:** Staffing: pick claimable safe-lane tasks only (no denied tags), disjoint-file heuristic between concurrent picks, wrap each in mission start --verify (receipts for free), assign engines from the roster in commands/engine.js. [endgame]
  **Verify:** node --test test/fleet.test.js
- **T3:** Serial landing lane: conductor lands one arrival at a time, rebase-before-ship, conflict = pause + surface (never auto-resolve), terminal state merged-or-reaped per the land contract. [endgame]
  **Verify:** node --test test/fleet.test.js
- **T4:** The flight is watchable and receipted: atris mission run --fleet prints a live board (engine, task, state); every flight writes a receipt to atris/runs/; wire --fleet into mission run help + MAP.md. [endgame]
  **Verify:** node --test test/fleet.test.js && grep -q "\-\-fleet" commands/mission.js
- **T5:** Release 3.33.3: real-board fleet flight receipt on this repo, bump version, tag v3.33.3, CI publishes, npm view confirms, GitHub release + launch post drafted from the flight receipt. [endgame]
  **Verify:** node -e "process.exit(require('./package.json').version==='3.33.3'?0:1)"
- **T6:** RSI audit: read this endgame's halts, verify failures, and lessons. If the loop itself broke during this endgame (parser, reward, scorecard, verify wiring), fix it. If nothing broke, no-op. [endgame]
  **Verify:** npm test

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
