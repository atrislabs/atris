# Autopilot and loops

Autopilot and its legacy loop, the run front door, the pulse heartbeat, auto-advance and the wiki upkeep loop. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "autopilotAtris|buildAutopilotGlassLog|writeAutopilotGlassLog|glassLogPath" commands/autopilot.js test/autopilot-glass-logging.test.js  # Autopilot command + glass phase receipt (plan -> review -> action -> result -> proof)
rg "loopAtris|buildReport|showLoopHelp|loop --help|nextMoves|readEndgameMove|todoKeepsEndgameActive" bin/atris.js commands/loop.js commands/loop-front.js lib/next-moves.js test/commands-1.test.js test/moves.test.js # Wiki upkeep loop, ranked next moves, stale compiled-endgame suppression, and non-mutating help
rg "loopsCommand|initLoops|auditLoops|tickLoops|self-improve|templates/loops" bin/atris.js commands/loops.js templates/loops test/loops.test.js # Self-improving project loops: init scaffold, structural audit, tick protocol, self-improve alias, plus legacy board/start/stop
rg "runAtris|runMissionFront|applyRunnerFlags|runTalkOnly" commands/run.js commands/run-front.js bin/atris.js test/dogfood-hours-lingo.test.js test/front-doors.test.js  # Run command: empty-folder bare atris run talks first-talk like bare atris and skips applyRunnerFlags so engine registry seed cannot mint .atris/state/engines.json; --legacy stays the old loop
rg "recoverCommand|classifyRecovery|RECOVERY_CATALOG|missionLockRecords|HUMAN_BLOCKING_REASONS" commands/recover.js lib/self-drive.js lib/loop-doctor.js test/recover.test.js  # Report-only blocked/paused mission recovery catalog; --apply delegates only to mission tick resume, verifier retry, and dead-lock reaping, emits a recovery receipt, and never changes human-blocking holds
- Headless autopilot: `commands/autopilot-front.js:236` refuses bare headless invoke and `--json`/`--once` unless `--yes` or `--auto`; unbound scratch `--yes`/`--auto` still refuse via `isUnboundScratchFolder` before `writeState`; `autopilot stop` kills `child_pid` then the wrapper. Regression: `test/dogfood-p0-safety.test.js` (`32:`), `test/dogfood-pass4.test.js` (`30:`), and `test/dogfood-spaceship-scratch.test.js`.
```

## Feature: Wiki Upkeep Loop (`atris loop wiki`)

**Purpose:** Keep `atris/wiki/` alive after ingest by refreshing health, finding stale/orphan pages, and proposing the next ingest without touching cloud sync

- **Entry points:** `bin/atris.js` (`loop` help + routing), `commands/loop-front.js:317` (`loopFront` sends `loop wiki` to `loopAtris`), `commands/wiki.js` (`wiki loop` alias)
- **Handlers:** `commands/loop.js` (report builder + STATUS/log refresh), `lib/wiki.js` (stale/orphan/suggestion helpers)
- **Help:** `bin/atris.js:1136-1147` (`showLoopHelp`) prints usage without ensuring wiki scaffold or writing status/log files
- **Dispatch:** `bin/atris.js:3095-3093` routes `loop --help`, `loop -h`, and `loop help` to `showLoopHelp` before `loopFront`
- **How it works:**
- `atris loop wiki` ensures the wiki scaffold exists, analyzes current pages, then rewrites `atris/wiki/STATUS.md`
- appends a deterministic `LOOP` entry to `atris/wiki/log.md`
- flags stale pages by comparing source mtimes to `last_compiled`
- flags orphan pages that are neither indexed nor linked from other wiki pages
- suggests a small next-ingest queue from high-value repo files not yet represented in wiki page frontmatter
- supports `--dry-run`, `--json`, and `--limit=N`
- does not auto-push; the local wiki stays the source of truth until `atris push --only wiki`
- **Regression:** `test/commands-8.test.js:324-338` covers `loop --help` without Wiki Loop output or temp `atris/`/`.atris` creation
- **Value:** Turns the wiki into a maintained memory layer instead of a write-once folder

**Search:** `rg "loopAtris|buildReport|showLoopHelp|loop --help|findStaleWikiPages|findWikiOrphans|findSuggestedSources" bin/atris.js commands/loop.js lib/wiki.js test/commands-1.test.js`

## Feature: Front doors (`atris run` / `atris autopilot`)

**Purpose:** Both commands are thin front doors over the mission runtime (2026-07-01). `atris run` = one bounded pursuit: start a mission from the objective or resume the most logical runnable mission, tick it, complete on pass, exit. `atris autopilot` = keep the workspace moving: each leg picks a runnable mission, else a member choosing useful work, else a self-chosen mission, and loops until stopped.

- **Run front door:** `commands/run-front.js` (`runMissionFront`, `pickRunnableMission`: running > planning, newest first; skips continuation placeholders and session-bound runners: only claude/atris2 are headless-drivable). Bare `atris run` with no objective talks the same first-minute / desk next as bare `atris` and does not resume a hours / keep-working mission. Empty-folder first-talk does not mint `.atris/` or `engines.json`. Starting a long run needs an objective or `--yes`. Headless never prompts. `isHoursMission` names overnight / hours work.
- **Autopilot front door:** `commands/autopilot-front.js` (`autopilotFront` main loop; `inviteLines` for the no-`--yes` talk; `legPlan` selection: member legs force `--runner atris2`; `driveLeg` records `child_pid` and polls the stop file every 2s so `atris autopilot stop` kills the running leg, not only the wrapper; any leg under 30s counts toward the 5-in-a-row no-progress/failure halt). Bare invoke / `--json` / `--once` exits 2 unless `--yes` or `--auto` is passed. Bare talk is two spoken lines (`I can keep working until you stop` / `next: atris autopilot --yes`), not a usage wall. `--help` stays usage. Unbound scratch `--yes`/`--auto` still exit 2 via `isUnboundScratchFolder` before `writeState` (no mission, no `.atris/` mint). A folder that already has `atris/` can still start.
- **Goal-selection rank:** `commands/mission.js` `missionGoalSelectionRank`: fresh goal selection in `selectAtrisGoalMission`/`selectCodexGoalMission` ranks running < planning < ready before recency, so review-parked missions never outrank moving work
- **Native Codex goal runner boundary:** `commands/mission.js` `selectCodexGoalMission` selects only `codex_goal` runners, matching the fail-closed `ackMissionGoal` contract; `caller_session` and `current_agent` missions stay executable through their own loop without emitting an impossible native-goal create/ack request. Regression: `test/mission-status.test.js` (`mission goal skips caller-session missions that cannot use the native Codex ack`).
- **Stop/status:** `atris autopilot stop` / `atris autopilot status`; state in `.atris/state/autopilot.json`, stop marker `.atris/state/autopilot.stop`
- **Dispatch:** `bin/atris.js` `command === 'run'` and `command === 'autopilot'` branches: default routes to the fronts, `--legacy` routes to the old loops below; `applyRunnerFlags` always validates `--engine` / `--runner-profile` (unknown still exits 1); run and autopilot skip only the engine-registry seed on first-talk and unbound scratch so that seed cannot mint `.atris/state`
- **Regression:** `test/front-doors.test.js`; `test/dogfood-hours-lingo.test.js` (`empty-folder atris run talks first-talk and does not mint engines.json`)

**Search:** `rg "runMissionFront|autopilotFront|legPlan" commands/run-front.js commands/autopilot-front.js`

## Feature: Autopilot legacy loop (`atris autopilot --legacy`)

**Purpose:** Suggest → justify → execute loop. Scans workspace for the most important thing to do, explains why, then runs plan → do → review. Reached only via `--legacy`; its exports (`writeLesson`, `runTaskOnce`, `readEndgameState`, `getVerifyCommand`) are still consumed by `commands/lesson.js`, `commands/experiments.js`, and `bin/atris.js`.

- **Entry point:** `commands/autopilot.js:3246` (autopilotAtris function)
- **Reward config:** `lib/reward-config.js`: frozen `REWARD_CONFIG` object + `REWARD_CHECKSUM` (SHA-256 of `JSON.stringify(REWARD_CONFIG) + computeTickReward.toString()` at ship time). The loop cannot edit its own judge.
- **Reward computer:** `commands/autopilot.js:2274` (`computeTickReward`): computes per-tick reward score from `REWARD_CONFIG` constants (commit +1, npm test +2, verify +3, validator clean +1, halt -3) and only awards verify points when verify actually ran
- **Tick registry writer:** `commands/autopilot.js:1200` (`recordTickCommit`): persists `{hash, verifyCmd, slug, timestamp}` to `atris/tick-registry.json` after each successful tick
- **Regression checker:** `commands/autopilot.js:1216` (`regressionCheck`): reads last 10 tick-registry entries, re-runs verify at original commit via git worktree, writes lesson + -5 penalty on failure
- **Judge integrity guard:** `commands/autopilot.js:1410` (`verifyJudgeIntegrity`): SHA-256 checksums `JSON.stringify(REWARD_CONFIG) + computeTickReward.toString()` against `REWARD_CHECKSUM`; called at top of `runTaskOnce`; halts tick + writes lesson on mismatch
- **Lesson gate tests:** `test/lesson-gate.test.js` covers unresolved/resolved lesson filtering and detector-backed lesson metadata before horizon selection.
- **Heartbeat writer:** `commands/autopilot.js:2318` (`appendTickSummary`): appends a plain-language tick summary block to today's journal `## Notes`; includes reward score if present; idle ticks include the literal `0 tasks in 0s` so `getIdleTickCount` can still count them
- **Suggestion engine:** `commands/autopilot.js:116` (suggestNextTask function, async)
  - Checks 8 signal types in priority order:
  - 0. Endgame tasks (current horizon: highest priority)
  - 1. Resume interrupted in-progress tasks
  - 2. Stale wiki pages (source changed since last_compiled)
  - 3. Abandoned tasks (claimed >3 days, never finished)
  - 4. Broken MAP.md references (unhealable by auto-healer)
  - 5. Backlog tasks from TODO.md
  - 6. Unprocessed inbox items from journal
  - 7. Periodic review (MAP.md stale >7 days)
  - Imagined fallback: when no reactive signals fire, calls `proposeCandidateHorizons(cwd)`, picks the highest-confidence candidate, and returns it as `kind: 'imagined'` (priority 99). Throws → returns `null` so `"nothing to do."` still works.
- **Prompt builder:** `commands/autopilot.js:691` (buildPrompt function; SHARED_CHECKOUT_GIT_CONTRACT at :500 injects the worktree/destructive-git rule into default + self-heal do prompts): adapts prompts per task kind, including strategy-specific benchmark runs
- **Autopilot glass log:** `commands/autopilot.js:715` (`buildAutopilotGlassLog`, `writeAutopilotGlassLog`): successful ticks write `atris/logs/autopilot/<timestamp>-<task>.md` with Plan, Plan Review, Action, Result, and Proof sections. Regression: `test/autopilot-glass-logging.test.js`
- **Single-task runner:** `commands/autopilot.js:2008` (`runTaskOnce`): guards against missing Verify fields (halts tick), runs judge integrity check, then plan/do/review, always runs verify command (decoupled from review proxy), success requires verify ran AND passed, returns `verifyCmd`, `verifyRan`, `verifyPass`, and `glassLogPath`
- **Verify executor helper:** `commands/autopilot.js:1264-1276` (`getVerifyCommand`): reads TODO.md across backlog/in-progress/completed tasks, extracts the verify field; returns `{ cmd, explicit }`: no default, tasks without Verify halt
- **Lesson writer helper:** `commands/autopilot.js:1164-1188` (`writeLesson`): appends lesson line to atris/lessons.md in format `- **[YYYY-MM-DD] slug**: pass/fail: explanation`
- **Phase executor:** `commands/autopilot.js:490` (executePhaseDetailed function): runs `buildRunnerCommand()` (default Claude-compatible `claude -p`, configurable with `ATRIS_RUNNER_*` env or runner flags)
- **Approval gate:** `commands/autopilot.js:412` (askApproval function): enter/skip/quit
- **Human freshness check:** `commands/autopilot.js:436` (`askHuman`): interactive readline prompt "Is [task] still relevant? y/n"; returns `{ fresh: boolean }`; used in interactive mode when `isStillTrue` returns `unverified`
- **Idle-tick helper:** `commands/autopilot.js:2606` (`getIdleTickCount`): counts consecutive `0 tasks in 0s` markers at the bottom of today's journal `## Notes`
- **Recent-signals helper:** `commands/autopilot.js:2641` (`getRecentSignals`): pure read-only `{ recentCommits, wikiHealth, recentLessons }` from `git log -20`, `atris/wiki/STATUS.md`, last 10 lines of `atris/lessons.md`
- **Lesson-resolved checker:** `commands/autopilot.js:3090` (`isLessonResolved`): parses a lesson line for file paths and slug keywords, greps named files via `execFileSync`; returns true if bug pattern is gone (no keyword matches in any named file)
- **Candidate-horizons helper:** `commands/autopilot.js:3296` (`proposeCandidateHorizons`): async; combines `getIdleTickCount` + `getRecentSignals`, uses the shared runner command with a strict-JSON prompt, returns `[{ title, confidence, rationale }]` (at least 1 valid entry after filtering shipped/resolved lessons); tags resolved fail lessons `[resolved]` in lessons.md and drops matching pass lessons as already shipped
- **Scoring helper:** `commands/autopilot.js:2691` (`scoreEndgameCandidates`): reads last 10 scorecards, infers horizon type from slug prefix, calculates mean reward per type, scores candidates by expected value; adaptive explore rate (20%-50%) based on last-5 type diversity, difficulty floor filters easy-win types (>80% success + mean reward >5); called during horizon picking (line 244) to weight candidates by historical reward
- **Task age helper:** `commands/autopilot.js:3933` (`getTaskAgeDays`): computes age in days: endgame tasks use `Picked:` date, in-progress tasks parse `Claimed by:` timestamp, fallback 0.
- **Staleness gate:** `commands/autopilot.js:3962` (`isStillTrue`): takes `{ title, age, source }` + cwd; returns `actionable` (≤7d or grep+git confirm), `unverified` (grep hits but no recent git activity), or `stale` (source missing or no grep hits). Mechanical verification only: no model calls.
- **Model freshness check:** `commands/autopilot.js:4031` (`askModel`): called when `isStillTrue` returns `unverified`; uses the shared runner command with codebase search tools to ask "Is this task still relevant?"; parses YES/NO + reasoning from output; returns `{ fresh: boolean, reasoning: string }`; 60s timeout, conservative false on failure.
- **Staleness wiring:** `commands/autopilot.js:116` (suggestNextTask staleness gate): after sorting suggestions, filters via `isStillTrue`; in auto mode, `unverified` items escalate to `askModel`; in interactive mode, prompts human via `askHuman`; skips stale/not-fresh into `staleSkipped` array; logs to journal `## Notes`.
- **Flags:** `--auto` (no approval), `--iterations=N`, `--verbose`, `--dry-run`, `--runner-profile NAME`, `--runner-bin PATH`, `--runner-template CMD`, `--runner-model MODEL`
- **Value:** Always knows what to do next and why; now learns from past endgame outcomes (80/20 exploit/explore); also exposes a reusable single-run path for Endstate harnessing

**Search:** `rg "autopilotAtris|suggestNextTask" commands/autopilot.js`

## Feature: Autonomous Run Loop (`atris run`)

**Purpose:** Auto-chain plan → do → review cycles autonomously using the shared runner command (`ATRIS_RUNNER_BIN`, `ATRIS_RUNNER_COMMAND_TEMPLATE`, `ATRIS_RUNNER_MODEL`; legacy `ATRIS_CLAUDE_*` aliases still work; default Claude-compatible command)

- **Entry point:** `commands/run.js:373-639` (runAtris function)
- **Prompt builder:** `commands/run.js:120-213` (buildRunPrompt function): generates phase-specific prompts (plan/do/review) with full context file paths
- **Phase executor:** `commands/run.js:218-262` (executePhase function): runs `buildRunnerCommand()` with prompt, executes via spawnSync in a detached process group, sweeps the configured runner tree on timeout/kill, and handles output
- **Glass run logs:** `commands/run.js:31-37` (getRunLogDir, getRunLogPath, writePhaseToRunLog): persists plan/do/review phase reasoning to `atris/logs/runs/YYYY-MM-DD-<stamp>-cycle-N.md` as inspectable material; failed phases also logged as ERROR sections
- **Run log browser:** `commands/run.js:651-737` (listRunLogs function): `atris run logs [--tail N] [--cat FILE] [--json]` subcommand for browsing glass run logs
- **Run log pruning:** `commands/run.js:745-789` (pruneRunLogs function): `atris run prune-logs [--keep N] [--dry-run]` subcommand for cleaning up old run logs
- **Run log search:** `commands/run.js:798-885` (searchRunLogs function): `atris run search <keyword> [--phase P] [--limit N]` subcommand for searching phase reasoning
- **Run log stats:** `commands/run.js:890-941` (statsRunLogs function): `atris run stats` subcommand showing phase counts and avg durations
- **Run log export:** `commands/run.js:948-992` (exportRunLogs function): `atris run export [--out FILE]` subcommand for JSON bundle export
- **Run log diff:** `commands/run.js:995-1070` (diffRunLogs function): `atris run diff <file1> <file2>` subcommand for comparing two run logs
- **Work detector:** `commands/run.js:304-306` (hasWork function): checks backlog tasks and inbox items to decide if loop should continue
- **Journal logger:** `commands/run.js:340-368` (logRunCompletion function): appends run summary (cycles, duration, per-phase timings) to journal ## Notes
- **Phase timing:** `commands/run.js:261-262,268`: collects `{plan, do, review}` ms per cycle, stored in `cycleTimings` array
- **Summary table:** `commands/run.js:438` (cycleTimings forEach): per-cycle phase duration table
- **Post-cycle clean:** `commands/run.js:559` (cleanAtris call): self-heal MAP.md refs
- **Post-cycle push:** `commands/run.js:393` (execSync git push): disabled with `--no-push`
- **Routing:** `bin/atris.js:120-138` (command dispatch + flag parsing)
- **Help text:** `bin/atris.js:501` (showHelpShort first-minute doors) · `bin/atris.js:786` (showHelp --all/--json)
- **Known commands:** `lib/known-commands.js:3` (knownCommands array)
- **Constants:** `DEFAULT_MAX_CYCLES = 5`, `PHASE_TIMEOUT = 600000` (10 min per phase)
- **Flags:**
  - `--once`: Single plan→do→review cycle
  - `--verbose` / `-v`: Show configured runner output (stdio: inherit)
  - `--dry-run`: Preview context without executing
  - `--cycles=N`: Max cycles (default: 5)
  - `--timeout=N`: Phase timeout in seconds (default: 600)
  - `--runner-bin PATH`: Runner binary for this run
  - `--runner-template CMD`: Runner command template for this run
  - `--runner-model MODEL`: Runner model for this run
  - `--runner-profile NAME` - Runner profile for this run (currently `atris-fast` / `atris2-fast` / `atris-2-fast` / `hermes` / `hermes-agent`)
  - `--push`: Auto-push after each cycle (default: true)
  - `--no-push`: Skip auto-push after each cycle
- **Flow:**
  1. Validate atris/ folder + configured runner binary exist
  2. Build context paths (MAP, TODO, PERSONA, lessons, journal)
  3. Loop up to N cycles:
     - Check `hasWork()`: stop if inbox + backlog empty
     - PLAN phase: navigator creates tasks from inbox
     - DO phase: executor builds first backlog task
     - REVIEW phase: validator verifies + cleans up
  4. Log run stats to journal
- **Dependencies:** `lib/journal.js` (log paths), `lib/todo.js` (parseTodo)
- **Value:** Fully autonomous work loop: no human in the loop between cycles

**Search:** `rg "runAtris|getRunLogDir|getRunLogPath|writePhaseToRunLog|listRunLogs" commands/run.js`

## Feature: Pulse Heartbeat (`atris pulse`)

**Purpose:** The durable overnight self-improvement heartbeat for atris-cli itself. Unlike `/loop` (Claude Code CronCreate: dies when Claude Code closes) this installs a macOS LaunchAgent that fires regardless, retains keychain-backed subscription auth, runs the existing mission engine, verifies, and writes a pulse receipt + reward scorecard so the loop compounds without a human turning the crank.

- **Pure core:** `lib/pulse.js`: receipts (`buildPulseReceipt`, `buildInterruptedPulseReceipt`), reward gating (`scoreTick`, `shouldWriteScorecard`), ghost/stale detection (`findOrphanStarts`, `detectStaleTick`), summary (`summarizePulse`), cadence normalization (`normalizeCronCadence`: `13m` -> `*/13 * * * *`), LaunchAgent generation (`buildLaunchAgentPlist`) and tick-script generation (`buildTickScript`), IO (`appendPulseReceipt`, `nextTickIndex`, `acquireLock`)
- **Command:** `commands/pulse.js` (`pulseCommand`): subcommands `tick|status|install|uninstall|run`; status recognizes the per-repo LaunchAgent plist and legacy active cron markers, surfaces `.atris/state/pulse-expired.json` only while no scheduler is installed, and install clears that breadcrumb after a successful renewal
- `atris improve` labels pulse age and install state as the scheduled improve heartbeat/loop, so direct mission work is not mistaken for idle metabolism. Regression: `test/improve-vitals.test.js`.
  - `tickCommand`: lock → 'started' receipt → `runMissionEngine` (`atris mission run --due --max-ticks 1 --complete-on-pass`) → `runVerify` → 'finished' receipt + gated scorecard → release lock
  - `statusCommand`: liveness, reward sum, ghost-tick detection, cron-installed check
  - `installCommand` / `uninstallCommand`: write `~/.atris/overnight/atris-cli-self-improve/tick.sh` + manage the `ATRIS_PULSE_SELF_IMPROVE` crontab line (idempotent, preserves other entries, 7-day auto-expiry deadline)
- **Channels written:**
  - `.atris/state/pulse_agi_loop_receipts.jsonl` (schema `atris.pulse_tick.v1`): revives the **Pulse AGI** loop-health channel `commands/brain.js:43` watches
  - `.atris/state/scorecards.jsonl` (schema `atris.improve_tick.v1`, `source:'pulse'`): revives the reward signal `lib/policy-lessons.js` mines
  - `atris/logs/YYYY/YYYY-MM-DD.md` + `.atris/state/pulse-expired.json`: append-only expiry alerts that preserve the dead-man switch while making renewal visible to humans and status surfaces
- **Routing:** `bin/atris.js` (`command === 'pulse'` dispatch) + `knownCommands` array + `showHelp`
- **Tests:** `test/pulse.test.js` (29 tests: scoring, ghost detection, lock, cron-script generation)
- **Scheduler:** per-repo plist in `~/Library/LaunchAgents` uses `launchctl bootstrap` and `AbandonProcessGroup`; install and uninstall also strip marked crontab lines left by older releases
- **Flags:** `pulse install [--cadence "13m"|"11,40 * * * *"] [--hours 6|--days 7] [--verify "npm test"] [--model opus|glm-5.2] [--runner-profile atris-fast|hermes] [--runner-bin /path/to/runner] [--runner-template "{bin} ..."]` exports `ATRIS_RUNNER_*`, `ATRIS_RUNNER_PROFILE`, and legacy aliases into the scheduled tick script; `pulse tick [--no-claude] [--no-verify] [--verify "<cmd>"]`; `pulse run [--max-ticks N]`
- **Value:** Closes the open self-improvement loop: durable ignition (was: `/loop` dies with the session), real executor (was: auto-improver stuck dry-run), reward feedback (was: scorecards flatlined). Does NOT auto-push; work lands in review behind the human gate.

**Search:** `rg "pulseCommand" commands/pulse.js` · `rg "buildTickScript" lib/pulse.js`

## Feature: Auto-Advance (`atris next`)

**Purpose:** First-minute talk for the next pasteable command. Two spoken lines. No fake yes/no.

- **Command:** `commands/next.js:190` (`nextCommand`) speaks first-minute via `speakNext` (`commands/next.js:81`)
- **Help:** `commands/next.js:21` prints `Usage: atris next [--json]`. `bin/atris.js:2636` routes `next` to that command. `bin/atris.js:969` (`showNextHelp`) stays for `atris atris --help`
- **Look:** empty folder and inited rooms reuse `buildFirstMinute` / `freshMinuteJson`. `--json` is `atris.one_lap.v1` with `next_action`. Exit 0. Headless. `ATRIS_NO_INTERACTIVE=1` never prompts
- **Explicit verbs:** `yes` / `no` / `skip` still act on a next-moves card. Skip talks first-minute (`speakCard`). No `Do it?` line
- **Leftover:** quoted `next hi` is a look (`lib/first-minute.js` `LEFTOVER_LOOK_VERBS`)
- **Regression:** `test/next-card.test.js`, `test/dream.test.js` (`next ranker deals and consumes a dream card`), `test/commands-1.test.js` (`activate and next --help`)

**Search:** `rg "nextCommand|speakNext|Do it\\?|atris next --json" commands/next.js test/next-card.test.js bin/atris.js`
