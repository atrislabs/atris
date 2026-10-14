# Task step parent setup

The task step test now launches one fewer command; the changed test passed twice and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-task-step-parent.md.
Plan: direct setup for the one parent -> real step, review and show commands -> unchanged assertions.
Change: insert the parent through the real SQLite task store and read its display ref in process. Every step, review, certified and show check still runs the CLI.
Baseline command: node --test --test-name-pattern='task step advances one safe headless action and never human-accepts' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 1422.033166ms, duration_ms 1549.577166. Exit: 0.
Changed command: node --test --test-name-pattern='task step advances one safe headless action and never human-accepts' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 1315.193833ms, duration_ms 1446.207833. Exit: 0. Repeat run: subtest 1310.931334ms, exit 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 24901.12475. Exit: 0.
Metric: command launches reduced by one. The single subtest comparison saved about 107ms, not a stable benchmark.
Review: only parent setup changed. No dependencies or mission fields changed. The ref fixer also offered to move 10 unrelated refs; those were left alone to keep this slice to one change.
Lesson: several bare test line refs in the map notes past this test were already stale before this change, so shifting them by the added lines would not fix them.
next_push: Repoint the stale bare test line refs in the map notes to the tests they name.
layer: capabilities
