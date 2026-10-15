The five endgame scoring tests now skip the full workspace setup, about 0.27s to near zero each, and the two fallback tests now check which fallback they reached; all six scoring tests passed three runs, a mutant without the atris folder failed the new check, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-endgame-scoring-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^scoreEndgameCandidates' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
scoring tests exit=0
ℹ tests 6
ℹ pass 6
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: a temporary copy of the test file with the atris folder removed from the no-scorecards test failed with actual 'no atris folder', expected 'no scorecards'. Before this change that test passed either way, because both fallbacks pick the same candidate. The copy was deleted.

Metric: five init launches removed. Three runs before, all six scoring tests together: 1496ms, 1517ms, 1491ms. Three runs after: 162ms, 162ms, 161ms.

Why it is safe: the scorer reads only whether the atris folder exists and the scorecards file under it. The scorecard path helper creates its own private folder, so each test now makes only the atris folder and writes the scorecards it asserts on. The two fallback tests now require the reason to say no scorecards, so they fail if the folder is missing or the malformed line ever starts parsing.

Commands and artifacts: atris mission status; git status; a list of the 23 tests that still ran init; reading the scorer and the scorecard reader; three timed runs before and after; a mutant run; the six scoring tests; frozen verifier; two line refs moved down three lines in MAP-NOTES and checked against the test file; atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 18; the two endgame scorecard writer tests just above the scoring tests are the next to check.
layer: capabilities
