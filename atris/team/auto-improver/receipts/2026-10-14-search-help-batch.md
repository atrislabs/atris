# Search help checks run together

Search help checks now run together; the focused test and all 35 frozen health checks passed, exit 0.

## Files

- `test/commands.test.js`: await both help CLI reads together before checking every original output and no-state assertion; cleanup waits for both processes.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: record test route and help early return.
- `atris/team/auto-improver/logs/2026-10-14.md`: append evidence and next move.
- `atris/team/auto-improver/receipts/2026-10-14-search-help-batch.md`: this receipt.

## Proof

Command: `node --test --test-name-pattern='^search help flags print usage without workspace state$' test/commands.test.js`

Before, exit 0:
```text
✔ search help flags print usage without workspace state (2986.168333ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 5240.492083
```

After, exit 0:
```text
✔ search help flags print usage without workspace state (93.246792ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 228.342291
```

Command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 15108.374
```

`git diff --check`: exit 0, no output.

Metric: two sequential launch stages become one; both CLI launches and every assertion remain. Individual timing samples are noisy and do not establish a stable speedup.

Review: searchCommand returns from help before workspace lookup or search. Both processes read no task state and create no workspace or home state. The test waits for both before assertions and cleanup. No production behavior or dependencies changed.

Context: the suggested lineage fixture already had no setup-only readiness launch. Chose the nearby independent help reads instead. Existing unsaved TODO and member log changes were preserved. Brain activate and compile returned plan-only exit 2 without writes. No mission fields changed and no second slice was started. Task proof is in Review; its absolute Node path passed but requires separate review before acceptance. No self-accept was performed.

next_push: batch the independent soul help reads after confirming they return before state creation.

layer: capabilities
