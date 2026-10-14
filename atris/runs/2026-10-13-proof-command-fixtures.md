# Proof-command fixture setup

The proof-command extraction check removes 90 redundant CLI launches, while keeping all 46 proof inputs and every real ready/review-chat call and parsing assertion. The first case retains CLI new/claim coverage; the other 45 use production addTask/claimTask against the same real SQLite database. Titles, actor, and canonical workspace path remain equivalent. No mocks, timeouts, skips, or expected parsing results changed.

Plan: measure -> seed real claimed fixtures -> rerun -> record -> commit and push.

Changed files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; this receipt; own entry in atris/team/auto-improver/logs/2026-10-13.md.

Rerun: `node --test test/commands.test.js`
Focused command: `node --test --test-name-pattern='task review-chat extracts only proof-derived verifier commands' test/commands.test.js`
Frozen check: `git diff --check`.

## Focused measurements

Three baseline runs exited 0. Three corrected runs exited 0. Median whole process: 28760.286ms -> 18022.272ms, measured 37.3% faster. Other tests and unrelated machine activity overlapped some measurements, so this is an observed change rather than a controlled causal estimate. The deterministic reduction is 90 process launches per focused check. No baseline flakiness was observed.

### before 1, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (28651.042334ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28760.286042
```

### before-2, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (31258.518917ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31442.299792
```

### before-3, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (28113.72975ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28268.5315
```

### after-3, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (21775.184084ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21965.399542
```

### after-4, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (17832.323291ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18022.27175
```

### after-5, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (16331.037625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16512.6685
```

## Full-file proof

Command: `node --test test/commands.test.js`. Before and after both exited 0. Whole-file elapsed 244584.776ms -> 193232.315ms is noisy, with unrelated machine work and overlapping focused measurements; no causal whole-file percentage claimed.

### full-before, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (34420.464ms)
✔ task lineage (477.220792ms)
ℹ tests 437
ℹ suites 0
ℹ pass 437
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 244584.775709
```

### full-after, exit 0

```text
✔ task review-chat extracts only proof-derived verifier commands (12541.37275ms)
✔ task lineage (853.501209ms)
ℹ tests 437
ℹ suites 0
ℹ pass 437
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 193232.315333
```

## Corrections during implementation

Two intermediate fixture trials failed: a raw task id yielded a null task payload, and a display reference still failed lookup. Both exposed a single fixture mismatch: the CLI canonicalizes macOS /tmp to /private/tmp, while the first helper stored the unresolved workspace. The corrected helper uses fs.realpathSync for both task insertion and reference lookup. Both failures were retained in /tmp/atris-proof-extraction-tick6/after-1.txt and after-2.txt and are not included as passing timings.

A mechanical comparison normalized only creation/claim fixture statements and removed the helper, then asserted the remaining test bodies were byte-identical: exit 0, output `All 46 proof inputs and every ready/review-chat call and parsing assertion are unchanged.`

Brain activation and compile were invoked without --yes; both were plan-only, with no adapter or policy writes.

next_push: reduce repeated sample-task setup in the slow review-group cap check while retaining its real CLI cap assertions.
layer: capabilities

## Tick 7 rerun

The tick that wrote this receipt timed out before committing. Tick 7 reran the focused command three times against the old file and three times against the new one, alternating, all exit 0 with pass 1 fail 0.

Before: 38.88s, 31.63s, 34.51s. After: 18.72s, 19.06s, 20.89s. Median 34.51s -> 19.06s, about 45% faster.
