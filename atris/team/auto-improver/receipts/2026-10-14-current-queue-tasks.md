# Task current page and queue test setup

The task current page and queue test now launches six fewer commands and runs in about 1.9s instead of 2.7s; it passed 12 of 12 runs and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/lessons.md, atris/team/auto-improver/logs/2026-10-14.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-current-queue-tasks.md.
Plan: seed the five tasks and the review claim at their original points -> real ready, current and queue commands -> unchanged assertions.
Change: one local helper inserts tasks through the real SQLite task store, with the goal link stored the same way the add command stores it. The review task is seeded and claimed first, readied on the CLI, then the other four are seeded at their original point.
Flake found and fixed: the first version failed on its second run. Two goal-linked tasks landed in the same millisecond, so the queue order fell to random ID order. Each insert now polls the clock until it passes the previous insert, matching the distinct times separate CLI launches gave.
Baseline command: node --test --test-name-pattern='task current returns read-only selected page and queue lanes' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 2693.982041ms. Exit: 0.
Changed command: same command, 12 runs.
Output: 12 pass, 0 fail; subtests 1864ms to 2004ms.
Map refs: the edit added 6 lines, so refs below it moved by 6; the audit loop shows every test ref still on its test header or named line.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 25140.674791. Exit: 0.
Metric: command launches reduced by six; about 750ms saved on this test.
Lesson: in-process seeds can share a millisecond; any assertion on queue order needs distinct creation times.
next_push: Audit the earlier multi-task seeds for order-dependent checks and give them the same clock poll where order matters.
layer: capabilities
