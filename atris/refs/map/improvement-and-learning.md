# Improvement and learning

Improve, RSI, experiments, bench, compile, lessons and project learnings. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Core CLI logic

```bash
rg "reason: 'dry_run'|dryRun|no paid improve" commands/improve.js test/improve.test.js test/dogfood-p0-safety.test.js  # improve --dry-run never POSTs the paid endpoint
```

## Search shortcuts: Modular commands

```bash
rg "experimentsCommand" commands/experiments.js  # Experiments CLI command
rg "runImprove|runImproveCore|improveAttemptOutcome|summarizeImproveResponse|summarizeLocalMissionRun|shouldFallbackLocal|summarizeTickHistory|appendTickToJournal|headlessOnly" commands/improve.js commands/mission.js bin/atris.js test/improve.test.js test/improve-skill-contract.test.js test/mission-status.test.js atris/skills/improve/SKILL.md  # Improve command and agent contract: bare `improve` shows vitals, `improve tick` runs the paid RL tick, writes scorecard + journal with only tick-local file changes, and falls back to exactly one verified headless due mission without caller-session placeholders; shipping ticks record a Dream-RSI attempt node via lib/rsi-record.js when the workspace has backend/scripts/rsi/record.py
rg "beginAttempt|finishAttempt|engineFromModel|gitSnapshot|gitDelta|IMPROVE_LANE|GUARD_ENV|latestNodes|currentPolicyId|attemptsPath|dreamsPath" lib/rsi-record.js commands/improve.js commands/pulse.js commands/drive.js commands/rsi.js test/rsi-record.test.js  # Dream-RSI attempt recording: beginAttempt opens a node under today's improve_tick tree (reuses the day's tree, asks choose.py --w 1 for a hint action, never changes the tick's behavior or exit code); pulse tick and drive record too; ATRIS_RSI_ATTEMPT_NODE blocks nested recording; `atris rsi status` prints trees/attempts by lane, last night's outcomes, policy id, and last dream receipt
rg "runLoop|shipOnce|keptRun|openCheckout|allowedPath|mapRefsCheck|wordingCheck|runLoopCommand" lib/rsi-loop.js commands/rsi.js test/rsi-loop.test.js  # RSI notebook loop: no-mission checks, per-check verify and commit, push in budget, cleanup only after the remote tip matches, kept runs resume
rg "playbookCommand|playbookFile|Workspace style rules" commands/playbook.js bin/atris.js lib/known-commands.js test/playbook.test.js  # Playbook command: commands/playbook.js:48 stores, lists, injects, verifies, quarantines, and removes workspace style rules; bin/atris.js dispatches it; test/playbook.test.js uses isolated temporary state.
rg "runTrials|runRuleTrial|bettingEvidence|gradeText" commands/playbook.js test/playbook.test.js  # Paired playbook trials compare best-of-two drafts, persist resumable differences, and certify or quarantine rules with anytime-valid betting evidence.
rg "unknownsCommand|gatherTerritoryContext|buildUnknownsPrompt|renderUnknownsMarkdown|unknowns --help" commands/unknowns.js bin/atris.js test/unknowns.test.js  # Unknowns command: blindspot pass from MAP/lessons/logs/git/task_events through shared runner into SQLite unknowns ledger plus .atris/state/unknowns.md projection
rg "isAtrisCliRepo|refuse outside|--here|benchCommand" commands/bench.js test/dogfood-pass2-t1-t5.test.js  # bench refuses outside the CLI repo unless --here
rg "showLearnHelp|learnAtris|learn help|learnLogSchemaLines|title→key|detail→insight|mintRichLearn|saveRichLearn|commitAddedLearning|commitReviewLearning|appendReviewLearningToJournal|harvestFromJournals|leftoverClaimableInsight|learnExperimentSlug|proveSavedLearnerBaseline|printLearnerCheckGate" commands/learn.js commands/workflow.js commands/youtube.js test/commands-1.test.js test/dogfood-papercuts.test.js test/learn-save.test.js test/workflow-command.test.js # Project learnings + schema on help/validation + title/detail aliases. Rich `learn log` / `learn add` / `learn harvest` / review insight (number-with-units or named mechanism, same bar as youtube notes/teach) mints `atris/experiments/learn-<key>/` through `fileTeachExperiment` and one apply sidecar, then `proveSavedLearnerBaseline` prints `score: 0` only when that Apply starts failing. Thin log/add/harvest/review stays jsonl or prose only and prints `check: fill this` (no invented question, no thin next). A leftover `[claimable]` receipt line under Notes (apply, watched, taught, digest, searched) is not invent-keep.
rg "showSoulHelp|async function soul|soul help" commands/soul.js test/commands-1.test.js # Soul/persona command + workspace-free help
rg "workspace-free help smoke|showSearchHelp|showLearnHelp|showSoulHelp|showHelpShort|showHelpAll|help --all|help --json|already won|later|spaceship|recap|review|stop" bin/atris.js commands/learn.js commands/soul.js test/commands-1.test.js test/golden-path-help.test.js test/dogfood-papercuts.test.js test/dogfood-p0-safety.test.js  # Help surfaces: short first-minute doors, --all opens the same first-minute sentence then later/do/spaceship/autopilot/mission/recap/review/stop plus the long catalog, --json; default help has no em dash and no claim/ready/proof; --all has no box banner or MAP/journal lecture at the top
```

## Feature: Compile Loop (`atris compile`)

**Purpose:** Compile a recurring process into deterministic code verified by backtesting against real execution records: LLM only at build time, the promoted artifact runs token-free; drift below the gate flips status to `drifted` and suggests a recompile

- **Entry point:** `bin/atris.js` command routing for `compile`
- **Handler:** `commands/compile.js`
- **Core functions:** `commands/compile.js:111` (`appendRecord`), `commands/compile.js:344` (`runBacktest`), `commands/compile.js:395` (`promoteProcess`), `commands/compile.js:422` (`buildCompilePrompt`), `commands/compile.js:447` (`executeBuild`), `commands/compile.js:693` (`compileCommand`)
- **How it works:**
- `atris compile record <name> --input ... --output ... [--expected ...]` appends an execution record to `.atris/state/processes/<name>/records.jsonl`
- `atris compile build <name>` uses the shared runner command (`ATRIS_RUNNER_BIN`, `ATRIS_RUNNER_COMMAND_TEMPLATE`; legacy `ATRIS_CLAUDE_*` aliases still work; default Claude-compatible `claude -p`) to compile records + `atris/processes/<name>/spec.md` into `atris/processes/<name>/run.js` (contract: `module.exports = { run }`, deterministic, Node built-ins only); bumps version, clears the old backtest
- `atris compile backtest <name>` replays every record through `run()`, scores accuracy vs the gate (default 0.99), writes results into `atris/processes/<name>/process.json`
- `atris compile promote <name>` activates only if the current version's backtest accuracy meets the gate
- `atris compile exec <name> --input ... [--record]` runs the artifact token-free; `--record` feeds the run back into the ledger
- Drift detection: an active process whose backtest falls below its gate is marked `drifted` (self-healing against process drift)
- **Tests:** `test/compile.test.js` (20 tests: records, deep-equal, backtest, promote gate, stale-version guard, drift, async runners, runner command, prompt contract)
- **Search:** `rg "runBacktest|promoteProcess|executeBuild" commands/compile.js`

## Feature: Bench (`atris bench`)

**Purpose:** Run fixed benchmark packs serially in hermetic temp workspaces, compare current and candidate agent text trees task by task, append benchmark receipts, expose task metadata for the daily keep/revert gate, measure coding agents through directory task packs, and report per-engine scores from the accumulated results.

- **Entry point:** `bin/atris.js` command routing for `bench`
- **Handler:** `commands/bench.js` (`runCommand:90`, `pairCommand:123`, `tasksCommand`, `packsCommand`, `resultsCommand`, `reportCommand`, `benchCommand`)
- **Runner:** `lib/bench/runner.js` (`installAtrisShim:217` pins agent tasks to this checkout, `runAgentTaskSpec:264` exposes `ctx.engineResult`, `runBench:495`, `runBenchPair:602`, `taskMetadata`, `packMetadata`)
- **Tree renderer:** `lib/bench/tree-render.js` (`renderTreeInto:20` copies the hashed text tree into each fixture; `materializeCandidate:42` accepts a directory or extracts a git ref)
- **Engine adapters:** `lib/bench/engines.js` (`codex`, `cursor`, `claude`, `atris-fast`, `null`, `solution`)
- **Hermetic context:** `lib/bench/context.js` (`hermeticEnv`, `createBenchContext`, `withBenchContext`)
- **Report builder:** `lib/bench/report.js` (`buildBenchReport:44` groups `results.jsonl` by engine, keeps each engine's latest full run and merges partial runs only when no full run exists; `renderBenchReportText:116` renders the human view; schema `atris.bench.report.v1`)
- **Task packs:** `atris/benchmarks/core-v1/` (legacy `.js` specs), `atris/benchmarks/agents-v1/` (directory task specs), `atris/benchmarks/harness-v1/` (three plain concierge asks graded from agent transcript and persisted state)
- **How it works:**
- `atris bench run [--pack <id>] [--engine <name>] [--task <id> ...] [--label baseline|candidate] [--experiment <id>] [--update-baseline] [--json]` runs serial task specs and appends `.atris/state/bench/results.jsonl`
- `atris bench pair --candidate <dir|git-ref> [--pack <id>] [--engine <name>] [--task <id> ...] [--min-win-margin <n>] [--repeats <n>] [--current <dir>] [--json]` interleaves current and candidate tree runs for every selected task, records both scores and hashes, and selects only when the candidate clears the requested win margin
- `atris bench packs [--json]` lists benchmark packs under `atris/benchmarks/`
- `atris bench results [--last N] [--json]` reads persisted run receipts
- `atris bench tasks [--pack <id>] [--json]` lists pack metadata from the task specs
- `atris bench report [--pack agents-v1] [--json]` reads `.atris/state/bench/results.jsonl`, groups by engine (latest full run wins), and prints N/25 passed, per-category counts, mean task duration, failed task ids, and skipped count; empty results print `no runs recorded for pack <pack>` and exit 0
- **Regression:** `test/bench-harness-pack.test.js`, `test/bench-pair.test.js`, `test/bench-core-gate.test.js`, `test/bench-runner.test.js`, `test/bench-tasks.test.js`, `test/bench-agents.test.js`, `test/bench-agents-harness.test.js`, `test/bench-report.test.js`, `test/mission-tick-prompt.test.js`
- **Search:** `rg "benchCommand|runBenchPair|renderTreeInto|taskMetadata|withBenchContext|ENGINE_NAMES|buildBenchReport" commands/bench.js lib/bench/runner.js lib/bench/tree-render.js lib/bench/context.js lib/bench/engines.js lib/bench/report.js`

## Feature: Experiments (`atris experiments`)

**Purpose:** Scaffold, validate, run, compare, and rehearse bounded experiment packs inside `atris/experiments/`, including Endstate benchmark receipts

- **Entry point:** `bin/atris.js` command routing for `experiments`
- **Handler:** `commands/experiments.js`
- **Core functions:** `commands/experiments.js:55` (`ensureExperimentsFramework`), `commands/experiments.js:141` (`parseMeasureScore`), `commands/experiments.js:154` (`runMeasureJson`), `commands/experiments.js:182` (`printKeepRevertNext`), `commands/experiments.js:186` (`printRevertKeepNext`), `commands/experiments.js:190` (`printKeepWatchTickNext`), `commands/experiments.js:194` (`experimentsKeep`), `commands/experiments.js:248` (`runResetScript`), `commands/experiments.js:279` (`experimentsRevert`), `commands/experiments.js:498` (`buildBenchmarkArtifact`), `commands/experiments.js:615` (`experimentsRun`), `commands/experiments.js:680` (`experimentsCompare`), `commands/experiments.js:712` (`experimentsReplay`)
- **Daily loop:** `commands/experiments.js:734` (`experimentsDaily`), `commands/experiments.js:740` (`experimentsQueue`), `commands/experiments.js:753` (`experimentsCommand` routes `daily`, `queue`, `keep`, and `revert`)
- **Daily engine:** `lib/experiments/daily.js:18` (`queuePath`), `lib/experiments/daily.js:53` (`readQueue`), `lib/experiments/daily.js:69` (`appendQueueEntry`), `lib/experiments/daily.js:227` (`evaluateKeepRule`), `lib/experiments/daily.js:259` (`runApplyScript`), `lib/experiments/daily.js:394` (`runDaily`), `lib/experiments/daily.js:584` (`queueAdd`), `lib/experiments/daily.js:604` (`queueList`)
- **Autoland hook:** `commands/autoland.js:1224` runs `atris experiments daily --json` during `autoland tick` when policy `daily_experiment` is not false
- **How it works:**
- `atris init` now prepares `atris/experiments/` with packaged validators, fixtures, templates, and smoke examples
- `atris experiments init [slug]` scaffolds a new bounded experiment pack
- `atris experiments validate` runs structural checks and context-bloat validation
- `atris experiments run <slug>` executes a pack; Endstate packs also emit JSON receipts + append `results.tsv`
- `atris experiments keep <slug>` runs `atris/experiments/<slug>/measure.py` against the current working tree and prints a keep line only when the score is 1 (minted packs start at 0). Score 1 also prints one `next: atris youtube watch tick` stdout line (`printKeepWatchTickNext`) and exits 0. Score 0 or a failed score prints the revert/refuse reason on stderr plus one `next: atris experiments revert <slug>` stdout line (`printKeepRevertNext`) and exits 1 without deleting the pack and without the watch-tick next-step. Missing slug, invalid slug, missing atris/, missing pack, or missing measure.py exits 2 and prints no revert next-step and no watch-tick next-step. Rich notes, teach, and x-search `--save`, plus rich youtube digest and rich watch tick, print one `next: atris experiments keep <slug>` (folder name, not the pack path).
- `atris experiments revert <slug>` runs `atris/experiments/<slug>/reset.py` from the workspace root with the same Python resolution as keep. Success prints a revert line plus one `next: atris experiments keep <slug>` stdout line (`printRevertKeepNext`) and exits 0. Reset failure exits nonzero with a refuse line and no keep next-step. Missing slug, invalid slug, missing atris/, missing pack, or missing reset.py exits 2 and prints no keep next-step. If measure.py exists after reset, the revert line also names that score.
- `atris experiments compare endstate` reads the latest baseline + stack receipts, prints the side-by-side scorecard, and declares `stack wins` or `no winner yet` from the Level 1 rule
- `atris experiments replay endstate` validates both packs, emits fresh dry-run receipts, then compares the latest result in one command
- Endstate packs pin runner profiles in `runner.json` (`baseline-single` vs `stack-coordinated`) so baseline and stack resolve different live prompt strategies
- `atris experiments benchmark [validate|runtime]` proves the validator and keep/revert example still work
- `atris experiments daily [--dry-run] [--force] [--json]` runs the first untried queue entry through bench-gated keep/revert
- `atris experiments queue add <id> --target <file>[,<file>] --apply <script> [--verify "<cmd>"] [--note "..."]` appends to `atris/experiments/daily/queue.jsonl`
- `atris experiments queue list [--json]` prints the daily queue
- **Endstate helper:** `lib/endstate.js:94-259` scores artifacts, reads the latest receipt, compares baseline vs stack, writes artifact files, and appends `results.tsv` rows
- **Workspace assets:**
- `atris/experiments/README.md`
- `atris/experiments/validate.py`
- `atris/experiments/benchmark_validate.py`
- `atris/experiments/benchmark_runtime.py`
- `atris/experiments/_template/pack/`
- `atris/experiments/_examples/smoke-keep-revert/`
- `atris/experiments/daily/queue.jsonl`
- `atris/experiments/daily/apply/`
- `atris/experiments/taste-loop/` - Frozen writing, website, and video-prompt references with an independent scorer and all-modality keep/revert gate
- `atris/experiments/sessionstart-plant/` - keep/revert metric for SessionStart plant via pack PreToolUse/config-guard; score 1 only when Write and Bash `cat >>` both deny, hash unchanged, disableAllHooks stays false, and voice-card UserPromptSubmit is still allowed (`measure.py`, `probe.js`)
- `atris/experiments/teach-thin-save/` - keep/revert metric for `atris youtube teach --save` on a fixture thin chapter; score 1 only when the live command prints the thin refuse, writes no `atris/wiki/briefs` file, and exits 2 (`measure.py`, `probe.js`)
- `atris/experiments/teach-<videoid>-s<n>/` - minted by rich `atris youtube teach --save`; `measure.py` is derived from that chapter's printed fail-able check and scores 1 only when the fixture contains the number-with-units or named mechanism (`loop.py` keep-0-to-1). The apply sidecar and journal Inbox claim name this pack path and the keep rule, and the sidecar omits those check tokens so baseline stays 0. `atris experiments keep <slug>` is the CLI gate for that rule. `atris experiments revert <slug>` runs the pack `reset.py`.
- `atris/experiments/notes-<videoid>/` - minted by rich `atris youtube notes --save` through the same `fileTeachExperiment` helper (`lib/youtube-core.js:2719`); same keep-0-to-1 rule, apply sidecar `notes-<id>.apply.md`, thin `--save` writes no pack. That sidecar does not fill the `youtube-<id>.apply.md` process gate.
- `atris/experiments/digest-<date>/` - minted by rich `atris youtube digest` through the same `fileTeachExperiment` helper (`lib/youtube-core.js:1087` `saveRichDigest`, slug at `lib/youtube-core.js:1055`); same keep-0-to-1 rule, apply sidecar `digest-<date>.apply.md`, thin digest writes no pack.
- `atris/experiments/watch-<videoid>/` - minted by the first rich brief on `atris youtube watch tick` through the same `fileTeachExperiment` helper (`lib/youtube-core.js:1147` `saveRichWatch`, pick at `lib/youtube-core.js:1138` `firstRichWatchLesson`, slug at `lib/youtube-core.js:1100`); same keep-0-to-1 rule, apply sidecar `watch-<id>.apply.md`, all-thin watch tick writes no pack.
- `atris/experiments/x-search-<slug>/` - minted by rich `atris x-search --save` through the same `fileTeachExperiment` helper (`lib/youtube-core.js:2719`, called from `commands/x-search.js:573` `saveRichXSearch`, slug at `commands/x-search.js:447`); same keep-0-to-1 rule, apply sidecar `x-search-<slug>.apply.md`, thin `--save` writes no pack. Default x-search without `--save` writes no pack (`commands/x-search.js:645`). `atris x-search unsave <query-or-source>` (`commands/x-search.js:555`) deletes this pack with the brief and apply sidecar; leftover pack-only still removes the pack.
- `atris/experiments/learn-<key>/` - minted by rich `atris learn log`, `learn add`, `learn harvest`, and review through the same `fileTeachExperiment` helper (`commands/learn.js` `saveRichLearn`, slug `learnExperimentSlug`); same keep-0-to-1 rule, apply sidecar `learn-<key>.apply.md`, thin log/add/harvest/review writes no pack.
- `atris/experiments/process-<videoid>/` - minted by rich `atris youtube process` through the same `fileTeachExperiment` helper (`lib/youtube-core.js:862` `saveRichProcess`, slug at `lib/youtube-core.js:850`); same keep-0-to-1 rule, apply sidecar `process-<id>.apply.md`, thin process writes no pack. The filled `youtube-<id>.apply.md` gate still must exist before the paid call. A leftover notes keep-sidecar at that path (`change: apply atris/experiments/...` or a measure.py keep receipt) is not a human Apply: `ensureProcessApply` (`human: true`) rewrites it to fill this and refuses. `atris youtube unsave` deletes this pack with the process sidecar.
- `atris/experiments/search-<query>/` - minted by rich free `atris youtube search` (live or cache reprint) and rich paid `--paid` search through the same `fileTeachExperiment` helper (`saveRichSearch`, slug `searchExperimentSlug`); same keep-0-to-1 rule, apply sidecar `search-<query>.apply.md`, thin or `--json` search writes no pack.
- **Value:** Makes self-improvement loops and scoreable benchmark runs first-class Atris CLI concepts instead of repo-local convention

**Search:** `rg "experimentsCommand|experimentsKeep|experimentsRevert|printKeepRevertNext|printRevertKeepNext|printKeepWatchTickNext|runMeasureJson|runResetScript|experimentsRun|experimentsCompare|experimentsReplay|buildBenchmarkArtifact|ensureExperimentsFramework|experimentsDaily|experimentsQueue|sessionstart-plant|teach-thin-save|fileTeachExperiment|ensureTeachApply|teachExperimentSlug|notesExperimentSlug|notesApplyRel|digestExperimentSlug|watchExperimentSlug|processExperimentSlug|searchExperimentSlug|saveRichNotes|saveRichDigest|ensureDigestApply|saveRichWatch|ensureWatchApply|saveRichProcess|ensureProcessLearnerApply|saveRichSearch|ensureSearchApply|mintRichSearch|gateSearchLearner|xSearchExperimentSlug|saveRichXSearch|unsaveXSearch" commands/experiments.js commands/init.js lib/experiments/daily.js commands/autoland.js commands/youtube.js commands/x-search.js atris/experiments/sessionstart-plant atris/experiments/teach-thin-save`

## Feature: Loop-Proof Instruments (2026-06-12)

**Purpose:** Make self-improvement measurable: lineage from vision to commit, identity history, belief hygiene, repeated impression at boot, per-layer tick receipts.

- `atris task lineage <id> [--json]`: endgame → parents → target → children chain + commits grepped by display refs (`cmdLineage` in `commands/task.js`; test: `test/commands-1.test.js` 'task lineage')
- `atris member history <name> [--limit N] [--json]`: git log per identity file (MEMBER.md/SOUL.md) (`memberHistory` in `commands/member.js`; test: `test/member-history.test.js`)
- `atris lesson sweep [--dry-run] [--json]`: contradiction detection (opposite outcomes, dead file refs) leads to idempotent dissolve tasks (`lib/lesson-contradiction.js:14`, `commands/lesson.js`; tests: `test/lesson-sweep.test.js`, `test/no-em-dash-output.test.js`).
- Lesson contracts + ledger: `atris lesson add --detector "<cmd>"` validates the detector at write time (rejects empty/127/126) and writes md + sidecar + ledger in one step (`addLesson` in `commands/lesson.js`, `validateDetector` in `lib/lesson-ledger.js`); every add/resolve/revert appends evidence to `.atris/state/lesson_ledger.jsonl` (`appendLedgerEntry`/`readLedger`); `atris lesson revert <slug>` reopens a wrongly-resolved lesson (`revertLessonResolution`) and `atris lesson ledger` shows the trail (test: `test/lesson-ledger.test.js`)
- Boot impression: boot status shows the newest `atris/wiki/briefs/*.md` mtime as one `learned ... overnight` line, renders the active endgame slug+horizon verbatim (`bin/atris.js` showWelcomeVisualization), and `listTasks` ranks `tag='endgame'` first within status (`lib/task-db.js`; test: `test/boot-impression.test.js`)
- Layer receipts: every mission tick stores `layer`/`layer_source` (explicit `layer: x` receipt line or path-class fallback) + `last_tick_layer` on the mission; heartbeat shows it (`extractLayerFromReceiptText`/`classifyPathsByLayer` in `commands/mission.js`; test: `test/mission-layer-receipts.test.js`)

## Feature: Project Learnings (`atris learn`)

**Purpose:** Store and inspect reusable project patterns, pitfalls, preferences, architecture notes, and tool lessons.

- **Entry point:** `bin/atris.js:1581-1577` routes to `commands/learn.js`
- **Handler:** `commands/learn.js` (`learnAtris`)
- **Help:** `showLearnHelp` short-circuits help before workspace checks
- **Rich log mint:** `commands/learn.js` `mintRichLearn` / `saveRichLearn` / `ensureLearnApply` / `commitAddedLearning` / `commitReviewLearning` / `harvestFromJournals`. A rich `atris learn log`, `learn add`, `learn harvest`, or review insight (number-with-units or named mechanism) mints `atris/experiments/learn-<key>/` plus `atris/wiki/briefs/learn-<key>.apply.md`, prints `next: atris experiments keep learn-<key>`, then `proveSavedLearnerBaseline` prints `score: 0` only when that sidecar starts failing. Thin log/add/harvest/review stays jsonl or prose only, prints `check: fill this` through `printLearnerCheckGate`, and does not invent a question or a thin next-step. `commands/workflow.js` `appendReviewLearningToJournal` folds CRLF then writes the review note under `## Notes`, then `commitReviewLearning`. `harvestFromJournals` folds `\r\n` to `\n` before the `## Notes` match so a Windows-round-tripped journal still harvests, same bar as analytics inbox CRLF. A leftover `[claimable]` receipt line that lands under Notes (apply after a mint, or leftover watched/taught/digest/searched) is not invent-keep: `leftoverClaimableInsight` skips it so harvest stays on a real insight.
- **Regression:** `test/commands-1.test.js` covers `learn --help`; `test/learn-save.test.js` covers rich mint + failing baseline and thin fill-this (no invented question, no thin next) for log, add, harvest, and review, plus rich harvest from a CRLF `## Notes` section and leftover claimable apply/watched invent-keep; `test/workflow-command.test.js` covers review Notes write on LF and CRLF; `test/dogfood-papercuts.test.js` covers title/detail aliases
- **Value:** Agents can inspect and add compounding memory without conflating it with journal search or Atris lessons. A rich YouTube/X lesson captured through learn becomes one claimable Apply.

**Search:** `rg "showLearnHelp|learnAtris|learn help|mintRichLearn|saveRichLearn|commitAddedLearning|commitReviewLearning|appendReviewLearningToJournal|harvestFromJournals" commands/learn.js commands/workflow.js test/learn-save.test.js test/workflow-command.test.js test/commands-1.test.js`

## Feature: Soul (`atris soul`)

**Purpose:** Inspect, snapshot, distill, or fork workspace persona, policies, lessons, team, and knowledge context.

- **Entry point:** `bin/atris.js:1644-1641` routes to `commands/soul.js`
- **Handler:** `commands/soul.js:310-381` (`soul`)
- **Help:** `commands/soul.js:299-308` (`showSoulHelp`) and `commands/soul.js:316-319` short-circuit before `findAtrisDir`
- **Regression:** `test/commands-2.test.js:937-951` covers `soul --help`, `soul -h`, and `soul help` without temp workspace state
- **Value:** Agents can learn what the workspace has retained without requiring initialized state for documentation paths.

**Search:** `rg "showSoulHelp|async function soul|soul help" commands/soul.js test/commands-1.test.js`

## Concern: Output Quality Policies

- `lib/lesson-preflight.js` (`matchLessons`) - reads typed lesson metadata plus prose, ranks path and brief-keyword matches, excludes resolved code-enforced mechanisms, and caps generated fleet prompts at five lessons before engine dispatch; regression: `test/lesson-preflight.test.js`

## Revision reports across out-of-order commit dates

`commands/improve.js:1309` filters the existing lookback with `--since-as-filter`, so an old-dated descendant cannot prune a real landing or correction. `test/improve-revisions.test.js:64` compares matching landing/correction commits and final trees through the real API and CLI, including agent and outside-window controls. Verify: `node --test test/improve-revisions.test.js`.

Python discovery for tests: `test/helpers/find-python.js:5` tries real `python3 --version`, then `python --version`, with the original UTF-8 options and null result when neither works. Five session-start, benchmark, experiment and learning suites retain their discovery call positions, private fixtures and every behavior check. Check: `node --test test/sessionstart-plant.test.js test/bench-runner.test.js test/experiments.test.js test/learn-save.test.js test/youtube-digest.test.js`.
