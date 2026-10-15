# Faster review debt next check setup

The check that task next points an agent at accepting reviewed work when nothing else is open now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation of the review task -> unchanged CLI claim, ready and next -> throwaway probe -> required checks -> review.

The task is seeded through the same store helper the sibling test uses, and the id and display reference come from the stored rows. A throwaway copy without the ready step failed with ready instead of accept, so the next check still depends on the CLI moving the seeded task into review. The ref checker also moved 10 refs that had drifted in product files before this tick; it now reports 0 moved.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 655.801417 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task next surfaces review debt when no open work exists' test/commands.test.js`, exit 0.
- the same test on a throwaway copy without the ready step, exit 1 (actual ready, expected accept); copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.
- `atris doc-health --fix-refs`, then `atris doc-health`: 1038 right, 0 moved, 3 unclear, 0 gone.

Changed-surface output:
```
✔ task next surfaces review debt when no open work exists (655.801417ms)
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

next_push: Find the next test in the task next or task review area that still creates its tasks through CLI launches only to set up state, and seed that creation in process.

layer: capabilities
