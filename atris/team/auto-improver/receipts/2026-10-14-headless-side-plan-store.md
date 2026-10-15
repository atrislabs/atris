# Headless plan setup uses the real task store

The headless plan and do test removes one setup launch, from 18 to 17, while its command output and ownership rejection checks still run the CLI.

## Files
- test/commands.test.js:9964: seed the side plan using stageTask, assert success and close the database before the external claim.
- atris/MAP.md and atris/refs/MAP-NOTES.md: document the setup boundary and correct the test pointer.
- atris/team/auto-improver/logs/2026-10-14.md: lesson and handoff.

## Proof
Baseline command: `node --test --test-name-pattern='^task plan and do record an explicit headless stage contract$' test/commands.test.js`
Output: `✔ task plan and do record an explicit headless stage contract (2055.24325ms)`; tests 1, pass 1, fail 0, duration_ms 2183.797. Exit 0.

Changed command, same runnable command:
```text
✔ task plan and do record an explicit headless stage contract (1934.001208ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2066.113625
```
Exit 0. The test invokes the real CLI against real SQLite for the contract assertions.

Required command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
```text
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10679.051625
```
Exit 0. `git diff --check` also passed, exit 0.

Metric: 18 -> 17 CLI launches (5.6% fewer); focused subtest 2055 -> 1934 ms (single-run observation, not a timing guarantee). Static counts obtained by counting runCli calls in this test in HEAD and the working file.

Lesson: A side plan whose command output is unused can use the real stageTask operation, while the main plan remains on the CLI to cover routing and output. Keep the external claim and do refusal on the CLI to exercise ownership protection.

Review registration: the proof gate required its own invocation. Its bare node resolved to an older runtime without node:sqlite (exit 1); reran with /opt/homebrew/bin/node, the Node 25 runtime used in the successful direct checks.

Review registration passed, exit 0, using the absolute Node 25 binary for both commands. Artifact: atris/runs/2026-10-14-task-aic-54-2026-10-14T22-49-10-551Z.json. Task is ready for approval; no acceptance was performed.

Administrative checks: brain activate and compile both returned plan-only, exit 2; generated adapter changes were not written. No missing boot artifacts were invented.

next_push: Replace setup-only side claims in the headless plan and do test with claimTask while preserving the external-claim ownership scenario and all rejection checks.
layer: capabilities
