The test where ready work waits in review for a human now runs about 0.21s faster, because the early done refusal, the certified show and the status read run at once; it passed 10 of 10 repeat runs, all 437 command tests passed, and all 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

How the target was picked: last tick's launch count ranked this test first with 14 launches in a row.

Why it is safe: the done refusal runs one update that only matches open or claimed rows; the row is in review, so nothing changes and no event is added. Show only reads. Status rewrites the task list file with a fixed-width timestamp, and neither other command parses that file. The ten padding notes moved up ahead of these three; they touch none of the lines the show and status checks read, and the event order check at the end still passes because the refusal and reads add no events. Every write that is checked stays on the CLI and in order.

Small win: this test is mostly writes, so only one group was safe. A ranking of the full run by time shows the slowest command tests are worktree ship, member run, and the bulk auto-accept sweep, each about 5 to 6 seconds, so the next ticks should go by measured time instead of launch count.

How the saving was measured:
```text
old: mean 2985ms over 6 runs (2936 to 3053)
new: mean 2774ms over 10 runs (2726 to 2851)
```

Navigation line refs below the edit moved using the exact line mapping from the diff (147 moved; the two on the test's opening line stayed put, since that line only gained the word async).

Rerunnable verification command:
`node --test --test-name-pattern='^task ready holds work in review until human accept$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
focused: 10 of 10 runs passed
commands: tests 437, pass 437, fail 0, exit=0
verifier: tests 35, pass 35, fail 0, exit=0
```

next_push: speed up the bulk auto-accept sweep test (about 6 seconds), the slowest command test that does not drive git or a member run.
layer: capabilities
