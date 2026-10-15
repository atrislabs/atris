# Faster stale autoland heartbeat ready check setup

The check that task ready stops promising the next autoland pass when the heartbeat is stale now launches two fewer commands, six down to four; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation of both tasks in original order -> unchanged CLI claims and readies -> throwaway probe -> required checks -> review.

Both tasks are seeded before the first claim, matching the sibling test from the last tick. The stale heartbeat file is still backdated three hours, so a faster setup cannot make it look fresh. A throwaway copy that seeded the second task as done failed at its claim, so the CLI steps still act on the seeded rows.

Metric: six CLI launches become four, a 33% reduction. One observed run of the changed test took 904.438875 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task ready uses honest landing copy when autoland heartbeat is stale' test/commands.test.js`, exit 0.
- the same test on a throwaway copy seeding the second task as done, exit 1 (claim returned 1, expected 0); copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.
- `atris doc-health`: 1048 right, 0 moved, 3 unclear, 0 gone.

Changed-surface output:
```
✔ task ready uses honest landing copy when autoland heartbeat is stale (904.438875ms)
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

next_push: Teach the ref checker to follow line refs into test files by the test name on the cited line, so test edits stop silently drifting the notes; every tick in this run had to correct its own refs by hand.

layer: capabilities
