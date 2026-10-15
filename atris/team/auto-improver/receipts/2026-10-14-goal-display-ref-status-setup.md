# Faster goal display-reference status check setup

The check that task status shows a parent goal's title as the current task's objective now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store parent creation -> unchanged CLI child add by display reference, claim and status read -> required checks -> review.

Only the parent moved in process. Its id, title and display reference come from the stored row, so the objective and lineage assertions compare against what the database holds. The child is still created on the CLI with the parent's display reference, which is the step this test exists to check.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 511.233792 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task status resolves goal_id display refs to parent task objectives' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task status resolves goal_id display refs to parent task objectives (511.233792ms)
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

next_push: Remove the creation launch in the test where accept refreshes an existing rendered task list, keeping its ready, accept and file checks.

layer: capabilities
