# Accepted-task revision setup reduction

The accepted-task revision refusal test now uses four command launches instead of five. The focused real CLI check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Plan: inspect -> seed ownership -> focused real CLI check and frozen checks -> review and push.

Change: claim through production taskStore.claimTask in the existing database connection, assert success, and close in finally. Readiness, acceptance, rejected revision and XP status still run on the real CLI. All behavioral assertions remain unchanged.

Commands and real output:
```text
node --test --test-name-pattern='^task revise refuses accepted tasks so XP is not stale$' test/commands.test.js
✔ task revise refuses accepted tasks so XP is not stale (607.2305ms)
tests 1; pass 1; fail 0; skipped 0; duration_ms 748.951625
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
tests 35; pass 35; fail 0; skipped 0; duration_ms 11370.385333
exit 0
```

Metric: one setup subprocess removed, five launches to four (20% fewer). No wall-time speedup claimed without a matched baseline.

Lesson: Setup-only ownership can use the production store while accepted-task refusal and reward integrity remain covered through real command invocations.

Setup upkeep: brain activation returned plan-only, exit 2; missing generated brain files were left alone. Pre-existing local changes are excluded from the commit.

next_push: Remove the setup-only claim launch from the goal display-reference status test, retaining child creation by display reference and status assertions.
layer: capabilities
