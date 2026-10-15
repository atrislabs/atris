# Faster reward rejection setup

Reward rejection setup launches 20% fewer commands; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI rejection checks -> required checks -> review.

The fixture uses the real task database, resolves its display reference and closes in finally before the CLI claim. Claim, ready, zero-reward rejection, review status and pending approval assertions remain unchanged.

Metric: five CLI launches become four, a 20% reduction. One observed affected-test duration fell from 1089.535708 ms to 648.072125 ms; this is a single observation, not a benchmark.

Commands run:
- `node --test --test-name-pattern='task accept rejects non-positive rewards' test/commands.test.js` before and after, exit 0 each.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0.

Changed-surface output:
```
✔ task accept rejects non-positive rewards before marking done (648.072125ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 797.316791
```

Required-check output excerpt:
```
✔ an engine benched at error routes again once the window passes, and with no stamp at once (68.718375ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10329.223708
```

Review rerun: `/opt/homebrew/bin/node --test --test-name-pattern='task accept rejects non-positive rewards' test/commands.test.js`.

Brain activation returned a plan with exit 2; its listed optional files are absent. No policy or mission fields were changed.

next_push: Remove the creation launch in the proof-only acceptance guard test while preserving all command-line acceptance and review checks.

layer: capabilities
