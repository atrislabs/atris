# Faster landing sentence setup

Landing sentence setup now launches three fewer commands; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, rendered `atris/TODO.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

The local seed helper creates each fixture in the real task database at its original point in the test, resolves its display reference, and closes the database before the next CLI claim. Every claim, ready, missing-landing advisory, finish and accepted projection assertion is preserved.

Metric: nine CLI launches become six, a 33% reduction. One observed affected-test duration fell from 1261.769 ms to 871.042 ms; this is a single observation, not a benchmark.

Plan: ordered real-store creation -> unchanged CLI behavior checks -> required checks -> review.

Commands run:
- `node --test --test-name-pattern='task ready and finish accept landing capability sentences' test/commands.test.js` before and after, exit 0 each.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0.
- `git diff --check`, exit 0.

Changed-surface output:
```
✔ task ready and finish accept landing capability sentences (871.041625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1001.850916
```

Required-check output excerpt:
```
✔ an engine benched at error routes again once the window passes, and with no stamp at once (42.060583ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10005.141459
```

Review rerun: `/opt/homebrew/bin/node --test --test-name-pattern='task ready and finish accept landing capability sentences' test/commands.test.js`.

Mission attachment reported a busy lock; no lock or mission fields were changed. A dedicated test task tracks this increment.

next_push: Remove the creation launch in the explicit weak landing rejection test while preserving claim, both rejection calls and claimed-status assertion.

layer: capabilities
