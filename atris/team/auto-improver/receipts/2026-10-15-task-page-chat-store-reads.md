The task page test now runs about 0.32s faster, because its setup chat is recorded straight in the task store and two pairs of reads run at once; it passed 10 of 10 repeat runs, all 437 command tests passed, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: last tick's launch count ranked this test first with 14 launches in a row.

Why it is safe: the chat command is one store call plus a rewrite of the task list file, and the page read right after rewrites that file itself. The test only checked that chat succeeded, so it was setup. The chat command keeps its own CLI test just above this one. The two review pages read the same unchanged store. The certified show and the legacy page read different rows after the last write, so they run together; the show moved below the legacy row seed, and that seed does not touch the certified row. Plan, ready, review, and review chat stay on the CLI and in order.

How the saving was measured:
```text
old: mean 1970ms over 6 runs (1900 to 2022)
new: mean 1650ms over 10 runs (1607 to 1728)
```

Navigation line refs below the edit moved using the exact line mapping from the diff (162 moved; the one on the test's opening line stayed put, since that line only gained the word async).

Rerunnable verification command:
`node --test --test-name-pattern='^task page exposes one-task goal chat stage and review actions$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: 10 of 10 runs passed
commands: tests 437, pass 437, fail 0, exit=0
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: group the reads in the task ready test that holds work in review until a human accepts (14 launches).
layer: capabilities
