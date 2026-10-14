# Already-done claim test setup

The already-done claim test now launches three fewer commands; the changed test passed twice and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-done-claim-tasks.md.
Plan: direct setup for the three tasks -> real claim, finish and suggestion commands -> unchanged assertions.
Change: insert the three tasks through the real SQLite task store and number their display refs across the whole workspace after all inserts. Every claim, finish, same tag, fallback and none-left check still runs the CLI.
Baseline command: node --test --test-name-pattern='claiming an already-done task suggests the next open task' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 1777.056042ms, duration_ms 1911.411834. Exit: 0.
Changed command: same command.
Output: tests 1, pass 1, fail 0, subtest 1516.753167ms, duration_ms 1649.403875. Exit: 0. Repeat run: subtest 1446.856125ms, exit 0.
Map refs: the edit added 15 lines, so refs below it moved by 15; the audit loop shows all 46 test refs still on their test headers, named lines, and test closes.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 24783.364375. Exit: 0.
Metric: command launches reduced by three. The single subtest comparison saved about 260ms to 330ms, not a stable benchmark.
Lesson: shifting map refs by the added line count right after the edit, then running the audit loop, keeps them true at no extra cost.
next_push: Seed the three setup tasks in the read-only task current page and queue test, keeping its current and queue checks on the CLI.
layer: capabilities
