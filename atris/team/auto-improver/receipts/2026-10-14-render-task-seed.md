Task rendering setup starts one fewer command. The real rendering and lookup check passed, exit 0, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated); atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface, actually run before and after:
```sh
node --test --test-name-pattern='task render preserves Endgame metadata' test/commands.test.js
```
Before, exit 0:
```text
✔ task render preserves Endgame metadata and drops markdown-only rows (460.939209ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 589.4335
```
After, exit 0:
```text
✔ task render preserves Endgame metadata and drops markdown-only rows (377.484709ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 519.395583
```
Metric: setup command launches reduced by one, from four total command launches to three. One observation was 83 ms faster, about 18%; timing varies. Both renders, reference lookup and all assertions remain on the real CLI. Setup uses the ordered real-store helper and closes the store in finally.

Initial changed-surface run failed, exit 1: handwritten rows survived. Investigation showed task creation previously refreshed TODO.md and added the generated-file marker. The fixture now explicitly carries that marker, preserving the prior generated-state precondition without another launch. No assertions were weakened.

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
  duration_ms: 38.650459
  ...
1..35
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12587.935583
```
Artifact: atris/runs/2026-10-14-task-aic-35-2026-10-14T18-34-11-160Z.json. Task is in Review, not accepted.

Other commands: atris brain activate --root . --verify; atris; git status --short; atris mission status mission-2026-10-14-continue-fixing-slow-or-flak-d594378f; atris mission goal --json; atris task list --status open; atris task new/claim/note/ready; git diff --check; atris brain compile --root .; git add/commit/push. Brain activation and compilation returned exit 2, plan only. Mission attach-task returned exit 3 because the existing mission lock was busy; the task was created and claimed directly without changing mission state.

Lesson: replacing setup commands requires preserving file side effects as explicit fixture preconditions, not just inserting the same database row.
next_push: Remove the setup creation launch from the stale generated markdown rendering check while preserving its ready and render calls.
layer: capabilities
