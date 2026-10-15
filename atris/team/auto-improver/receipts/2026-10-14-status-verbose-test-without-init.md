The status board test now skips the full workspace setup, about 0.45s to 0.18s, and checks the task it writes; it passed three runs, failed when the task name changed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-status-verbose-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^status ' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
exit=0
✔ status verbose mode keeps the legacy task board (181.895667ms)
✔ status verbose mode keeps the legacy task board (179.198375ms)
✔ status verbose mode keeps the legacy task board (183.205875ms)
mutated exit=1
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Implement feature X/.
status tests exit=0
ℹ tests 5
ℹ pass 5
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Metric: one init launch removed. Three runs before: 471ms, 443ms, 448ms. Three runs after: 182ms, 179ms, 183ms.

How: same shape as the status summary test last tick. The test makes only the atris folder, writes a one-item TODO, and gives status a task database path of its own that does not exist, so the board reads that TODO and not the shared test database. A new check confirms the board shows the item the test wrote; before, the test only checked that some board was drawn.

Honest note: the first mutation attempt did not apply because of shell escaping, and the failure it seemed to show came from last tick's leftover output file. I deleted the old file and reran the mutation from a script file; that real run is the one above.

Commands and artifacts: atris mission status; git status; timing both remaining status tests; reading the status entry, verbose board path, and fresh folder check; three timed runs before and after; a mutation run; all five status tests; frozen verifier; ref shift script with a line match check (8 line numbers, all matched); atris doc-health (exit 0); atris slop detect.

next_push: The business file test is the last status test that runs a full init; check whether its claim line needs the task init seeds, and if so seed that task in process instead of running init.
layer: capabilities
