The journal ID test now skips the full workspace setup and runs in about 0.20s instead of 0.44s; it passed in three runs and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-log-ids-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^log assigns sequential IDs' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
exit=0
✔ log assigns sequential IDs across sessions (190.162917ms)
✔ log assigns sequential IDs across sessions (199.319083ms)
✔ log assigns sequential IDs across sessions (221.193833ms)
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: one init launch removed. Three runs before: 454ms, 443ms, 433ms. Three runs after: 190ms, 199ms, 221ms.

Why it is safe: log creates today's journal itself when only the atris folder exists. Two hand runs in a bare folder printed captured I1 and captured I2 and wrote both ideas to the journal, the same lines the test checks.

Map notes: the edit added one line, so eight refs below it moved down one; each old target line matched the new line exactly. Two of those refs were backwards ranges pointing at the wrong tests, so they now point at the unknown command JSON test and the wiki help test. Ten more backwards ranges remain in the notes.

Commands and artifacts: atris mission status; reading the log and status tests and the init helper; two hand runs of atris log in a bare folder; focused test timing before and after; frozen verifier; ref shift script with line match check; atris doc-health (exit 0); atris slop detect on the receipt and notes.

next_push: Repoint the ten backwards line ranges in the map notes at the tests they describe, and find why the ref fixer moved only the start of each range.
layer: capabilities
