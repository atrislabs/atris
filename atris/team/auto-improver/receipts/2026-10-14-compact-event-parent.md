The event history test starts one fewer command; the changed test and all 35 required checks passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-compact-event-parent.md.
Plan: direct parent and notes -> real final note, event views and export -> unchanged assertions.
Change: create the unclaimed parent in the same real SQLite connection as its initial notes; preserve title, tag and workspace, assert insertion, and close in finally. All public event and export assertions remain.
Baseline command: node --test --test-name-pattern='task events defaults to a recent compact view' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 663.041208ms, duration_ms 789.818334. Exit: 0.
Changed command: node --test --test-name-pattern='task events defaults to a recent compact view' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 584.899458ms, duration_ms 719.316875. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 10557.096333. Exit: 0.
Metric: command launches reduced from six to five. Single subtest comparison saved 78.14175ms; this is not a stable benchmark.
Review: only fixture creation changed; final CLI note still generates the latest event, all recent and complete-history checks remain. No dependencies or mission fields changed.
Lesson: share a fixture database connection for parent creation and historical notes when the behavior under test is the event reader.
next_push: Seed the dialogue projection test parent directly while keeping note, show and export on the CLI.
layer: capabilities

Proof submission: the installed task runner resolved an older Node without node:sqlite, exit 1. Re-running with the actual supported Node path passed, exit 0, and moved work to Review. Artifact: atris/runs/2026-10-14-task-aic-26-2026-10-14T17-51-55-786Z.json. The automatic second-check allowlist cannot rerun that absolute path; no acceptance was attempted.
Quality: git diff --check returned no output, exit 0. atris slop detect --diff reported clean, no slop tells in 5 files, exit 0. Brain activation and compilation returned optional plan-only output, exit 2; generated policy edits were not applied.
next_push: Seed the dialogue projection test parent directly while keeping note, show and export on the CLI.
layer: capabilities
