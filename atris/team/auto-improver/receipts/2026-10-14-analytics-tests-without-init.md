Two analytics tests now skip the full workspace setup, 0.85s to 0.33s together; both passed in three runs and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-analytics-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^analytics' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare, exit 0 for both. Actual output excerpt:
```text
commands.test.js exit=0 ℹ pass 2 ℹ fail 0 ℹ duration_ms 327.103584
✔ analytics counts completions in journal (95.835ms)
✔ analytics counts inbox items when Inbox is last section (88.261459ms)
frozen_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Metric: two init launches removed, about 260ms each. Three runs each against the previous version of the file: about 0.85s before and 0.33s after for the two tests.

Why only two of three: init writes today's journal with nothing counted, and analytics reads only the workspace folder and the last seven daily journals. The completions and inbox tests write today's journal themselves, which replaces init's, so init gave them nothing. The fresh-workspace test keeps init, because without it the test would pass with no journal at all and stop proving that a new workspace reads as zero.

Found while reading: the completions test only checks that the digit 2 appears somewhere in the output, and today's date always contains a 2, so it would pass with a wrong count. Left for the next tick to keep this one bounded.

Commands and artifacts: atris atris.md; read of the analytics command; a real init in a temp folder to see the journal it writes (zero completions, zero inbox); focused tests; timing of old and new versions; frozen verifier; ref shift script (21 moved, every line matched); atris doc-health (exit 0); atris slop detect atris/refs/MAP-NOTES.md (clean); task new/claim/ready.

next_push: Tighten the analytics completions test to check the completion count itself, since a bare 2 always matches today's date.
layer: capabilities
