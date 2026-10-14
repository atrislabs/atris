# Faster tampered receipt ledger check setup

The check that an edited reward receipt makes the status read fail closed now launches one fewer command, five down to four; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI claim, ready, accept and tampered read -> required checks -> review.

The fixture creates its task in the real task database, resolves its display reference and closes in finally before the CLI claim. The accept total of one, the edited receipt, the tampered status, zero totals, the leaderboard block and the hash mismatch error are all unchanged.

Metric: five CLI launches become four, a 20% reduction. One observed run of the changed test took 1142.449666 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='xp status fails closed when local receipt ledger is tampered' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ xp status fails closed when local receipt ledger is tampered (1142.449666ms)
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

next_push: Remove the creation launch in the test where revising ready work sends it back to claimed, keeping its claim, ready, revise and revision count checks.

layer: capabilities
