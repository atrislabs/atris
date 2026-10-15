# Faster already-claimed claim check setup

The check that a refused claim on someone else's task never suggests a next task now launches one fewer command, three down to two; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI claims -> required checks -> review.

The fixture creates its task in the real task database, resolves its display reference and closes in finally before the first CLI claim. The second agent's claim, its conflict reason and the empty next-task suggestion are unchanged.

Metric: three CLI launches become two, about a 33% reduction. One observed run of the changed test took 364.808417 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='claiming a task that is only already_claimed' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ claiming a task that is only already_claimed (not already_done) never suggests a next task (364.808417ms)
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

next_push: In the test where task status resolves goal display references, create only the parent task in process and keep the child creation on the CLI, since that command is what turns the display reference into a parent link.

layer: capabilities
