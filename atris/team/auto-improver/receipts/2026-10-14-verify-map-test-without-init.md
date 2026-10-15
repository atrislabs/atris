The verify test for a filled-in map now skips the full workspace setup, about 0.48s to 0.19s, and checks the ref count of the map it writes; it passed three runs, failed when a map line was removed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-verify-map-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^verify ' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
exit=0
✔ verify passes with populated MAP.md (186.088458ms)
✔ verify passes with populated MAP.md (199.294166ms)
✔ verify passes with populated MAP.md (197.425416ms)
mutated exit=1
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /4 file refs/.
verify tests exit=0
ℹ tests 4
ℹ pass 4
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Metric: one init launch removed. Three runs before: 469ms, 472ms, 506ms. Three runs after: 186ms, 199ms, 197ms.

Ranking: 29 tests in the command test file still ran a full init. One filtered run timed them all. The two slowest (the certified review test at 1.31s and the recent signals test at 1.27s) depend on what init writes: the review test drops the projection init writes, and the signals test reads git history. The two verify map tests came next at about 0.65s each inside that run.

Why only one of the two verify tests: workspace verify checks the map, a test command from a package file, and recent git changes against the map. A bare temp folder has no package file and no git, so the map the test writes is the only input. The placeholder test keeps init on purpose, because it checks that the map init writes fails verify.

New check: the test now confirms verify counted the four file refs in the map it wrote. Before, it only checked for the word valid.

Commands and artifacts: atris mission status; git status; a script listing every test that calls init (29); one filtered timing run of all 29; reading the verify entry, map check and workspace checks; three timed runs before and after; a mutation run; all four verify tests; frozen verifier; ref shift script with a line match check (34 line numbers, all matched); atris doc-health (exit 0); atris slop detect.

next_push: From the same ranking, take the next init test whose checks read only what the test writes: the analytics zero-completions check and the computer card test are about 0.5s each and look like candidates.
layer: capabilities
