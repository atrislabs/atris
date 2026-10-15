The current step check dropped from about 2.69s to 1.9s by putting its side tasks into review through the task store; it passed four runs, a planted bug in how current step picks continue work failed it, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-current-step-side-tasks-store-seeded.md.

Rerunnable verification command:
`PATH="/opt/homebrew/bin:$PATH" node --test --test-name-pattern='^task current-step advances the scoped current task one safe action$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task current-step advances the scoped current task one safe action (1890.139041ms)
✔ task current-step advances the scoped current task one safe action (2062.742625ms)
✔ task current-step advances the scoped current task one safe action (1845.987709ms)
✔ task current-step advances the scoped current task one safe action (1732.3895ms)
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Change: four side tasks only need a review state for current step to choose from. Their four ready runs and two review runs now call the same store functions those commands use. The scoped task still moves through ready and the review chat by command, and every current step call still runs the real command. Six fewer launches.

Why it is safe: the check asserts which task current step picks and why, for each side task: needs an agent check, continue work, waiting on a human, and owned by someone else. Those choices come out the same with store-seeded tasks, so the seeded state is the state current step reads.

Cost: the ready command's policy gates, result trace and saved snapshot file no longer run for these side tasks. Other checks cover the ready and review commands directly.

Proof the check still bites: the rule that picks continue work when a reviewed task has a next task was patched to always pick waiting. The check failed. The source was restored from git and checked clean.

Metric: three runs before with plain git first: 2639ms, 2714ms, 2719ms. Runs after: 1890ms, 2063ms, 1846ms, 1732ms.

Map refs: 110 refs shifted by position from the diff, each matched by line content; the 10 whose text repeats in the file all took the uniform tail shift. 0 mismatches.

next_push: Take the headless task contract check (2.59s), count its command launches, and move the ones that only seed or read saved state to the task store.
layer: capabilities
