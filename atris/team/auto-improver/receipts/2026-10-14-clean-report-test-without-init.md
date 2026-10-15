The cleanup preview report test now skips the full workspace setup, about 0.36s to 0.09s, and it now checks that the preview writes nothing; it passed three runs, a mutant that made a logs folder during the preview failed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-clean-report-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^clean --dry-run --json reports' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
clean report test exit=0
ℹ tests 1
ℹ pass 1
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: the cleanup code was patched to create a logs folder before archiving journals. The test failed with actual atris and atris/logs against expected atris alone. The source was restored from git and checked clean.

Metric: one init launch removed. Three runs before: 365ms, 362ms, 370ms. Three runs after: 92ms, 93ms, 94ms.

Why it is safe: on a bare atris folder and on a fully set up one, the preview reported zero for every count and no manual actions, so setup added nothing the test reads. The test only checks the report shape, which is the same either way. The fresh workspace cleanup test keeps its setup on purpose, because its point is what setup produces.

Commands and artifacts: atris mission status; git status; a bare-folder preview run and a set up comparison; three timed runs before and after; the mutant run and restore; the test; frozen verifier; 21 line refs moved down two lines in MAP-NOTES by a script that matched every old target line to its new line (0 mismatches); atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 12; the two visualize dry-run tests are the next to check.
layer: capabilities
