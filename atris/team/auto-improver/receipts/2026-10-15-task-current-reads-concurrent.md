The task current test now runs about 1.09s faster, because eleven reads of an unchanged store run in two groups at once; it passed 12 of 12 repeat runs, all 437 command tests passed, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: a count of launches per test ranked this one among the top, with 13 launches. Its name says it checks read-only views, so most launches were reads.

Why it is safe: capabilities builds its answer in memory. Show reads the store and only falls back to the task list file when the store has no row, and it catches any read error there. Current and queue rewrite the task list file. A first guess that the copies are identical was wrong: a direct run showed they differ in the creation timestamp. That timestamp is a fixed-width time string, so every copy has the same length, none of the grouped commands parse the file, and the claim that follows rewrites it whole. The two writes in the test (ready and the claim) stay in order.

How the saving was measured:
```text
old: mean 2031ms over 6 runs (1994 to 2067)
new: mean 945ms over 8 runs (919 to 1008)
```

Navigation line refs below the edit moved using the exact line mapping from the diff (157 moved, none pointed inside the rewritten lines).

Rerunnable verification command:
`node --test --test-name-pattern='^task current returns read-only selected page and queue lanes$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: 12 of 12 runs passed
commands: tests 437, pass 437, fail 0, exit=0
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: group the reads in the task page test, which now has the most back-to-back launches (14).
layer: capabilities
