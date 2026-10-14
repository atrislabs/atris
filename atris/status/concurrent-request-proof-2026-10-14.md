# Concurrent requests use a release signal

The duplicate-request test now proves actual overlap with a release file instead of a five-second sleep. Both real CLI processes drain asynchronously, and the duplicate must return waiting_input while the first builder remains held. The release happens in finally, and the first process is awaited before fixture cleanup. Application and sandbox policy are unchanged.

Changed surface: `/opt/homebrew/bin/node --test --test-name-pattern=identical test/one-lap-runtime.test.js`
Before, exit 0:
```text
✔ identical asks in separate processes run one atomic lap (17661.43675ms)
ℹ pass 1
ℹ fail 0
ℹ duration_ms 17768.007625
```
After, exit 0:
```text
✔ identical asks in separate processes run one atomic lap (12411.048333ms)
ℹ pass 1
ℹ fail 0
ℹ duration_ms 12508.4015
```
Frozen verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Exit 0, supported Node v25.6.1:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 10143.808
```
An earlier non-login shell resolved Node v20.18.0, below the project's supported version. That frozen invocation also passed 35, failed 0, exit 0, duration 21649.427416ms. The focused pre-change check passed, so no reproduced hang is claimed. Progress: one elapsed-time coordination dependency removed, stricter concurrency assertion, focused runtime decreased 5.25 seconds in these observations, not a benchmark.

Files edited: test/one-lap-runtime.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/status/concurrent-request-proof-2026-10-14.md; atris/status/for-you.md.
Commands: git status --short; atris mission status mission-2026-10-14-eliminate-flaky-tests-and-ti-ab805966; atris task list/new/claim/note/ready; atris; atris mission goal --json (no candidate); atris brain activate/compile --root . (plan-only); focused before and after command; frozen command; git diff --check; git add/commit/push. Task commands regenerated the rendered backlog from incomplete local state; only that generated change was restored from HEAD.

next_push: run the complete isolated command test file with supported Node and repair the first confirmed remaining failure.
layer: capabilities

Review gate: the proof-only ready call was rejected because that process had not run the check. Reissued with the focused command via --verify; it exited 0 and moved the task to Review. Receipt: atris/runs/2026-10-14-task-aie-4-2026-10-14T13-00-31-496Z.json. No task acceptance or auto-certification claimed.
