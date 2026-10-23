# Full suite after the one-lap split

The unchanged committed split was measured with bare `node --test`. It finished faster, but three newly observed failures prevent accepting the no-new-failures condition. This is one validation increment, not a completed speed mission.

## Scope and plan

```text
committed split -> timed full suite -> compare exact failures -> frozen runtime check -> saved evidence
```

No production code, test code, dependencies, excluded test files, mission check or policy changed. The validator measured existing work rather than certifying its own implementation. The intended autoland split was deferred until the current split has full-suite evidence. Rollback: remove this receipt and its map row only.

The prep brief lacked the measured full-suite result after the split and the exact new failure identities. This increment supplies those. Mission task attachment returned exit 3 because the parent process holds the mission lock; a separate local measurement task records the work. No lock was removed. The wiki STATUS file does not exist.

## Before and after

| Measurement | Before | After one-lap split |
| --- | ---: | ---: |
| Bare command | node --test | node --test |
| Wall seconds | 480.23 | 364.97 |
| Tests | 6858 | 6859 |
| Pass | 6852 | 6850 |
| Fail | 6 | 9 |
| Suites | 22 | 22 |
| Skipped / cancelled / todo | 0 / 0 / 0 | 0 / 0 / 0 |
| Exit | 1 | 1 |
| duration_ms | 480197.857291 | 364942.447708 |

Before revision: `1128333d78453c0ca3dbe770b7b641a0d0964fef`. After revision: `43449462adaa75a35a42bf55f4f9b55335e5be66`. Node v24.2.0 for both. The elapsed reduction is 115.26 seconds, 24.0 percent in these two observations. This is not an accepted speed improvement because the failure condition was not met. Load and nondeterminism can affect elapsed time; no causal conclusion about the extra failures is established.

The extra total test result is the discovered shared helper file, as documented in the split receipt. All six original failing names recur. Three additional failing names appear, so matching total tests alone would not establish preservation.

Actual invocation, without a pipeline:

```sh
/usr/bin/time -p node --test > .atris/state/test-suite-speed/after-one-lap.log 2>&1
```

```text
exit 1
tests 6859
suites 22
pass 6850
fail 9
cancelled 0
skipped 0
todo 0
duration_ms 364942.447708
real 364.97
user 1340.75
sys 732.05
```

## Newly observed failures

- `test/member-run-start.test.js:229:1`: member run detach and dry-run do not require a completed work step.
- `test/mission-run-reliability.test.js:156:1`: mission run --detach writes driver state and appends to the mission log.
- `test/mission-run-reliability.test.js:211:1`: the mission lock names the live tick subprocess until it exits.

The first two report that another driver is already running, returning 1 and 3 respectively instead of 0. The third reports `tick subprocess never became the mission lock owner`. These are real full-suite failures, not the intentionally failing child process from the shard test. Investigating their cause or changing their setup belongs to the next increment; they have not been dismissed as flakes.

## Existing failures retained

- `test/engine-resource.test.js:2568:1`: youtube notes in auto mode show a killed writer's cause on screen before the fallback line.
- `test/lesson-gate.test.js:113:3`: throws when all candidates match a resolved lesson.
- `test/lesson-gate.test.js:150:3`: throws when all candidates match a pass lesson without tagging it resolved.
- `test/lesson-gate.test.js:180:3`: throws when all candidates match a pre-tagged resolved lesson.
- `test/runner-command.test.js:335:1`: buildRunnerCommand shell-quotes allowedTools in the default command shape.
- `test/runner-command.test.js:381:1`: buildRunnerCommand omits --allowedTools when not given.

## Local evidence

- `.atris/state/test-suite-speed/after-one-lap.log`: complete output, including final failure diagnostics and timing.
- `.atris/state/test-suite-speed/after-one-lap.exit`: `1`.
- `.atris/state/test-suite-speed/after-one-lap-summary.json`: exact final counts, failure identities, comparison and revision.
- Log SHA-256: `a5e7eacdc54912e3a7d2cdd9885ed046b921b9b384e42040d2faa081647fd462`.

These local logs are intentionally uncommitted. The six earlier failures and their errors are also documented in `atris/receipts/test-suite-speed-baseline-2026-10-22.md`.

## Required runtime check

Actual bare invocation:

```sh
/usr/bin/time -p node --test test/one-lap-runtime.test.js > .atris/state/test-suite-speed/after-one-lap-frozen.log 2>&1
```

```text
exit 0
✔ one lap keeps the worktree and proof receipt when the real verifier fails (13766.677875ms)
✔ one lap ignores a worker-forged quarantine deletion sidecar (8832.251416ms)
✔ one lap rejects Unicode paths that alias reserved metadata on APFS (8402.511041ms)
✔ one lap blocks validator git metadata mutations before Review (7940.867583ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38976.687917
real 39.00
user 13.64
sys 17.80
```

This meets the frozen check on this computer within the reported 120-second harness budget. It covers only four of the original 22 cases. The full-suite measurement above discovered all five split files, and the preceding increment separately passed all 22 using the wildcard command. No frozen command was changed.

Rerun the measurement with `node --test`; rerun the frozen check with `node --test test/one-lap-runtime.test.js`. `git diff --check` exited 0 with no output. Exact edited tracked paths: this receipt and `atris/MAP.md`. The required local member log is appended separately and excluded from commits by repository policy. Generated `atris/TODO.md` changes from task commands are restored to their original bytes.

## Remaining work

No implementation was changed or accepted in this increment. Five intentional break-and-revert checks, further splits if useful, a full-suite run with no additional failures, and a pull request with final numbers remain pending. No pull request, merge, mission policy change or test weakening occurred. The measurement record is committed with only the requested Atris co-author trailer and pushed for review.

next_push: reproduce the three additional mission-process failures and determine whether isolated test setup or full-suite contention causes them before any further split.

layer: capabilities
