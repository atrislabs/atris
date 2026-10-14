The local task factory API check dropped from about 2.49s to 1.77s by putting three side tasks into review through the task store; it passed three runs, a planted bug in the continue work rule failed it right where the seeded task is read, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-factory-api-side-tasks-store-seeded.md.

Rerunnable verification command:
`PATH="/opt/homebrew/bin:$PATH" node --test --test-name-pattern='^task serve exposes a local task factory API$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task serve exposes a local task factory API (1780.687792ms)
✔ task serve exposes a local task factory API (1765.969334ms)
✔ task serve exposes a local task factory API (1755.621041ms)
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Change: the check has 11 command launches next to its server requests. Five of them (three ready runs and two review runs) only put side tasks into a review state for the server's current and queue views to read. They now call the same store functions those commands use. Every server request is unchanged. Five fewer launches.

Why it is safe: the server rebuilds from the store on every request, and the check asserts what current and queue pick for each of these tasks: continue work, waiting on a human, and owned by someone else.

Cost: the ready command's policy gates, result trace and saved snapshot file no longer run for these side tasks. Other checks cover the ready and review commands directly.

Proof the check still bites: the rule that picks continue work when a reviewed task has a next task was patched to always pick waiting. The check failed 13 lines after the seeded continue work task, where the server should pick it and found nothing. The source was restored from git and checked clean.

Left for later: six plan and do launches set up owner tasks for the owner query cases. Plan and do write stage data in more steps, so they are a separate slice.

Metric: three runs before with plain git first: 2375ms, 2563ms, 2543ms. Three runs after: 1781ms, 1766ms, 1756ms.

Map refs: 41 refs shifted by position from the diff, each matched by line content, 0 mismatches.

next_push: Move the six plan and do setup launches in the task factory API check to the task store, after confirming which stage fields the owner query cases read.
layer: capabilities
