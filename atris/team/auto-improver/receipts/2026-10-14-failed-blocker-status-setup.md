# Faster failed blocker status check setup

The check that a failed task stays out of the review handoff now launches one fewer command, five down to four; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store task creation -> unchanged CLI claim, failed finish, JSON status and text status -> required checks -> review.

Same swap as the previous tick's neighbor test: creating a task on the CLI only stores the row and redraws the task view, which the claim and failed finish redraw again. The claim already used the raw id.

Metric: five CLI launches become four, a 20% reduction. One observed run of the changed test took 572.12325 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task status keeps failed blockers out of review handoff' test/commands.test.js`, exit 0.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task status keeps failed blockers out of review handoff (572.12325ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Required-check output excerpt:
```
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

next_push: In the test where task status keeps history out of the default card, write the creation, claim and eight notes in process with the same records the CLI writes, keeping both status reads on the CLI; that removes up to ten of its twelve launches.

layer: capabilities
