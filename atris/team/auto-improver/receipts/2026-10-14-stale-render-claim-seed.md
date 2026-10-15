Stale markdown setup now starts one fewer command. The changed test and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/TODO.md (generated); atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface, actually run before and after:
```sh
node --test --test-name-pattern='task render drops stale generated markdown rows' test/commands.test.js
```
Before, exit 0: one test passed in 534.973375 ms.
After, exit 0:
```text
✔ task render drops stale generated markdown rows for DB-backed tasks (408.604083ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 547.971917
```
Metric: four CLI calls become three, a 25% reduction in launches for this test. One timing observation saved 126 ms, about 24%; timings vary. The real task store claims the ordered seed, with an assertion that claiming succeeded; ready, both renders and all existing rendering assertions remain on the real CLI. Store cleanup remains in finally.

Frozen verification, actually run through task ready:
```sh
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
```
Exit 0, saved output:
```text
TAP version 13
# Subtest: the run record rotates aside at its size cap and every record still reads
ok 1 - the run record rotates aside at its size cap and every record still reads
  ---
  duration_ms
...
gain once the window passes, and with no stamp at once
  ---
  duration_ms: 46.161542
  ...
1..35
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11789.358917
```
Proof artifact: atris/runs/2026-10-14-task-aic-37-2026-10-14T18-37-31-554Z.json. Task AIC-37 is in Review, not self-accepted.

Other commands: git status --short; atris mission status mission-2026-10-14-continue-fixing-slow-or-flak-d594378f; atris task list --status open; atris brain activate --root . --verify; atris; atris mission goal --json; atris task new/claim/note/ready; git diff --check; atris brain compile --root .; git add/commit/push. Brain compile exited 2, plan only, so no generated policy edits were applied. Mission settings are unchanged.

Lesson: use the real store's claim operation for setup when later retained CLI calls provide required file side effects. Preserve behavior assertions rather than replacing them with setup assertions.
next_push: Replace the two creation launches in the filtered task display-reference test with ordered real-store seeds, keeping completion and list checks on the CLI.
layer: capabilities
