The lineage check now starts three fewer setup commands. Its real completion/export checks passed, exit 0, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated); atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface command, before and after:
```sh
node --test --test-name-pattern='task projection exposes goals' test/commands.test.js
```
Before, exit 0:
```text
✔ task projection exposes goals, review proof, and task lineage for visual boards (699.103541ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 838.40125
```
After, exit 0:
```text
✔ task projection exposes goals, review proof, and task lineage for visual boards (335.764584ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 474.894792
```
Metric: three fewer command launches; the single observed check was 363 ms faster, about 52%. Timing varies; the launch reduction is structural. All goal inference, completed proof, parent-child lineage and stream assertions remain. The shared clock guard preserves insert ordering and the store closes in finally.

Frozen command actually run through task ready:
```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```
Actual saved output excerpt, exit 0:
```text
TAP version 13
# Subtest: the run record rotates aside at its size cap and every record still reads
ok 1 - the run record rotates aside at its size cap and every record still reads
  ---
  duration_ms
...
again once the window passes, and with no stamp at once
  ---
  duration_ms: 48.149917
  ...
1..35
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11041.36325
```
Artifact: atris/runs/2026-10-14-task-aic-34-2026-10-14T18-32-01-123Z.json. Task AIC-34 is in Review, not accepted.

Other commands: atris brain activate --root . --verify; atris; git status --short; atris mission status mission-2026-10-14-continue-fixing-slow-or-flak-d594378f; atris mission goal --json; atris task list --status open; atris task new/retitle/claim/note/ready; git diff --check (exit 0, no output); atris brain compile --root .; git add/commit/push. Brain activation and compilation returned exit 2, plan only; generated brain files were not created in this test-only slice.

Lesson: seed unrelated comparison rows alongside the parent in the real store, while keeping the completion and projection behavior on the CLI.
next_push: Replace the task rendering test's setup creation launch with an ordered real-store seed while keeping rendering checks on the CLI.
layer: capabilities
