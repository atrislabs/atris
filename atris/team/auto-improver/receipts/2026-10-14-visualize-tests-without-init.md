The two visualize preview tests now skip the full workspace setup, about 0.34s to 0.09s each, and the first now checks the workspace map reaches the prompt; both passed three runs, a mutant that added context to raw prompts failed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-visualize-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^visualize dry-run' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
visualize tests exit=0
ℹ tests 2
ℹ pass 2
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: the visualize code was patched so raw prompts also got workspace context. The raw test failed on the context block. Without a map in the folder, that check would pass on any code, because there would be no context to leave out. The source was restored from git and checked clean.

Metric: two init launches removed. Three runs before, both tests together: 811ms, 830ms, 826ms. Three runs after: 328ms, 311ms, 313ms.

Why it is safe: the preview reads the atris folder to pick the default output folder, and reads the map, to-do list, business file and wiki only to build optional context. Each test now writes the atris folder and a small map. The first test checks that map shows up as context, and the raw test relies on it so its "no context" check means something.

Also fixed: one map note ref for the release help test pointed at an unrelated assertion line; it now points at the test itself.

Commands and artifacts: atris mission status; git status; reading the visualize context and output path code; three timed runs before and after; the mutant run and restore; both tests; frozen verifier; 22 line refs moved through the three diff hunks by a script that matched every old target line (0 mismatches), with spot checks by test name; atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 10; the two recent signals tests are the next to check.
layer: capabilities
