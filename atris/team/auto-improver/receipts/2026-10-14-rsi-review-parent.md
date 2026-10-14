# RSI review parent setup

The RSI review test now launches three commands instead of four; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-rsi-review-parent.md.
Plan: direct parent setup -> real done, review and events commands -> unchanged assertions.
Change: insert the unclaimed parent through the real SQLite task store with the same title, tag and workspace. Compute its display reference with the existing task-store helper and close the connection in finally. The version 4 review line, event line, two-episode count and every episode field check remain.
Baseline command: node --test --test-name-pattern='task review writes a reviewed event and RSI episode jsonl' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 608.695042ms, duration_ms 751.260208. Exit: 0.
Changed command: node --test --test-name-pattern='task review writes a reviewed event and RSI episode jsonl' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 491.029333ms, duration_ms 633.908833. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 26388.918208. Exit: 0.
Metric: command launches reduced from four to three. The single subtest comparison saved 117.665709ms, not a stable benchmark.
Review: only parent setup changed; done, review and events still run the CLI and all prior assertions remain. No dependencies or mission fields changed.
Lesson: direct parent setup keeps the same event version numbering, so later version checks need no edits.
next_push: Seed the proof-event test parent in the next test directly while keeping done and show checks on the CLI.
layer: capabilities
