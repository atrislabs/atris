# Faster status history check setup

The check that the default task status card leaves out history now launches ten fewer commands, twelve down to two; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: read what create, claim and note each write -> write the same records in process -> unchanged CLI live and history status reads -> fewer-notes probe -> required checks -> review.

The claim and note commands each make one store call and then redraw the task view, so the seed makes those same calls: one task, one claim by the same agent, and eight notes. A throwaway copy that seeded seven notes failed the history count, which shows the history view still reads the seeded events and the check did not go hollow. The copy was deleted.

Metric: twelve CLI launches become two, an 83% reduction. One observed run of the changed test took 357.204417 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task status keeps history out of the default live card' test/commands.test.js`, exit 0.
- Probe copy with seven notes: `✖ task status keeps history out of the default live card`, pass 0, fail 1; copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task status keeps history out of the default live card (357.204417ms)
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

next_push: In the test where creating the next task from a review keeps the goal scope, seed the first task with its tag and goal link in process and keep the finish and scoped current read on the CLI.

layer: capabilities
