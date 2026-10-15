# Reviewed-failure status setup reduction

The reviewed-failure status test uses two command launches instead of three. Its focused real CLI check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Plan: inspect -> seed ownership -> focused real CLI check and frozen checks -> review and push.

Change: claim the seeded task through production taskStore.claimTask in the creation connection, assert success and close in finally. Failed completion and history status still use the CLI; every behavior assertion remains unchanged.

Commands and real output:
```text
node --test --test-name-pattern='^task status treats reviewed failures as closed task health$' test/commands.test.js
✔ task status treats reviewed failures as closed task health (333.817416ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 469.299542
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 9991.11275
exit 0
```

Metric: one setup subprocess removed, three launches to two (33% fewer). No matched timing baseline, so no wall-time saving is claimed.

Lesson: seed setup-only ownership in the same production store connection as creation while retaining real CLI failure and history reads.

Review gate: the bare node command selected an older runtime without node:sqlite (exit 1). Re-running with /opt/homebrew/bin/node passed (exit 0), and the task is ready for human review. The gate could not auto-certify the absolute runtime path.

Upkeep: brain activation and compile were plan-only, exit 2; generated files absent and left alone. Pre-existing changes excluded from the commit.

next_push: Remove setup-only ownership launch from the failed-blocker status test, retaining failed completion and both status reads on the CLI.
layer: capabilities
