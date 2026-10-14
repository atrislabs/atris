# Faster premature review XP check setup

The check that reviewing a still-open task pays no XP now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation of the open task -> unchanged CLI review, XP status and refused accept -> throwaway probe -> required checks -> review.

The task is seeded through the shared store helper with its tag and no extra metadata, matching a plain add, and the display reference comes from the stored rows. A throwaway copy that seeded the task as done failed with done instead of open, so the open state of the seed is what the test leans on.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 446.595792 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task review does not mint AgentXP before the task is done' test/commands.test.js`, exit 0.
- the same test on a throwaway copy seeding the task as done, exit 1 (actual done, expected open); copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.
- `atris doc-health`: 1040 right, 0 moved, 3 unclear, 0 gone.

Changed-surface output:
```
✔ task review does not mint AgentXP before the task is done (446.595792ms)
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

next_push: In the test where brain compile counts task review episodes as learning state, seed the task in process and keep the review and compile on the CLI.

layer: capabilities
