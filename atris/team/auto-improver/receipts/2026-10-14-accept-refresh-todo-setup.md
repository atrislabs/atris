# Faster accept refresh task list check setup

The check that accepting a task refreshes an existing rendered task list now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store task creation -> unchanged CLI ready and accept -> file read -> required checks -> review.

Only creation moved in process. Seeding never writes the task list file, so it still holds the empty starting view until the CLI runs; the one completed entry the test reads can only come from the ready and accept launches that remain.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 571.828166 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task accept refreshes existing rendered todo view' test/commands.test.js`, exit 0.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task accept refreshes existing rendered todo view (571.828166ms)
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

next_push: In the task lineage test, create the parent and child in process and keep both lineage reads and the no-git read on the CLI.

layer: capabilities
