# Goal chat parent setup

The goal chat test now launches five commands instead of six; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-goal-chat-parent.md.
Plan: direct parent setup -> real chat, clear-plan, show and plan commands -> unchanged assertions.
Change: insert the unclaimed parent through the real SQLite task store with the same title, tag and workspace. With one seeded task, the one-row display reference is correct. Close the connection in finally. The empty chat rejection, goal change, zero cleared plans, latest event and plan goal checks remain.
Baseline command: node --test --test-name-pattern='task chat refines a durable goal before plan' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 737.771208ms, duration_ms 874.889958. Exit: 0.
Changed command: node --test --test-name-pattern='task chat refines a durable goal before plan' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 615.625459ms, duration_ms 755.5075. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 25367.173416. Exit: 0.
Metric: command launches reduced from six to five. The single subtest comparison saved 122.145749ms, not a stable benchmark.
Review: only parent setup changed; chat, clear-plan, show and plan still run the CLI and all prior assertions remain. No dependencies or mission fields changed.
Lesson: the zero cleared plans check confirms direct setup leaves no plan stage behind, matching the old CLI parent.
next_push: Seed the two task page test parents directly, numbering display refs after both inserts, while keeping page, chat and review checks on the CLI.
layer: capabilities
