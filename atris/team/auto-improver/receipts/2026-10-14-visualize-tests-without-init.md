Three visualize tests now skip the full workspace setup, 1.22s to 0.41s together; all three passed in three runs and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-visualize-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^visualize' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
commands.test.js exit=0 ℹ pass 3 ℹ fail 0 ℹ duration_ms 415.514334
✔ visualize exits 1 when no journal exists (93.004291ms)
✔ visualize exits 1 when inbox is empty (90.222208ms)
✔ visualize renders breakdown for inbox items (90.007583ms)
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: three init launches removed. Three runs each against the previous version of the file: about 1.22s before and 0.41s after for the three tests.

Why these three and not the dry runs: visualize without a prompt reads only today's journal, found by a plain path lookup. The two inbox tests write that journal themselves. The no-journal test ran init and then deleted the journal init wrote, leaving an empty logs folder, so it now makes that folder directly. The two dry-run tests keep init because a dry run reads workspace context from files init writes.

Commands and artifacts: atris atris.md; read of the visualize entry, inbox path and journal path lookup; focused tests; timing of old and new versions; frozen verifier; ref shift script (20 moved up by five, every line matched, none inside the removed lines); atris doc-health (exit 0); atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready.

next_push: Check the two log tests and the status default test for init files they never read, and swap the full init for a bare workspace folder where the test writes everything it checks.
layer: capabilities
