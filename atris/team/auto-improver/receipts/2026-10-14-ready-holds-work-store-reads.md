The check that ready holds work until a human accepts dropped from about 2.62s to 2.28s; it passed three runs, a planted bug where a refused done still finished the task failed it at the new read, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-ready-holds-work-store-reads.md.

Rerunnable verification command:
`PATH="/opt/homebrew/bin:$PATH" node --test --test-name-pattern='^task ready holds work in review until human accept$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task ready holds work in review until human accept (2297.918542ms)
✔ task ready holds work in review until human accept (2276.245208ms)
✔ task ready holds work in review until human accept (2279.545792ms)
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Change: three of the 19 launches only touched saved state. The claim right after the task is added, which nothing asserts on, now goes straight to the task store. The "still in review" read after the refused done now reads the task's status from the store. The final event list now reads the same rows the events command prints for one task: oldest first, up to 500. Every step the check asserts on still runs through the command. Three fewer launches.

Confirmed first: the events command for one task is a plain read of the store's event list with that order and limit. The event list still starts with created then claimed, so the store claim records the same history the command did.

Cost: the claim and events commands are no longer exercised here; the headless task contract check covers both.

Proof the check still bites: the done command was patched to finish the task anyway while still reporting the refusal. The check failed at the new status read, expected review, got done. The source was restored from git and checked clean.

Metric: three runs before with plain git first: 2636ms, 2611ms, 2612ms. Three runs after: 2298ms, 2276ms, 2280ms.

Map refs: 105 refs below the edit shifted by 2, each matched by line content, 0 mismatches.

next_push: Take the current step check (2.60s), count its command launches, and move the ones that only read or seed saved state to the task store.
layer: capabilities
