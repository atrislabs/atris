Internal function-name launch checks pass the required two test files, 148 passed, zero failed, exit 0.

Changed: runner and profile arguments passed through a named expression's internal calls now identify engine launches. Internal calls are confined to the expression; parameters and earlier local aliases hide a distinct internal name, and an outer alias does not. Matching assigned and internal names preserve existing calls.

Files edited and committed: test/engine-resource.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/executor/logs/2026-10-14.md; this receipt.
Generated file edited by task commands, left unstaged: atris/TODO.md. Task truth remains in the task database.

Rerunnable proof command: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Final invocation exit: 0. Raw output: /tmp/executor-tick15-final-tests.txt.
Output excerpt:
```
real engine launch scan: 5 launches by name, 0 unrecorded
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
ℹ tests 148
ℹ pass 148
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 64549.553333
```
Other commands: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-machine-memory-load-5ec77704; atris mission goal --json; git status --short --branch; atris task list; atris task new; atris task claim ECM-10 --as executor; atris task note ECM-10; atris task ready ECM-10 --verify 'git diff --check'; git diff --check (exit 0); atris brain compile --root . (exit 2, preview only, no additional files written); git add declared files; git commit; git push.

Metric: 26 additional assertions, 148 tests passed, 5 literal and 8 variable launches scanned, zero missing recordings.
Review: independent review and second-model review approved the corrected bounded diff. Review caught parameter/local shadow false positives, an outer-alias false negative, and matching-name false negatives; all have regression assertions.
Learning: the expression's internal binding differs from the assigned binding, so scope checks must preserve both call paths without treating the defining assignment as a shadow.
Limit: arbitrary nested shadowing, destructuring, and reassignment remain outside this text scan.
Stop: this single slice is verified and ready for review; no second slice started and the ongoing mission is preserved.
next_push: exclude internal-name calls owned by nested functions that shadow that name.
layer: capabilities
