# Faster accepted-task revise refusal check setup

The check that revise is refused on accepted work now launches one fewer command, six down to five; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI claim, ready, accept, refused revise and status read -> required checks -> review.

The fixture creates its task in the real task database, resolves its display reference and closes in finally before the CLI claim. The reward total of one after accept, the refusal exit code and reason, and the unchanged total afterward are all kept.

Metric: six CLI launches become five, about a 17% reduction. One observed run of the changed test took 1135.342375 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task revise refuses accepted tasks' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task revise refuses accepted tasks so XP is not stale (1135.342375ms)
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

next_push: Remove the creation launch in the test where a claim on already-claimed work never suggests a next task, keeping both claims and the no-suggestion checks.

layer: capabilities
