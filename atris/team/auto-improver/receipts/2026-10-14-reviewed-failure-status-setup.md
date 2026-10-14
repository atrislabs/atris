# Faster reviewed failure status check setup

The check that task status counts a reviewed failed task as closed now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store task creation -> unchanged CLI claim, failed finish and status read -> required checks -> review.

Creating a task on the CLI only stores the row and redraws the task view, and the claim and failed finish redraw that view again, so nothing the status read sees depends on the creation launch. The claim already used the raw id, so no display reference lookup is needed.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 546.973667 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task status treats reviewed failures as closed task health' test/commands.test.js`, exit 0.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task status treats reviewed failures as closed task health (546.973667ms)
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

next_push: In the test where task status keeps failed blockers out of the review handoff, create the task in process and keep the claim, failed finish and both status reads on the CLI.

layer: capabilities
