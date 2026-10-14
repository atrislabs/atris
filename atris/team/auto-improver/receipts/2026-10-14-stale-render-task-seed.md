Stale markdown test setup starts one fewer command. The affected real CLI check passed, exit 0, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated); atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed-surface command, actually run before and after:
```sh
node --test --test-name-pattern='task render drops stale generated markdown rows' test/commands.test.js
```
Before, exit 0:
```text
✔ task render drops stale generated markdown rows for DB-backed tasks (649.058708ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 789.573375
```
After, exit 0:
```text
✔ task render drops stale generated markdown rows for DB-backed tasks (514.424209ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 654.101916
```
Metric: setup removes one launch, five total CLI calls become four. One observation saved 135 ms, about 21%; elapsed times vary. The real task store seeds the row in insertion order and closes in finally. Claim, ready, legacy rendering, generated rendering and all behavior assertions remain unchanged.

Frozen command, actually run through task ready:
```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```
Saved output excerpt, exit 0:
```text
TAP version 13
# Subtest: the run record rotates aside at its size cap and every record still reads
ok 1 - the run record rotates aside at its size cap and every record still reads
  ---
  duration_ms
...
gain once the window passes, and with no stamp at once
  ---
  duration_ms: 45.511875
  ...
1..35
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11520.136584
```
Artifact: atris/runs/2026-10-14-task-aic-36-2026-10-14T18-35-54-967Z.json. Task is in Review, not accepted.

Other commands: git status --short; atris mission status mission-2026-10-14-continue-fixing-slow-or-flak-d594378f; atris mission goal --json; atris brain activate --root . --verify; atris; atris task list --status open; atris task new/claim/note/ready; git diff --check (exit 0); atris brain compile --root .; git add/commit/push. Brain activation and compilation returned exit 2, plan only, so no generated policy changes were applied. No mission settings changed.

Lesson: seed only the setup row when later CLI calls supply all required file side effects; keep the behavior under test on the real CLI.
next_push: Remove the stale markdown fixture's claim setup launch with a claimed real-store seed, preserving ready and both render checks.
layer: capabilities
