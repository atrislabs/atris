# Faster review create-next goal scope check setup

The check that creating the next task from a review keeps the goal now launches one fewer command, three down to two; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation with tag and goal link -> unchanged CLI finish with create-next and goal-scoped current read -> link removal probe -> required checks -> review.

Creating a task with a goal only stores the goal id on the task, so the seed writes that same link. A throwaway copy without the link failed, which shows the next task's goal check and the scoped pick still depend on it. The copy was deleted.

Metric: three CLI launches become two, a 33% reduction. One observed run of the changed test took 343.895083 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task review create-next preserves goal scope' test/commands.test.js`, exit 0.
- Probe copy without the goal link: `✖ task review create-next preserves goal scope`, pass 0, fail 1; copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task review create-next preserves goal scope (343.895083ms)
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

next_push: In the test where continue-work creates the certified review next task, seed the goal-linked parent in process and keep ready, review and continue-work on the CLI.

layer: capabilities
