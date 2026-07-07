# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-915]** wish review latest resolves to an older open wish instead of the newest wish: reviewing 'latest' tonight hit yesterday's wish while today's decomposed wish existed; pin down the intended meaning of latest and add a test [wish]
- **[CLI-914]** get good results instead of generating from scratch [wish]
- **[CLI-913]** create deterministic code scripts for tasks llms are often asked to do, so a cheaper llm can just run the script [wish]
- **[CLI-912]** AgentXP Mode first rep: complete one proof-backed useful mission [agent-xp]

## In Progress

- **[CLI-911]** member wake: warm human boot output (gm experience) [cli]
  **Claimed by:** devin
- **[CLI-910]** Make loops audit self-improving green [loops]
  **Claimed by:** auto-improver
  **Verify:** node bin/atris.js loops audit
- **[CLI-891]** Engine registry v2: .atris/state/engines.json (tier, roles, fallback order, health) + atris engine resolve <role> + engine list --json contract + mission --budget quick|long|deep tiers
  **Claimed by:** codex-engine-registry

## Review

(Empty)

## Blocked

- **[CLI-908]** i could see how this process would lead me to creating a viral hit on ableton [wish]
- **[CLI-907]** Wishes come true while everyone sleeps: queued wishes dispatch from the hourly loop instead of waiting for a live session, so the operator can wish at midnight and wake to landed work
- **[CLI-905]** Wish stops guessing wrong on big wishes: multi-part wishes get split or asked about instead of blind-delegated, budgets and proof come from the work not word-matching, and questions read like a person wrote them, so wishes can be trusted with anything
- **[CLI-904]** Flights verify in seconds: a fast real-behavior test tier becomes the default gate while the full suite moves to a background check, so every build lands minutes sooner without trusting mocks
- **[CLI-903]** quick tests with more real results so flights verify in seconds not minutes [wish]
- **[CLI-902]** One command proves the whole factory works: a golden-path drill runs wish to task to mission to landed merge against a sandbox repo and reports pass or the exact broken stage, so process breakage is caught in minutes not discovered mid-flight
- **[CLI-901]** Every plan the orchestrator hands a coder becomes a graded record: the brief, what came back, and the verdict live together, so plan quality is measured and improves instead of evaporating after each dispatch
- **[CLI-900]** the orb orchestrator always gives great plans to the executor coder and all the meta thinking is logged and organized to improve our thinking over time [wish]
- **[CLI-899]** Live team stream: one command shows what every agent is doing right now in plain rolling lines, per agent or whole team, so the operator understands everything at a glance instead of digging through logs
- **[CLI-898]** i could understand everything so fast in a stream for each agent or the whole team and that it was connected to GM mode so easily and the gm mode in project obelisk though it may seem hard [wish]
- **[CLI-897]** Wish speaks like a person: restates your words back, asks specific questions, names which wish it is granting, and never mangles grammar, so operators trust it on the first try
- **[CLI-896]** my roadmap till agi was ready [wish]

(33 older blocked tasks archived in `atris task list --status failed` and `atris task events`.)

## Completed

- **[CLI-916]** wish review latest resolves to an older open wish instead of the newest wish: reviewing latest tonight hit yesterday's wish while today's decomposed wish existed; pin down the intended meaning of latest and add a test [wish]
  **Verify:** node --test test/wish.test.js
- **[CLI-909]** Add atris loops init audit tick commands [cli]
  **Verify:** node --test test/loops.test.js
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

(440 older completed tasks archived in `atris task list --status done` and `atris task events`.)
