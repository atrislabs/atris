# Faster duplicate reward review setup

Duplicate reward review setup launches one fewer command, six down to five; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI reward checks -> required checks -> review.

The fixture uses the real task database, resolves its display reference and closes in finally before the CLI claim. Claim, ready, accept, the second review, its compact reward summary and the final XP status assertions remain unchanged.

Metric: six CLI launches become five, about a 17% reduction. One observed run of the changed test took 1903.138958 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task review after acceptance cannot mint duplicate AgentXP' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task review after acceptance cannot mint duplicate AgentXP (1903.138958ms)
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

next_push: Remove the creation launch in the duplicate reward receipt repair test while preserving its claim, accept and repair checks.

layer: capabilities
