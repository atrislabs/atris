# Faster duplicate receipt repair setup

Duplicate receipt repair setup launches one fewer command, five down to four; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI repair checks -> required checks -> review.

The fixture uses the real task database, resolves its display reference and closes in finally before the CLI claim. Claim, ready, accept, the duplicated receipt line, the repairing status read and the one-line file assertion remain unchanged.

Metric: five CLI launches become four, a 20% reduction. One observed run of the changed test took 1735.799625 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='xp status repairs exact duplicate local XP receipts' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ xp status repairs exact duplicate local XP receipts (1735.799625ms)
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

next_push: Remove the creation launch in the conflicting duplicate receipt test while preserving its claim, accept and fail-closed checks.

layer: capabilities
