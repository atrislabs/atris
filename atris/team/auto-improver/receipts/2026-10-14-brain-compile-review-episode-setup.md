# Faster brain compile review episode check setup

The check that brain compile counts reviewed task episodes as learning state now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation of the untagged task -> unchanged CLI done, review and compile -> throwaway probe -> required checks -> review.

A plain add with no tag stores no tag and no metadata, so the seed passes neither. The add also wrote the task list file, but the done step rewrites it right after, so nothing the compile reads is lost. A throwaway copy without the done step failed with one episode row instead of two, so both rows still come from real CLI steps on the seeded task.

The ref checker does not track line refs into test files. This edit shifted three refs I wrote in earlier ticks today; I corrected those by hand and confirmed each line. Older test refs in the notes have drifted the same way and were left alone.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 757.243833 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='brain compile counts task review episodes as learning state' test/commands.test.js`, exit 0.
- the same test on a throwaway copy without the done step, exit 1 (actual 1, expected 2); copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.
- `atris doc-health`: 1042 right, 0 moved, 3 unclear, 0 gone.

Changed-surface output:
```
✔ brain compile counts task review episodes as learning state (757.243833ms)
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

next_push: In the test where brain scorecard derives deduped scorecards from task review episodes, seed the task in process and keep the done, reviews and scorecard on the CLI.

layer: capabilities
