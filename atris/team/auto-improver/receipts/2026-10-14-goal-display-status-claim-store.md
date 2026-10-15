# Goal display-reference status setup reduction

The goal status test uses two command launches instead of three. Its focused real CLI check and all 35 required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Plan: inspect -> seed ownership -> focused real CLI check and frozen checks -> review and push.

Change: after the real child-add command resolves the parent display reference, claim the child through production taskStore.claimTask, assert success and close in finally. Child creation and status still use the CLI; every status and lineage assertion remains unchanged.

Commands and real output:
```text
node --test --test-name-pattern='^task status resolves goal_id display refs to parent task objectives$' test/commands.test.js
✔ task status resolves goal_id display refs to parent task objectives (292.115834ms)
tests 1; pass 1; fail 0; skipped 0; duration_ms 423.050584
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
tests 35; pass 35; fail 0; skipped 0; duration_ms 10356.616125
exit 0
```

Metric: one setup subprocess removed, three launches to two (33% fewer). No matched wall-time baseline, so no time saving is claimed.

Lesson: when CLI creation is the contract, keep it and reopen the production store for setup-only ownership before the real status read.

Upkeep: brain activation and compile were plan-only, exit 2; generated files absent and left alone. Pre-existing changes excluded from the commit.

next_push: Remove setup-only ownership launch from the reviewed-failure status test, retaining failed finish and history status on the CLI.
layer: capabilities
