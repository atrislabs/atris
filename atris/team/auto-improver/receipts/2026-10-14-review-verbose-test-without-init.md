The verbose review board test now skips the full workspace setup, about 0.35s to 0.09s, and it now checks the board still renders when the validator spec is missing; it passed three runs, a CLI mutant that refused the board without that spec failed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-verbose-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^review verbose mode keeps' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
review verbose test exit=0
ℹ tests 1
ℹ pass 1
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: the review code was patched to exit with "run atris init first" when no validator spec exists. The test failed with exit 1 against expected 0. With init, the old test would have passed, because init writes that spec. The source was restored from git and checked clean.

Metric: one init launch removed. Three runs before: 356ms, 338ms, 351ms. Three runs after: 91ms, 89ms, 88ms.

Why it is safe: the review command shows the first-minute screen only when the atris folder is missing. With the folder present it prints the full board, and every context file is optional and shown as missing when absent. The board's other checks are fixed text. The default review test stays on init for now, because it drives the task store through claim, ready and review.

Commands and artifacts: atris mission status; git status; reading the review command and the fresh workspace check; a bare-folder run of the verbose board; three timed runs before and after; the mutant run and restore; the test; frozen verifier; four line refs moved down two lines in MAP-NOTES, with targets checked; atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 13; the clean dry-run report and clean fresh workspace tests are the next to check.
layer: capabilities
