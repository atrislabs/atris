# Task page parent setup

The task page test now launches two fewer commands; the changed test passed twice and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-task-page-parents.md.
Plan: direct setup for both parents at their original points -> real page, chat, plan, do, ready, review and show commands -> unchanged assertions.
Change: insert the first parent through the real SQLite task store before the first page check. Insert the legacy row inside the block that already marks it done in process, so it still appears only after the first task is certified. Number its display ref across the whole workspace and assert it differs from the first ref. Every page, stage, review and accept check remains.
Baseline command: node --test --test-name-pattern='task page exposes one-task goal chat stage and review actions' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 2188.673375ms, duration_ms 2316.168917. Exit: 0.
Changed command: node --test --test-name-pattern='task page exposes one-task goal chat stage and review actions' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 2060.117333ms, duration_ms 2198.478375. Exit: 0. Repeat run: subtest 2077.03025ms, exit 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 25422.160333. Exit: 0.
Metric: command launches reduced by two. The single subtest comparison saved about 128ms, not a stable benchmark.
Review: only parent setup changed; the legacy row keeps its original place in the sequence. No dependencies or mission fields changed.
Lesson: a seed that sits mid-test belongs at its original point, so earlier page output never sees a row it did not see before.
next_push: Seed the headless step test parent directly while keeping step, show and review checks on the CLI.
layer: capabilities
