The slowest commands test, review-chat verifier extraction, now runs in about 1.98s instead of 2.63s; it passed 3 of 3 and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: the full commands file ran with plain git first on PATH (437 of 437 passed, 150s). This test ranked slowest at 2.34s.

What changed: four cases started the ready command only to read back the command list and the "tested" sentence. Both are built from the proof text alone, and the test already calls those same builders directly. Those four cases now call the builders and skip the task setup and the launch. The first and last cases still run ready on the CLI and prove the builders match what it prints, and every review-chat case still runs on the CLI. CLI launches fall from 14 to 10, with every extraction assertion kept.

Timing (single-test runs, plain git first on PATH):
```text
before: 2666ms 2634ms 2590ms
after:  1975ms 1998ms 1974ms
```

Navigation line refs below the edit moved up 29 lines, each checked against the old line's text (135 moved, 0 skipped); the notes for this test were corrected to its current lines.

Rerunnable verification command:
`node --test --test-name-pattern='^task review-chat extracts only proof-derived verifier commands$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (3 of 3 runs)
verifier: tests 35, pass 35, fail 0, exit=0
git diff --check: exit=0
slop detect on added lines: clean
```

Cost: the four moved cases no longer prove that ready accepts their proofs; the two CLI parity cases still cover that the builders and ready agree.

next_push: Cut the backlog and clear-plan test next (2.19s, second slowest with plain git) by moving its setup-only replans or shows to the task store.
layer: capabilities
