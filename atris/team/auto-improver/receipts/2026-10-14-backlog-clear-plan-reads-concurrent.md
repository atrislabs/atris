The backlog and clear-plan test now runs about 0.32s faster, because five of its checks that change nothing run in two groups at once; it passed 5 of 5 plus 8 of 8 timing runs, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: last tick's handoff named this test as the one with the most launches in a row (18). Earlier ticks had already moved its setup into the store, so every launch left is a checked behavior. That made running the launches that change nothing at the same time the remaining win.

Why it is safe: each candidate was read in the code first. A second backlog of a row already in backlog refuses before any write. Status and show only read. The refusal to start work on a demoted row was left in order, because it claims the row for a moment and then rolls the claim back, so a read beside it could see the short-lived claim. The missing-confirm refusal also stayed where it was, so it still runs while planned rows exist.

What changed: the signal row's show and its second backlog refusal run together. The closing status read and the two closing shows run together after every write. Every assertion is unchanged and every launch still runs through the real CLI.

How the saving was measured (old and new versions alternated eight times each):
```text
old: mean 2128ms over 8 runs
new: mean 1810ms over 8 runs (faster in 8 of 8 pairs)
```

Navigation line refs below the edit moved using the exact line mapping from the diff, each checked against the old line's text (154 moved; 1 ref on the test's opening line stayed put and was confirmed by hand).

Rerunnable verification command:
`node --test --test-name-pattern='^task backlog and clear-plan demote only planned open tasks$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: exit=0 pass 1 fail 0 (5 of 5 runs, plus 8 of 8 timing runs)
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: The plan and do headless stage test launches the CLI 16 times in a row, now the most of any test; read each launch and run the ones that change nothing together.
layer: capabilities
