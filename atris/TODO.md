# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** autopilot-runner-agnostic
**Picked:** 2026-06-15 23:32
**Horizon:** the autopilot/run heartbeat is engine-agnostic like missions already are — a claude -p pricing change, model retirement, or runner swap is a config flag, not a code change or a silent overnight outage
**Source:** user-prompt (Agent SDK credit-pause email surfaced the exposed flank: run.js + autopilot.js hardcode `claude -p` with no `--model`, while mission.js already resolves runner+model)

## Backlog

- **T1a:** Create `lib/runner-command.js` — move `DEFAULT_CLAUDE_RUNNER_MODEL = 'opus'` (alias) + `resolveClaudeRunnerModel({model})` verbatim from commands/mission.js:1425-1432 (precedence: explicit model > ATRIS_CLAUDE_MODEL env > 'opus' alias), add `buildRunnerCommand({promptFile, allowedTools, model})` returning the shell-string form with `--model <resolved>` always injected; export all three. New `test/runner-command.test.js` asserts default resolves to the `opus` alias and never a versioned `claude-*` id (regression guard for retired-model-kills-loop-silently), env/explicit precedence, and that buildRunnerCommand always emits `--model`. Exit: lib + test exist, suite green. [execute]
  **Verify:** node --test test/runner-command.test.js
- **T1b:** Rewire `commands/mission.js` to consume the lib — delete the inline `DEFAULT_CLAUDE_RUNNER_MODEL` + `resolveClaudeRunnerModel` (1425-1432), import from `../lib/runner-command.js`, and KEEP `resolveClaudeRunnerModel` in `module.exports` (commands/mission.js:2631) so test/mission-model-resolution.test.js:6 stays green. No behavior change to spawnClaudeTick. Exit: mission.js holds no copy of the resolver; both test files pass. [execute]
  **Verify:** node --test test/mission-model-resolution.test.js test/runner-command.test.js
- **T2:** Replace the 5 hardcoded `claude -p "$(cat ...)"` literals in commands/autopilot.js (453, 1202, 2899, 3589) + commands/run.js (116) with `buildRunnerCommand(...)` — eliminate the raw string invocations [endgame]
  **Verify:** test -z "$(grep -nE 'claude -p \"\$\(cat' commands/autopilot.js commands/run.js)"
- **T3:** Every autopilot/run tick now spawns with a resolved `--model` alias, closing the latent retired-model-kills-loop-silently instance in the autopilot path (these spawns currently inherit the CLI's persisted selection) [endgame]
  **Verify:** node --test test/autopilot-runner-model.test.js
- **T4:** Make runner+model selectable on the autopilot/run surface (ATRIS_CLAUDE_MODEL env + optional flag) so a future claude -p change is a one-line switch, proving the engine-agnostic claim [endgame]
  **Verify:** node --test test/autopilot-runner-model.test.js
- **T5:** RSI audit: read this endgame's halts, verify failures, and lessons. If the loop itself broke during this endgame (parser, reward, scorecard, verify wiring), fix it. If nothing broke, no-op. [endgame]
  **Verify:** npm test

## In Progress

- **[CLI-237]** Mission XP: get better every tick: research one thing, improve the code, ship one verified change to review, write the lesson down [agent-xp]
  **Claimed by:** auto-improver
  **Verify:** npm test
- **[CLI-225]** build compile loop: execution records -> compile-to-code -> backtest -> gated promote (poetic parity, CLI-225)
  **Claimed by:** claude
- **[CLI-216]** Ship launch post: post linkedin-post.md, capture URL in journal, delete the file
  **Claimed by:** droid
- **[CLI-200]** Auto-improver: Recurring log pattern: Next tick will stop until a human looks at the error. [auto-improver]
  **Claimed by:** keshavrao

## Review

- **[CLI-240]** mission watch: --idle-every flag + idle alive-line test
- **[CLI-239]** atris2 mission runner: per-tick /atris2/turn via runAtris2Turn, --model passthrough for claude runner, codex contract verified [loop-proof]
  **Verify:** node --test test/mission-atris2-runner.test.js test/probe.test.js
- **[CLI-238]** mission liveness: heartbeat in status, mission watch command, member identity in tick prompt, auto-improver member v2 [loop-proof]
  **Verify:** node --test test/mission-heartbeat.test.js
- **[CLI-236]** tick receipts by layer: each autopilot tick records which layer it touched (identity, lessons, skills, commands, repo) [loop-proof]
  **Verify:** node --test test/mission-layer-receipts.test.js
- **[CLI-235]** boot impression test: assert session boot surfaces the active endgame verbatim and the selector prefers endgame tasks [loop-proof]
  **Verify:** node --test test/boot-impression.test.js
- **[CLI-234]** belief contradiction sweep: flag lessons.md entries contradicted by later scorecards and open dissolve tasks [loop-proof]
  **Verify:** node --test test/lesson-sweep.test.js
- **[CLI-233]** identity diff report: render how MEMBER.md/PERSONA.md changed across ticks from git history [loop-proof]
  **Verify:** node --test test/member-history.test.js
- **[CLI-232]** vision lineage trace: show endgame -> tasks -> commits as one chain [loop-proof]
  **Verify:** node --test test/commands.test.js
- **[CLI-231]** autopilot: isPhaseTimeoutError over-matches any err.signal — distinguish real ETIMEDOUT from OOM/external kills [cli]
- **[CLI-230]** probe: malformed terminal JSON resolves {} and reports tool call ok — surface as error instead [cli]
- **[CLI-229]** probe: fix false read-only claim (bash op runs arbitrary commands) + add connect timeout to /atris2/turn SSE request [cli]
- **[CLI-228]** test harness: pin ATRIS_AGENT_PROOF_ONLY=0 in spawned test envs — 25 phantom failures when agents run npm test (CLAUDECODE marker leaks) [cli]
- **[CLI-227]** compile: drop status to draft on every rebuild — recompile of active process bypassed the promote gate (compile.js:304); also stop --threshold backtest flag permanently mutating gate; atomic writeManifest [cli]
- **[CLI-226]** atris recap: turn task receipts into a plain-English report a customer can read [cli-ux]
- **[CLI-224]** task day header: review count inflated by failed+unreviewed-done; show lane truth [tasks]
- **[CLI-223]** skill audit: no-xml-tags flags placeholders inside code blocks (9 skills false-FAIL) [cli-ux]
- **[CLI-222]** Revalidate 8 stale feature packs: heal drifted line refs, rerun rubric checks, bump last_compiled [wiki]
- **[CLI-221]** Recompile stale wiki pages that feed agent boot (systems/atris-cli, overview brief, concepts) [wiki]
- **[CLI-220]** Heal workspace drift: 82 stale MAP.md refs + archive 33 old journals via atris clean [maintenance]
- **[CLI-219]** task day: collapse failed tasks older than 7 days into one summary line [tasks]
- **[CLI-218]** Boot panel reads task projection truth (backlog/active/review) instead of stale TODO.md parse [cli-ux]
- **[CLI-217]** Policy hint false positive: VERIFY_COMMAND_PATTERN misses grep/diff-style verifiers [rsi]
- **[CLI-215]** Mine 139 career XP receipts + 317 episodes + 12 scorecards into policy lessons; prove one before/after agent behavior change with receipts [rsi]
- **[CLI-214]** Refresh business goals source of truth: live MRR/customer snapshot into wiki goals page, replacing historical 0.6-confidence numbers [business]
- **[CLI-213]** Review lane self-drain cadence: wire review-lane-run into always-on loop; receipt proves queue drains agent-side to certified with zero human turns [mission]
- **[CLI-212]** Dogfood two parallel mission start --worktree loops; fix cross-worktree mission status rollup friction [mission]
- **[CLI-199]** Auto-improver: Recurring log pattern: check: `node bin/atris.js loop --dry-run --json` now reports # stale... [auto-improver]

## Blocked

- **[CLI-162]** Refresh control packets after b20be master advance [review]
- **[CLI-161]** Refresh certified review acceptance packet after BCK-339 [review]
- **[CLI-160]** Refresh certified review acceptance packet after BCK-334 [review]
- **[CLI-89]** Dogfood business computer lifecycle with proof-backed AgentXP loop [computer]
- **[CLI-88]** AgentXP Mode first rep: complete one proof-backed customer-motion mission [agent-xp]
- **[CLI-62]** Emit Career XP game event on accepted proof [career-xp]
- **[CLI-52]** Send the following message to Pranav: 'Hey Pranav, here are some great vegan restaurant recommendations in San Francisco [agent]

## Completed

- **[CLI-211]** mission start --worktree: isolated checkout with clean baseline [mission]
  **Verify:** node --test test/mission-worktree-start.test.js
- **[CLI-210]** Evidence-aware review queue and risky-first accept-group spot-check [task-plane]
  **Verify:** node --test test/task-receipt-evidence.test.js
- **[CLI-209]** Surface validated receipt evidence in review queue and accept [task-plane]
  **Verify:** node --test test/task-receipt-evidence.test.js
- **[CLI-208]** Stop receipts and completion gate visibility in mission status [mission]
  **Verify:** node --test test/mission-stop-receipt.test.js
- **[CLI-207]** Prune mission baseline sidecar on close with audit summary [mission]
  **Verify:** node --test test/mission-baseline-lifecycle.test.js
- **[CLI-206]** Gate mission complete behind passing verifier proof [mission]
  **Verify:** node --test test/mission-complete-guard.test.js
- **[CLI-205]** Baseline mission receipts against mission-start snapshot [mission]
  **Verify:** node --test test/mission-worktree-baseline.test.js
- **[CLI-204]** Wiki loop: recompile stale jack-dorsey page [wiki]
  **Verify:** git diff --check

(194 older completed tasks archived in `atris task list --status done` and `atris task events`.)
