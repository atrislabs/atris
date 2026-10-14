# Faster conflicting receipt check setup

The check that conflicting duplicate receipts stop the reward status read now launches one fewer command, five down to four; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI claim, ready, accept and fail-closed read -> required checks -> review.

The fixture creates its task in the real task database, resolves its display reference and closes in finally before the CLI claim. The conflicting receipt write, the tampered status, zero total, the readable title label and the missing raw review id assertion are unchanged, so the label check still proves the title flows from the task row into the receipt.

Metric: five CLI launches become four, a 20% reduction. One observed run of the changed test took 2486.076458 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='xp status fails closed on conflicting duplicate receipts' test/commands.test.js`, exit 0, run without a pipe for the status.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ xp status fails closed on conflicting duplicate receipts with readable labels (2486.076458ms)
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

next_push: Remove the creation launch in the tampered receipt ledger test while preserving its claim, ready, accept and tamper checks.

layer: capabilities
