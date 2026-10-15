# Faster autoland ready handoff check setup

The check that task ready gives the right autoland handoff wording, in JSON, in text, and for a verifier autoland cannot rerun, now launches three fewer commands, nine down to six; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: rank every test that still adds tasks through the CLI -> pick the top setup-only one -> real-store creation of its three tasks in original order -> unchanged CLI claims and readies -> throwaway probe -> required checks -> review.

The ranking found 16 tests that still add through the CLI. This one had the most adds, three. Tests that check add itself, such as the headless contract and the add warning, were left alone on purpose. All three tasks are now seeded before the first claim; each claim and ready names its own task, so the earlier existence of the other two rows changes nothing those steps check. A throwaway copy that seeded the first task as done failed at its claim, so the CLI steps still act on the seeded rows.

Metric: nine CLI launches become six, a 33% reduction. One observed run of the changed test took 1366.347041 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task ready uses autoland-aware handoff copy when policy is on' test/commands.test.js`, exit 0.
- the same test on a throwaway copy seeding the first task as done, exit 1 (claim returned 1, expected 0); copy removed.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.
- `atris doc-health`: 1046 right, 0 moved, 3 unclear, 0 gone.

Changed-surface output:
```
✔ task ready uses autoland-aware handoff copy when policy is on (1366.347041ms)
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

next_push: In the sibling test where task ready uses honest landing copy when the autoland heartbeat is stale, seed both tasks in creation order and keep every claim and ready on the CLI.

layer: capabilities
