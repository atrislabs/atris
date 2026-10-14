The two endgame scorecard writer tests now skip the full workspace setup, about 0.27s to under 0.01s each, and the writer test now checks the attempted count and that no lessons were counted; both passed three runs, a stray lesson in a mutant copy failed the new check, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-scorecard-writer-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^maybeWriteCompletedEndgameScorecard' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
writer tests exit=0
ℹ tests 2
ℹ pass 2
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: a temporary copy of the test file that wrote one lesson dated today before the scorecard was built failed with actual 1, expected 0. The copy was deleted.

Metric: two init launches removed. Three runs before, both tests together: 690ms, 687ms, 676ms. Three runs after: 145ms, 149ms, 147ms.

Why it is safe: the writer reads only the to-do list, today's log, an optional lessons file, and the scorecards file it writes. Each test writes its own to-do list, and the first writes its own log, so they now make only the atris folder. The first test controls every input, so it now checks the full scorecard line: one shipped of one attempted, reward 6, zero lessons. The review test already fails if review work counts as done.

Commands and artifacts: atris mission status; git status; reading the writer, the completion check, the scorecard builder, and the lessons counter; three timed runs before and after; a mutant run; both tests; frozen verifier; two line refs moved down two lines in MAP-NOTES and checked against the test file; atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 16; the task-specific verify command test just above the writer tests is the next to check.
layer: capabilities
