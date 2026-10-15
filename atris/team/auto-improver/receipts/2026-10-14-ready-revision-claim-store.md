# Ready-work revision setup reduction

The ready-work revision test uses six CLI launches instead of seven. Its focused real CLI check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Change: seed ownership with production taskStore.claimTask in the existing database connection, assert success, and close in finally. Both initial readiness commands, revision, show, stale acceptance and re-readiness remain real CLI calls. All existing assertions are unchanged.

Plan: inspect -> seed ownership -> focused real CLI check and frozen checks -> review and push.

Commands and real output:
```text
node --test --test-name-pattern='^task revise sends ready work back to claimed with revision count$' test/commands.test.js
✔ task revise sends ready work back to claimed with revision count (837.408833ms)
tests 1; pass 1; fail 0; skipped 0; duration_ms 975.847583
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
tests 35; pass 35; fail 0; skipped 0; duration_ms 10630.534541
exit 0
```

Metric: one setup subprocess removed, seven launches to six (14% fewer). No timing speedup claimed without a matched baseline.

Lesson: Use the production store for setup-only ownership while retaining real CLI transitions and every revision safety assertion. The unclaimed revision test retains its CLI claim because claiming after revision is behavior under test.

Setup upkeep: brain activation returned plan-only, exit 2; missing generated brain files were left alone. Existing local changes are preserved and excluded from this commit.

next_push: Remove the setup-only claim launch in the accepted-task revision refusal test, retaining readiness, acceptance, refused revision and XP status checks.
layer: capabilities
