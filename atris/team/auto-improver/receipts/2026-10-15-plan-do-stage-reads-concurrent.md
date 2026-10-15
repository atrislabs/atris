The plan and do stage test now runs about 0.71s faster, because nine refusals and two reads that change nothing run in two groups at once; it passed 8 of 8 timing runs, all 437 command tests passed, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: last tick's handoff named this test as the one with the most launches in a row (16). Its setup already runs through the store, so every launch left is a checked behavior.

Why it is safe: the store's plan and do checks return before any write when they refuse, including the do path, which only claims a row after the plan check passes. The command only saves the task list file after a success. Show and status only read. The four writes (the outside claim, the plan, the do, and ready) stay in order. One refusal moved: the do against the row someone else claimed now runs after the main plan instead of before it, which is safe because it reads only its own row. The show still finds exactly one plan message and status still counts one plan, which proves the refusals wrote nothing.

How the saving was measured:
```text
old: mean 2301ms over 5 runs (2286 to 2330)
new: mean 1588ms over 8 runs (1506 to 1705)
```

Navigation line refs below the edit moved using the exact line mapping from the diff (163 moved, none pointed inside the rewritten lines).

Rerunnable verification command:
`node --test --test-name-pattern='^task plan and do record an explicit headless stage contract$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: 8 of 8 runs passed
commands: tests 437, pass 437, fail 0, exit=0
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: find the test with the most back-to-back launches left in the command tests and group the ones that change nothing.
layer: capabilities
