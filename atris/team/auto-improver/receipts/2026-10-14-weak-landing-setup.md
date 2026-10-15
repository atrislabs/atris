# Faster weak landing rejection setup

Weak landing rejection setup launches one fewer command; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI rejection checks -> required checks -> review.

The fixture uses the real task database, resolves its display reference and closes in finally before the CLI claim. Both rejection calls and the final CLI show assertion remain unchanged.

Metric: five CLI launches become four, a 20% reduction. One observed affected-test duration fell from 629.289125 ms to 513.65925 ms; this is a single observation, not a benchmark.

Commands run:
- `node --test --test-name-pattern='task ready rejects an explicit landing sentence' test/commands.test.js` before and after, exit 0 each.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0.
- `git diff --check`, exit 0.

Changed-surface output:
```
✔ task ready rejects an explicit landing sentence a day-one PM cannot act on before review (513.65925ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 648.180375
```

Required-check output excerpt:
```
✔ an engine benched at error routes again once the window passes, and with no stamp at once (41.784541ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10058.526375
```

Review rerun: `/opt/homebrew/bin/node --test --test-name-pattern='task ready rejects an explicit landing sentence' test/commands.test.js`.

The brain activation command returned a plan with exit 2; its listed optional files are absent. No policy or mission fields were changed.

next_push: Remove the creation launch in the non-positive reward rejection test while preserving claim, ready, rejection and review-status assertions.

layer: capabilities
