# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-883]** one-time ghost dirt during worktree ship: verify step found mission.js/autopilot.js carrying all three seed-experiment payloads unstaged, unreproducible across 11 isolated re-runs of the same suite; suspect late writes from a just-exited codex yolo child. consider: ship should snapshot git status before verify and diff after, and print the delta; also consider ps-check for live children of dispatched engines before staging. evidence in atris/features/own-yardstick-bench/implementation-notes-*.md session 2026-07-05 [worktree]
- **[CLI-882]** worktree start cuts from stale origin/master when nobody fetched: git fetch origin (or --no-fetch flag) before resolving the base ref in atris worktree start. found live 2026-07-05 when a seed worktree missed two just-merged PRs and blocked a codex build. Files: commands/worktree.js [worktree]

## In Progress

- **[CLI-884]** agents-v1: 25-item agent benchmark so Keshav can score any company's coding agent - pack harness + engine adapters + honesty rule (null fails, solution passes). design frozen at atris/features/agents-bench/design.md. Files: lib/bench/engines.js atris/benchmarks/agents-v1/ [bench]
  **Claimed by:** fable
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

- **[CLI-824]** Pings to busy members go unread and steering fails silently: member ping only lands on missions, but task-loop agents never tick them. Make ping also drop the note into the member's claimed task dialogue, which every loop reads each step. Done: a ping to a member with no ticking mission reaches their task dialogue, regression test proves both lanes deliver. [voice]

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

- **[CLI-881]** Fleet builds in a repo whose primary checkout sits on a long-lived feature branch keep pausing at rebase_conflict: worktree start cuts the build branch from the launcher HEAD, so rebase-before-ship replays all the feature branch commits onto master (live: three backend pauses tonight on members.py). Done: fleet and engine dispatch cut their worktrees from origin/master by default (checkoutBase), keeping launcher-HEAD only when --base is explicit; ship target already defaults to master from CLI-864. Check: node --test test/fleet.test.js
  **Verify:** node --test test/fleet.test.js test/engine.test.js test/engine-dispatch.test.js
- **[CLI-880]** reap contract regression: the janitor grace patch quietly disabled salvage-then-remove, so dirty residue piled up as kept limbo and salvageWorktree was dead code; restored the contract and made npm test green in fresh checkouts
- **[CLI-879]** Protected tasks cannot be flagged after creation: the auto-accept policy skips tasks tagged needs-human, but tags are only settable at task creation, so an open task that becomes an owner decision (live case: BCK-1248 EFS mount) cannot be marked and fleets keep restaffing it. Done: atris task tag <id> --add <tag> [--remove <tag>] updates tags on an existing task with an event logged, and sweep plus fleet staffing respect a needs-human tag added this way. Check: node --test test/task-tag.test.js
- **[CLI-878]** silent autoland block: ready --verify accepts any command and promises autoland will land it, but non-allowlisted verifiers block certification with no reason shown anywhere; warn at ready time and name blocked rows plus reasons in autoland tick and task reviews output
- **[CLI-877]** lock the business story as code: an end-to-end regression test that runs the whole golden path (init --yes, delegate, claim, ready, autoland) in a fresh temp project so packaging can never silently regress
- **[CLI-876]** janitor reaps brand-new clean worktrees while an engine is still working in them (live hit: atris-fast job got ENOENT mid-run); add a grace period so worktrees younger than an hour or with an active claim are never reaped
- **[CLI-875]** lessons ledger says 36 unresolved but 3 are already fixed in code; mark those resolved with the file:line evidence so the rot counter tells the truth
- **[CLI-874]** outbound artifact gate exists but nothing calls it: html and visual artifacts can still reach customers unrendered; wire scripts/outbound-artifact-gate.js into every send path (email, imessage, slack)

(460 older completed tasks archived in `atris task list --status done` and `atris task events`.)
