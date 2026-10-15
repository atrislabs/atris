The follow-up drain test starts two fewer commands; its behavior check and all 35 required tests passed, exit 0.

Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands regenerate atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-follow-up-drain-parents.md.
Plan: direct parent setup -> real continuation and drain commands -> unchanged assertions.
Change: seed both unclaimed parents through the real SQLite task store, preserving workspace, tag, goal metadata and display references. Check insertion and references and close the store in finally. Every ready, review, continuation, drain, status and current assertion stays on the CLI.
Baseline command: node --test --test-name-pattern='task review-lane-drain skips continue-work rows with existing follow-up children' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 1718.673458ms, duration_ms 1847.370958. Exit: 0.
Changed command: node --test --test-name-pattern='task review-lane-drain skips continue-work rows with existing follow-up children' test/commands.test.js
Output: tests 1, pass 1, fail 0, subtest 1432.650583ms, duration_ms 1565.165083. Exit: 0.
Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 10008.536. Exit: 0.
Metric: command launches reduced from twelve to ten. Single subtest comparison saved 286.022875ms, about 17%; this is not a stable benchmark.
Review: fixture setup is the only code change. Actual child creation, reuse after retitling, completed-child exclusion, and public command output retain all assertions. No dependencies or mission fields changed.
Lesson: seed parent rows directly while leaving child creation and reuse on the CLI when child identity is the behavior under test.
next_push: Seed the task events compact-view parent directly while keeping the final note and both event output checks on the CLI.
layer: capabilities

Proof submission: saved targeted invocation passed, exit 0, and work moved to Review. Artifact: atris/runs/2026-10-14-task-aic-25-2026-10-14T17-49-58-895Z.json. The automatic second-check allowlist cannot rerun the absolute Node path; no acceptance was attempted.
Quality: git diff --check returned no output, exit 0. atris slop detect --diff reported clean, no slop tells in 5 files, exit 0. Brain activation and compilation returned optional plan-only output, exit 2; generated policy edits were not applied.
next_push: Seed the task events compact-view parent directly while keeping the final note and both event output checks on the CLI.
layer: capabilities
