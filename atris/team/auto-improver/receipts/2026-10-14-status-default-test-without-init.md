The status summary test now skips the full workspace setup, about 0.47s to 0.20s, and checks the task it writes; it passed three runs, failed when the task name changed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-status-default-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^status ' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
exit=0
✔ status default mode renders human summary (200.367416ms)
✔ status default mode renders human summary (203.478791ms)
✔ status default mode renders human summary (201.292ms)
mutated exit=1
    '  Next backlog item: Something else.\n' +
status tests exit=0
ℹ tests 5
ℹ pass 5
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Metric: one init launch removed. Three runs before: 465ms, 468ms, 467ms. Three runs after: 200ms, 203ms, 201ms.

What the test was not checking: status reads tasks from a task database first and reads the TODO file only when no database exists. Test runs share one throwaway database, so status never read the TODO this test wrote; with init it showed the task init seeds, and without init it showed none. The test now gives status a database path of its own that does not exist, so status reads the test's TODO every time, and a new check confirms the queued item is the one the test wrote. Changing that item's name makes the test fail.

Why the shared database matters beyond this test: what status shows here depended on whether the shared database existed when the test ran, which is the kind of order dependence that turns into a flake.

Commands and artifacts: atris mission status; git status; timing the five status tests; a probe comparing status output with and without init; reading how status picks the task source and where the test database lives; three timed runs before and after; a mutation run; all five status tests; frozen verifier; ref shift script with a line match check (10 line numbers, all matched); atris doc-health (exit 0); atris slop detect.

next_push: The status verbose test and the business file test also run a full init; check which init files each reads, give each its own task database path, and drop init where the test can write what it checks.
layer: capabilities
