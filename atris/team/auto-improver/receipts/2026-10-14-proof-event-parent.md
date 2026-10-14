# Proof event parent setup

The proof event test now launches two commands instead of three; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-proof-event-parent.md.
Plan: direct parent setup -> real done and show commands -> unchanged assertions.
Change: insert the unclaimed parent through the real SQLite task store with the same title, tag and workspace, and close the connection in finally. The test already used the raw task id, so no display reference is needed. The reward, episode, zero Career XP and exact three-event checks remain.
Baseline command: node --test --test-name-pattern='task done with proof writes a reviewed proof event' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 449.350459ms, duration_ms 588.688666. Exit: 0.
Changed command: node --test --test-name-pattern='task done with proof writes a reviewed proof event' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 349.453541ms, duration_ms 491.093583. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 25712.528125. Exit: 0.
Metric: command launches reduced from three to two. The single subtest comparison saved 99.896918ms, not a stable benchmark.
Review: only parent setup changed; done and show still run the CLI and all prior assertions remain. No dependencies or mission fields changed.
Lesson: the exact event list check doubles as proof that direct setup adds no extra claim or note event.
next_push: Seed the headless stage contract test parent directly while keeping plan and do checks on the CLI.
layer: capabilities
