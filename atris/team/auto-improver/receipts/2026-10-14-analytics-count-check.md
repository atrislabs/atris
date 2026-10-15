The analytics completions test now fails when the count is wrong; before, it passed on any count because it only looked for a 2 and today's date always has one. All four analytics tests passed in three runs and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-analytics-count-check.md.

Rerunnable verification command:
`node --test --test-name-pattern='^analytics' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
exit=0 ℹ pass 4 ℹ fail 0
✔ analytics counts completions in journal (96.963208ms)
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Proof the old check was blind and the new one is not. Real analytics output on a journal with one completion:
```text
   Completions: 1
   Total completions: 1
old /2/ passes with one completion: true
new today=2 passes: false | new total=2 passes: false
```
A throwaway copy of the test file with the second completion removed: the tightened test fails, exit 1, pass 0, fail 1, with the output showing Completions: 1. The copy was deleted after the run.

Metric: one test that could not fail on a wrong count can now fail; the fixed 2 is checked on both the today and weekly lines.

Commands and artifacts: atris atris.md; read of the analytics output lines; real analytics run on a one-completion journal; focused tests three times; mutation run; frozen verifier; ref shift script (21 moved, every line matched); atris doc-health (exit 0); atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready.

next_push: Swap the full init for a bare workspace folder in the three visualize tests that write their own journal, after checking which init files visualize reads.
layer: capabilities
