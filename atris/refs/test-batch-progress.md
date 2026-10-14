# Test batch progress, 2026-10-14

One bounded scan separated a slow command file from the mission checks. No test code changed and no failure was repaired.

## Evidence

The 20-file scan beginning with `test/commands.test.js` hit its 180-second process-group deadline. Output stopped after the supervisor fallback check. A process snapshot at 173 seconds showed the same command-test worker running a later task-claim CLI check, so the last printed test was not evidence that execution had stopped there. The timeout is an incomplete scan, not a failing assertion or proof of a cloud stall. Exact invocation: `/tmp/auto-improver-batch12-command.txt`; output: `/tmp/auto-improver-batch12.tap`.

The three supervisor checks passed separately in 579.59275 milliseconds, exit 0:

```sh
node --test --test-name-pattern='supervisor' test/commands.test.js
```

The following 20 mission files passed 161 checks, failed 0, cancelled 0, exit 0, in 16534.144875 milliseconds. Output: `/tmp/auto-improver-mission12.tap`.

```sh
node --test test/mission-atris2-runner.test.js test/mission-auto-runner.test.js test/mission-baseline-lifecycle.test.js test/mission-budget-resume-anchor.test.js test/mission-budget-tier.test.js test/mission-check-feedback.test.js test/mission-codex-model.test.js test/mission-complete-guard.test.js test/mission-dedup.test.js test/mission-depth-guard.test.js test/mission-error-streak.test.js test/mission-grok-model.test.js test/mission-heartbeat.test.js test/mission-idle-stop.test.js test/mission-junk-objective.test.js test/mission-layer-receipts.test.js test/mission-ledger-compact.test.js test/mission-member-approval.test.js test/mission-model-resolution.test.js test/mission-number-stability.test.js
```

## Objective and member command group, step 13

The named group passed all nine selected checks, failed 0, cancelled 0, exit 0, in 4895.896792 milliseconds. A dedicated process group had a 120-second deadline and finished in 4.956 seconds without termination. This is passing diagnostic evidence, not a repaired failure. Output: `/tmp/auto-improver-command13.tap`.

```sh
node --test --test-name-pattern='objective-generator|member run' test/commands.test.js
```

The required three-file command passed 35 checks, failed 0, cancelled 0, exit 0, in 9907.009084 milliseconds:

```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```

## Generalist and member lifecycle command group, step 14

All ten selected checks passed, failed 0, cancelled 0, exit 0, in 3694.045834 milliseconds. The process finished in 3.753 seconds within its 120-second deadline. No test code changed and no failure was repaired. Output: `/tmp/auto-improver-command14.tap`.

```sh
node --test --test-name-pattern='generalist|member loop|member alive' test/commands.test.js
```

The frozen three-file check passed 35 checks, failed 0, cancelled 0, exit 0, in 10182.721833 milliseconds. Output: `/tmp/auto-improver-required14.tap`.

```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```

## Member status and mission lifecycle command group, step 15

All five selected checks passed, failed 0, cancelled 0, exit 0, in 3691.957042 milliseconds. No test code changed and no failure was repaired. Output: `/tmp/auto-improver-command15.tap`.

```sh
node --test --test-name-pattern='member status|member block|mission start tick complete|always-on mission run|mission run bounds' test/commands.test.js
```

The frozen three-file check passed 35 checks, failed 0, cancelled 0, exit 0, in 10487.470333 milliseconds. Output: `/tmp/auto-improver-required15.tap`.

```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```

## Task claim command group, step 16

All eight selected checks passed, failed 0, cancelled 0, exit 0, in 5712.168 milliseconds. The process finished in 5.774 seconds within its 120-second deadline. No test code changed and no failure was repaired. Output: `/tmp/auto-improver-command16.tap`.

```sh
node --test --test-name-pattern='task command adds, claims|task do |task headless JSON|claiming a' test/commands.test.js
```

The frozen three-file check passed 35 checks, failed 0, cancelled 0, exit 0, in 12280.11725 milliseconds. Output: `/tmp/auto-improver-required16.tap`.

```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```

## Whole command file, step 18

The whole command file ran alone and passed 437 checks, failed 0, cancelled 0, exit 0, in 344733.685 milliseconds (5 minutes 45 seconds wall clock). A process snapshot at three minutes showed the runner alive and starting short-lived task commands, with no stuck child. The earlier slow-scan result was a deadline shorter than the file's normal runtime, not a hang or leaked state. No test code changed. Output: `/tmp/auto-improver-command18.log`.

```sh
node --test --test-timeout=120000 test/commands.test.js
```

Slowest checks: task review-chat proof-derived verifier commands 28.5 seconds, task auto-accept-certified sweep past the old row cap 10.2 seconds, task review group cap 8.0 seconds, worktree ship merged no-op refusal 6.4 seconds, worktree ship isolated branch 6.0 seconds. Nine checks take over 5 seconds and 42 take over 2 seconds.

## Next move

The whole command file is green when given about six minutes. Give command-file scans a deadline of at least 420 seconds. Next, cut the 28.5-second review-chat check by finding which repeated command launches dominate it, without weakening what it asserts.

next_push: Profile the 28.5-second review-chat check and cut its repeated command launches without changing its assertions.
layer: capabilities
