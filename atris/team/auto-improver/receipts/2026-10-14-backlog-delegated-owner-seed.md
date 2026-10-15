The backlog cleanup test now runs about 0.15s faster with one fewer command launch; it passed 5 of 5 and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

What changed: the test started the delegate command only to create a row owned by someone else, then checked that backlog keeps that owner. The row is now written straight to the task store with the same two owner fields delegate writes. Delegate itself is still checked by its own tests elsewhere. Backlog, the show that proves the owner survived, and every cleanup check still run through the real CLI. Launches fall from 19 to 18.

How the saving was measured: timing each launch showed about 110ms per launch, and 2.06s of the 2.27s run was launches. One launch is smaller than the run-to-run swing, so I alternated the old and new test eight times each with plain git first on PATH:
```text
old: mean 2504ms over 8 runs
new: mean 2355ms over 8 runs
```

Navigation line refs below the edit moved down 8 lines, each checked against the old line's text (150 moved, 0 skipped); this test's notes now point at its current lines.

Rerunnable verification command:
`node --test --test-name-pattern='^task backlog and clear-plan demote only planned open tasks$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (5 of 5 runs)
verifier: tests 35, pass 35, fail 0, exit=0
git diff --check: exit=0
slop detect on added lines: clean
```

next_push: Cut the review-before-human-accept test next (about 2.0s, third slowest with plain git) by timing its launches first and moving only setup-only ones to the task store.
layer: capabilities
