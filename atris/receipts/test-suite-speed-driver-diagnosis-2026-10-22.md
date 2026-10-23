# Additional mission test failures explained

The three newly observed failures reproduce together with the inherited driver environment and pass when only the two driver markers are removed. Both complete affected test files then pass all 23 checks. This increment establishes the cause without changing production or test code, and does not claim the full-suite acceptance condition is met.

## Scope

```text
inherited driver markers -> reproduce three failures -> remove only markers -> all 23 affected checks pass -> frozen check -> saved proof
```

Files edited: this receipt and `atris/MAP.md`. The required member log is appended locally at `atris/team/validator/logs/2026-10-22.md`, which is ignored by Git. No source, test, dependency, excluded test file, or mission policy changes. Rollback: remove this receipt and its navigation row only.

Mission task attachment returned exit 3 because the parent runner holds the lock. The claimed local investigation task is `VMT-4`; no lock was removed. The prep brief lacked the isolated reproduction and relevant inherited environment. The requested brain status, ledger, chat scan, and activation-contract files are missing in this checkout. Brain activation and compilation reported plan-only mode; no generated adapter or policy files were written.

## Controlled reproduction

Node v24.2.0. The shell has `ATRIS_MISSION_DRIVER_DETACHED=1` and a nonempty `ATRIS_MISSION_DRIVER_PARENT_PID`. No other environment values were changed between the two targeted invocations. The ordinary inherited run reproduced the same three failures twice, including once before saving the log.

Actual saved invocations, without pipelines:

```sh
node --test --test-name-pattern='member run detach and dry-run|mission run --detach writes|the mission lock names' test/member-run-start.test.js test/mission-run-reliability.test.js > .atris/state/test-suite-speed/driver-inherited.log 2>&1
```

```text
exit 1
tests 3
pass 0
fail 3
cancelled 0
skipped 0
todo 0
duration_ms 4569.066125
```

```sh
env -u ATRIS_MISSION_DRIVER_DETACHED -u ATRIS_MISSION_DRIVER_PARENT_PID node --test --test-name-pattern='member run detach and dry-run|mission run --detach writes|the mission lock names' test/member-run-start.test.js test/mission-run-reliability.test.js > .atris/state/test-suite-speed/driver-clean.log 2>&1
```

```text
exit 0
tests 3
pass 3
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 2606.55525
```

The exact failing names are:

- `member run detach and dry-run do not require a completed work step`: exit 1 rather than 0, another driver is already running.
- `mission run --detach writes driver state and appends to the mission log`: exit 3 rather than 0, another driver is already running.
- `the mission lock names the live tick subprocess until it exits`: tick subprocess never became the mission lock owner.

For the entire affected surface, not just the failing cases:

```sh
env -u ATRIS_MISSION_DRIVER_DETACHED -u ATRIS_MISSION_DRIVER_PARENT_PID node --test test/member-run-start.test.js test/mission-run-reliability.test.js > .atris/state/test-suite-speed/driver-clean-files.log 2>&1
```

```text
exit 0
tests 23
suites 0
pass 23
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 10592.709625
```

## Why the environment matters

At `commands/mission.js:10168`, mission run installs the detached-driver lifecycle before it processes detach at line 10209. At line 8686, the inherited detached marker enables that lifecycle. When the parent marker is present, lines 8689-8696 wait up to two seconds for parent-owned state. Lines 8704-8708 then record the current CLI process as the driver. The subsequent detach health check at lines 8919-8923 sees that live process and refuses a second driver, which is actually itself in these tests.

The lock-owner test polls for approximately two seconds (`test/mission-run-reliability.test.js:238-245`); the unrelated inherited lifecycle wait consumes that observation window before normal work can begin. Removing the markers restores all three real subprocess tests without relaxing their assertions or timing bounds. The exact scheduler contribution to the polling failure is not separately measured.

`git diff 1128333d78453c0ca3dbe770b7b641a0d0964fef HEAD -- commands/mission.js test/member-run-start.test.js test/mission-run-reliability.test.js` exits 0 with no output. These three files are identical to the untouched baseline. Therefore the new full-suite observations alone do not establish that the split caused these failures; inherited driver settings provide a concrete independent trigger. Full-suite load is not necessary to reproduce them.

## Local evidence

| Log | SHA-256 |
| --- | --- |
| `.atris/state/test-suite-speed/driver-inherited.log` | `81ae2420c8a8841b5fe5390cc70b930ab1571af4c9e347cbbeb98fa52a1b2fd8` |
| `.atris/state/test-suite-speed/driver-clean.log` | `b1fc7c30c92939e8fbae33b38faa57015397dc045f841e544a25bf4742dab06d` |
| `.atris/state/test-suite-speed/driver-clean-files.log` | `b12aaefc57681cadc1a09f2f7fa9a27db4f3b34e602095018a1e70ced1c44b08` |

`.atris/state/test-suite-speed/driver-diagnosis-summary.json` stores the counts and log hashes. All logs are local and ignored by Git.

## Required runtime check

Actual invocation, without a pipeline:

```sh
/usr/bin/time -p node --test test/one-lap-runtime.test.js > .atris/state/test-suite-speed/driver-diagnosis-frozen.log 2>&1
```

```text
exit 0
one lap keeps the worktree and proof receipt when the real verifier fails: pass
one lap ignores a worker-forged quarantine deletion sidecar: pass
one lap rejects Unicode paths that alias reserved metadata on APFS: pass
one lap blocks validator git metadata mutations before Review: pass
tests 4
suites 0
pass 4
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 34814.418
real 34.84
user 12.44
sys 11.86
```

This is the frozen four-case check, not all 22 split cases. Exit 0 was read directly from the shell after completion. Rerun: `node --test test/one-lap-runtime.test.js`. The task proof command reran this exact frozen check and exited 0, admitting the receipt to Review. Its local proof is `atris/runs/2026-10-23-task-vmt-4-2026-10-23T05-10-18-293Z.json`. `git diff --check` exits 0 with no output. Generated `atris/TODO.md` was restored to its committed bytes and is excluded from this change.

## Remaining work

The previous full-suite result remains 364.97 seconds, 6850 passing and nine failing, versus the original 480.23 seconds, 6852 passing and six failing. No new full-suite measurement was taken here. No optimization, no-new-failures claim, or mission completion is certified by this investigation. Five deliberate break-and-revert proofs and a final pull request remain pending. Nothing was merged.

next_push: isolate the two affected test runners from inherited detached-driver markers, retaining every real subprocess assertion, then rerun the bare full suite and compare exact failures with the baseline.

layer: capabilities
