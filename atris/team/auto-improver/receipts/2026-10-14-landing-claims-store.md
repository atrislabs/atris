# Landing sentence setup claims use the real store

The landing sentence test uses three command launches instead of six. The changed test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt. Task commands refreshed the rendered TODO; pre-existing notebook changes were preserved.

Plan: task creation -> real store claim -> unchanged CLI readiness and finish -> saved projection assertions.

All three setup-only claims now call claimTask in the existing setup connection and assert success. No result assertions changed. The store closes before each CLI assertion. No production code changed.

## Proof

Baseline command: `node --test --test-name-pattern='^task ready and finish accept landing capability sentences$' test/commands.test.js`
Output, exit 0:
```text
✔ task ready and finish accept landing capability sentences (883.484667ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 1033.427125
```
Same command after change, exit 0:
```text
✔ task ready and finish accept landing capability sentences (532.656125ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 672.880667
```
Frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Output, exit 0:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 11415.422625
```
Metric: six to three CLI launches, 50% fewer in this test. Single-run durations are observations, not speed guarantees.

Administrative commands: mission status and goal, git status, task list/new/claim/note/ready, brain activate and compile. Brain commands returned plan-only without generated edits. Proof-only ready was rejected because that process had not run the named command; ready was retried with --verify to register executable evidence. Review registration reran both commands and passed, exit 0. Proof artifact: atris/runs/2026-10-14-task-aic-56-2026-10-14T22-52-29-552Z.json. Task remains in Review; no task acceptance performed. git diff --check passed, exit 0.

Lesson: Fixture claims can use the production store operation when claim output is unused; keep the real CLI calls for all behavior under test.

next_push: Replace setup-only claims in the explicit weak landing rejection test while retaining both rejection checks and final task show on the CLI.
layer: capabilities
