# Faster proof-only acceptance guard setup

Proof-only acceptance guard setup launches 10% fewer commands; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI guard checks -> required checks -> review.

The fixture uses the real task database, resolves its display reference and closes in finally before the CLI claim. Claim, the five blocked acceptance verbs, ready, zero-reward review, review status and pending approval assertions remain unchanged.

Metric: ten CLI launches become nine, a 10% reduction. One observed run of the changed test took 1546.810917 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task proof-only agent env blocks acceptance verbs' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task proof-only agent env blocks acceptance verbs (1546.810917ms)
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

Side note: doc-health reports ten moved refs in unrelated files from earlier drift. This tick left them alone to stay in one slice.

next_push: Remove the creation launch in the next commands test that still adds a task through the CLI only to set up a claim or review check.

layer: capabilities
