# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-883]** one-time ghost dirt during worktree ship: verify step found mission.js/autopilot.js carrying all three seed-experiment payloads unstaged, unreproducible across 11 isolated re-runs of the same suite; suspect late writes from a just-exited codex yolo child. consider: ship should snapshot git status before verify and diff after, and print the delta; also consider ps-check for live children of dispatched engines before staging. evidence in atris/features/own-yardstick-bench/implementation-notes-*.md session 2026-07-05 [worktree]

## In Progress

- **[CLI-854]** Mission XP: Decide and start the next useful mission after: Drive Missions Verifier Mission Room with harness-engineer: turn "Make self-driving stick. Bug: atris drive parks no-verifier missions via 'mission stop --pause' but mission doctor still flags paused..." into one visible goal, task spine, proof receipt, and next action. [agent-xp]
  **Claimed by:** harness-engineer
- **[CLI-849]** Mission XP: Drive Missions Verifier Mission Room with harness-engineer: turn "Make self-driving stick. Bug: atris drive parks no-verifier missions via 'mission stop --pause' but mission doctor still flags paused..." into one visible goal, task spine, proof receipt, and next action. [agent-xp]
  **Claimed by:** harness-engineer
  **Verify:** node /Users/keshavrao/arena/atris-cli/bin/atris.js drive --dry-run --json | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['disengagements']<=1 and d['fixed']==0, d; print('clean sweep')"
- **[CLI-798]** Golden path papercut: task current should choose pass 1a before later golden-path pass steps or explain ordering [golden-path]
  **Claimed by:** fable
- **[CLI-775]** Mission XP: Decide and start the next useful mission after: Ship npm auto-update for packaged installs (git checkouts stay manual) [agent-xp]
  **Claimed by:** auto-improver
- **[CLI-773]** Mission XP: Decide and start the next useful mission after: make this the standard for every atris mission and validate a bit for 5 minutes until 100% [agent-xp]
  **Claimed by:** auto-improver
- **[CLI-771]** Mission XP: Decide and start the next useful mission after: this exactly thing i want to see 3 or 4 goals done towards a novel mission that actually is validated and i can understand [agent-xp]
  **Claimed by:** auto-improver
- **[CLI-744]** Mission XP: Decide and start the next useful mission after: Make mission-run continuation choose and start a concrete follow-up mission instead of marking choose_next_mission work ready on git diff --check [agent-xp]
  **Claimed by:** mission-lead
- **[CLI-742]** Mission XP: Decide and start the next useful mission after: Make atris mission run preflight messy operator input through Mission Room before visible-goal ack, so shower and overnight requests become crisp goals, task spines, receipts, and next actions instead of copying raw messy text into the native goal [agent-xp]
  **Claimed by:** mission-lead
- **[CLI-573]** Mission XP: work overnight and see where we can self improve. goal after goal nonstop 6 hours [agent-xp]
  **Claimed by:** auto-improver

## Review

(Empty)

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

- **[CLI-890]** Golden path papercut: starter task claim prints verifier placeholders that can miss autoland, so the first self-landed task stalls. In /tmp/atris-golden-landed-picMA5, TOY-1 used the printed ready shape with test -f FIRST_PROOF.md; task ready passed but warned autoland could not rerun that verifier, and autoland tick landed nothing. Done: claim or ready guidance gives a self-land-safe verifier path, or the ready output does not promise autoland when the verifier is outside the allowlist, with regression and packed receipt. [golden-path]
  **Verify:** node --test --test-name-pattern=autoland-aware test/commands.test.js
- **[CLI-889]** Golden path papercut: landed fresh-init path reaches a starter task but never prints the first mission command. In /tmp/atris-golden-landed-picMA5, following atris -> atris init -> first-use printed TOY-1 claim, not a mission start path, so the first mission still required invented operator knowledge. Done: the fresh printed path includes a copy-paste first mission start/tick/complete recipe or explicitly explains task-first vs mission-first ordering, with packed-install regression. [golden-path]
  **Verify:** node --test test/init-non-interactive.test.js
- **[CLI-888]** Golden path papercut: mission start with a verifier prints a tick command without --verify, so following the CLI records a no-work tick. In the patched packed walk, mission start printed Next: atris mission tick <id>; running it recorded 'no verifier was run' even though the mission verifier was test -f FIRST_PROOF.md. Done: mission start prints the verification-preserving next command when a verifier exists, with regression. [golden-path]
  **Verify:** node --test --test-name-pattern=verifier-preserving test/mission-status.test.js
- **[CLI-887]** Golden path papercut: after the first printed task claim, atris task claim only says claimed and gives no next command. In the packed patched walk, Next printed atris task claim TOY-1 --as keshavrao; following it exited 0 and printed only 'claimed TOY-1 as keshavrao', leaving a zero-knowledge user without the ready/autoland path. Done: task claim output names the next proof command or points to the zero-human golden path for the claimed task, with regression. [golden-path]
  **Verify:** node --test --test-name-pattern=claims test/commands.test.js
- **[CLI-886]** Golden path papercut: packed master atris init still ends in agent MAP bootstrap instead of a human next command. In a clean HOME + npm-pack install from origin/master, the printed path was atris -> atris init, then init ended with BOOTSTRAP REQUIRED and 'Read atris/atris.md, then generate a complete atris/MAP.md' before any first mission or self-landed task. Done: fresh init in a toy repo ends with one human-runnable next command toward first mission/task, not agent-only MAP homework, with pack/install receipt or regression. [golden-path]
  **Verify:** node --test test/init-non-interactive.test.js
- **[CLI-885]** PR #256 (result-sentence-gate) landed with 7 failing suite tests: 4 confirmed in task accept landing prints (task plan/ready Plan+Result traces, accept concise human landing, accept receipt next-mission route, accept --public AgentXP landing) plus 3 more in the same family. commands/task.js +87 lines and lib/autoland.js +159 changed without updating expectations. suite red on master since 3e0f154; verify with: node --test test/task-plan-result.test.js test/task-result-gate.test.js [regression]
- **[CLI-884]** agents-v1: 25-item agent benchmark so Keshav can score any company's coding agent - pack harness + engine adapters + honesty rule (null fails, solution passes). design frozen at atris/features/agents-bench/design.md. Files: lib/bench/engines.js atris/benchmarks/agents-v1/ [bench]
- **[CLI-882]** worktree start cuts from stale origin/master when nobody fetched: git fetch origin (or --no-fetch flag) before resolving the base ref in atris worktree start. found live 2026-07-05 when a seed worktree missed two just-merged PRs and blocked a codex build. Files: commands/worktree.js [worktree]

(463 older completed tasks archived in `atris task list --status done` and `atris task events`.)
