# Faster auto-accept confirmation setup

Auto-accept confirmation setup launches one fewer command, fifteen down to fourteen; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI confirmation checks -> required checks -> review.

The fixture uses the real task database, resolves its display reference and closes in finally before the CLI claim. Claim, ready, review, the missing-confirmation and missing-actor refusals, both previews, the confirmed accept and the final status assertions remain unchanged.

Metric: fifteen CLI launches become fourteen, about a 7% reduction. One observed run of the changed test took 2334.465708 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task auto-accept-certified requires explicit human confirmation' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task auto-accept-certified requires explicit human confirmation (2334.465708ms)
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

next_push: Remove the creation launch in the accepted reward idempotency test while preserving its claim, ready, accept and receipt checks.

layer: capabilities
