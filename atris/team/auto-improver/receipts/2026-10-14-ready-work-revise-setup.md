# Faster ready-work revise check setup

The check that a human revise sends ready work back to claimed now launches one fewer command, eight down to seven; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI claim, readies, revise, show, stale accept and re-ready -> required checks -> review.

The fixture creates its task in the real task database, resolves its display reference and closes in finally before the CLI claim. The revise payload, cleared proof and certification, the refused stale accept and the fresh review pass count are all unchanged.

Metric: eight CLI launches become seven, a 12.5% reduction. One observed run of the changed test took 1478.40925 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task revise sends ready work back to claimed' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task revise sends ready work back to claimed with revision count (1478.40925ms)
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

next_push: Remove the creation launch in the test where revising unclaimed ready work returns it to open, keeping its ready, revise and claim checks.

layer: capabilities
