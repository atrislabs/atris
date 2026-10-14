# Faster continue-work certified review check setup

The check that continuing work after a certified review creates one goal-scoped next task now launches one fewer command; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store parent creation with tag and goal link -> unchanged CLI ready, review, both continue-work calls and scoped current -> link removal probe -> required checks -> review.

The parent's id comes from the seed and its display reference from the stored rows, which is all the later commands and assertions use. A throwaway copy without the goal link failed, which shows the next task's goal check still depends on it. The copy was deleted.

Metric: one creation launch removed. One observed run of the changed test took 910.816417 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task continue-work creates the certified review next task' test/commands.test.js`, exit 0.
- Probe copy without the goal link: `✖ task continue-work creates the certified review next task`, pass 0, fail 1; copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task continue-work creates the certified review next task (910.816417ms)
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

next_push: In the test where task next names accept for uncertified review, seed both tasks in creation order in process and keep the claim, ready, next and both shows on the CLI.

layer: capabilities
