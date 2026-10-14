# Faster brain scorecard review episode check setup

The check that brain scorecard writes one scorecard from reviewed task episodes, and none on a repeat run, now launches one fewer command, six down to five; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation of the tagged task -> unchanged CLI done, review, both scorecards and compile -> throwaway probe -> required checks -> review.

The task is seeded with its tag through the shared store helper, and the display reference comes from the stored rows. A throwaway copy with a different seeded title failed on the scorecard title check, so the scorecard still reads the seeded task. The edit shifted three refs I wrote earlier today by nine lines; I corrected them and confirmed every ref I own against the file.

Metric: six CLI launches become five, a 17% reduction. One observed run of the changed test took 1482.299167 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='brain scorecard derives deduped scorecards from task review episodes' test/commands.test.js`, exit 0.
- the same test on a throwaway copy with a different seeded title, exit 1 (actual was the other title); copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.
- `atris doc-health`: 1044 right, 0 moved, 3 unclear, 0 gone.

Changed-surface output:
```
✔ brain scorecard derives deduped scorecards from task review episodes (1482.299167ms)
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

next_push: Scan the whole commands test file for tests that still add tasks through the CLI only to set up state, rank them by CLI launches, and seed the creation in the one with the most launches.

layer: capabilities
