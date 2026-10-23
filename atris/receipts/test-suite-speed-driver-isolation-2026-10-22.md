# Mission subprocess test isolation

Both affected test processes now clear only ATRIS_MISSION_DRIVER_DETACHED and ATRIS_MISSION_DRIVER_PARENT_PID before launching scratch missions. No production code, assertions, deadlines, platform gates, dependencies, or excluded test files changed.

## Scope and rollback

Files edited: test/member-run-start.test.js, test/mission-run-reliability.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, and this receipt. The required local member log is atris/team/validator/logs/2026-10-22.md (ignored). Rollback: revert this increment's commit.

```text
inherited mission identity -> clear two markers in isolated test processes -> real subprocess assertions -> recorded proof
```

The surrounding shell had ATRIS_MISSION_DRIVER_DETACHED=1 and ATRIS_MISSION_DRIVER_PARENT_PID=67861. Node's default file isolation confines these deletions to each test process; the surrounding mission remains untouched. Explicit per-test environment overrides still take precedence. This follows the existing top-level environment isolation in member-run-start without stripping additional agent markers.

## Real-surface proof

Command, run bare with the inherited settings still present:

```sh
node --test test/member-run-start.test.js test/mission-run-reliability.test.js
```

Actual output excerpt:

```text
✔ member run detach and dry-run do not require a completed work step (615.565333ms)
✔ mission run --detach writes driver state and appends to the mission log (283.2645ms)
✔ the mission lock names the live tick subprocess until it exits (2133.579917ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10204.747834
exit 0
```

The preceding diagnosis reproduced all three failures with these settings and passed all 23 checks only after externally unsetting them. This change makes that isolation part of the tests themselves. Test bodies and names are unchanged; the only test diff adds a comment and deletes two inherited environment properties in each file.

## Required runtime proof

```sh
node --test test/one-lap-runtime.test.js
```

Run by `atris task ready VMT-5 --verify` with a plain-language result. The first ready attempt rejected the result wording before executing any tests; the corrected invocation succeeded.

```text
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37333.393458
exit 0
```

Proof artifact: atris/runs/2026-10-23-task-vmt-5-2026-10-23T05-25-14-810Z.json. This covers the frozen four cases, not all 22 parallel runtime cases. The task is in Review, not self-accepted. `git diff --check` exited 0 with no output.

## Progress and limits

Three previously reproducible extra failures now pass under the inherited environment, with all 23 affected checks green. No fresh full-suite timing was taken in this single increment. The last measured totals remain 364.97 seconds, 6850 passing and nine failing, compared with 480.23 seconds, 6852 passing and six failing before the split. The mission is not complete: a fresh bare full-suite run must confirm zero new failures; five deliberate break-and-revert checks and the final pull request remain pending. Nothing was merged.

The prep brief supplied the diagnosis but did not include an implemented isolation fix. Bootstrap brain status, ledger, chat scan, activation-contract, and wiki index files were absent. Brain activation and compilation stayed plan-only and did not modify generated policy files. The generated TODO view is restored to committed bytes as instructed and is not part of this commit.

next_push: run the bare full suite with inherited driver settings and compare exact failing names with the six baseline failures before the remaining mutation proofs and pull request.

layer: capabilities
