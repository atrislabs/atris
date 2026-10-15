# Dialogue parent setup

The dialogue test now launches six commands instead of seven; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-dialogue-parent.md.
Plan: direct parent setup -> real note, show and export commands -> unchanged assertions.
Change: insert the unclaimed parent through the real SQLite task store with the same title, tag and workspace. Compute its display reference with the existing task-store helper and close the connection in finally. All dialogue, version, large JSON pipe and export assertions remain.
Baseline command: node --test --test-name-pattern='task note, show, and export expose a dialogue projection' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 897.436292ms, duration_ms 1029.933917. Exit: 0.
Initial changed run: exit 1 because getTask returns the raw row without a display reference; repaired by using withTaskDisplayRefs, the real reference helper.
Changed command: node --test --test-name-pattern='task note, show, and export expose a dialogue projection' test/commands.test.js
Output: tests 1, pass 1, fail 0, cancelled 0, skipped 0, todo 0, subtest 760.511042ms, duration_ms 892.487709. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 9833.264167. Exit: 0.
Metric: command launches reduced from seven to six. The single subtest comparison saved 136.92525ms, not a stable benchmark.
Review: only parent setup changed; all six behavior commands and all prior assertions remain. No dependencies or mission fields changed.
Lesson: raw task rows lack display references; fixture setup should use the same reference helper as the task command.
next_push: Seed the RSI review test parent directly while keeping done, review and event checks on the CLI.
layer: capabilities
