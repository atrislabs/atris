The status business file test now seeds its one task directly instead of running a full workspace setup, about 0.89s to 0.33s alone, and checks the task it seeds; it passed three runs, failed when the title changed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-status-business-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^status ' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
exit=0
✔ status stays local even when .atris/business.json exists (280.800875ms)
✔ status stays local even when .atris/business.json exists (368.502833ms)
✔ status stays local even when .atris/business.json exists (328.593667ms)
mutated exit=1
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /"ship the local status check" is ready to claim/i.
status tests exit=0
ℹ tests 5
ℹ pass 5
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Metric: one init launch removed. Three solo runs before: 875ms, 888ms, 903ms. Three solo runs after: 281ms, 369ms, 329ms. Run with the other status tests the gap is smaller, because the first test in a run pays the file load.

How: the claim line needs one open task in this folder. The test now makes only the atris folder, seeds one open task into a database of its own the same way other tests in the file do, and points status at that database. A new check confirms the claim line names the seeded task; before, the line could name whatever task init seeded. The business file is still written, and the test still checks status shows no sync line.

All five status tests now run without init. This finishes the status handoff from the last three ticks.

Commands and artifacts: atris mission status; git status; reading the claim check and the in-process seed pattern; solo timing before and after; one failing run that showed status lowercases the title, fixed with a case-insensitive check; a mutation run; all five status tests; frozen verifier; ref shift script with a line match check (8 line numbers, all matched); atris doc-health (exit 0); atris slop detect.

next_push: Count the tests in the command test file that still run a full init, rank them by time, and take the slowest one whose checks only read files the test can write itself.
layer: capabilities
