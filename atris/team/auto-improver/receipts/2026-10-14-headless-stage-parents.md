# Headless stage parent setup

The headless plan and do test now launches four fewer commands; the changed test passed twice and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/lessons.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-headless-stage-parents.md.
Plan: direct setup for four parents -> real claim, plan, do, show, status and ready commands -> unchanged assertions.
Change: insert the four unclaimed parents through the real SQLite task store with the same titles, tag and workspace. Compute display refs once over the whole workspace list after all inserts, look each up by id, and assert all four are distinct. Close the connection in finally. Every rejection reason, stage, message and review check remains.
Baseline command: node --test --test-name-pattern='task plan and do record an explicit headless stage contract' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 2879.335667ms, duration_ms 3013.113708. Exit: 0.
Initial changed run: exit 1. A later claim by a second person failed because each seeded ref was computed from a one-row list, so every seeded task was named number 1 and the second task's commands hit the first task. Repaired by numbering refs across the workspace.
Changed command: node --test --test-name-pattern='task plan and do record an explicit headless stage contract' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 2483.794333ms, duration_ms 2620.457833. Exit: 0. Repeat run: subtest 2510.553458ms, exit 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 25276.449292. Exit: 0.
Metric: command launches reduced by four. The single subtest comparison saved about 380ms, not a stable benchmark.
Review: only parent setup changed; claims, plans, dos, shows, status and ready still run the CLI and all prior assertions remain. No dependencies or mission fields changed.
Lesson: display refs depend on the whole workspace list, so multi-task seeds must number refs after all inserts. Recorded in atris/lessons.md.
next_push: Seed the goal chat refinement test parent directly while keeping its chat and plan checks on the CLI.
layer: capabilities
