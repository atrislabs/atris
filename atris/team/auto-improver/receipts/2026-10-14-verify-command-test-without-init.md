The test that finds a task's own verify command now skips the full workspace setup, about 0.26s to under 0.01s; it passed three runs, a mutant whose moved task lost its verify line failed, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-verify-command-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^getVerifyCommand finds task-specific' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
verify-command test exit=0
ℹ tests 1
ℹ pass 1
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: a temporary copy of the test file without the verify line on the completed task failed with actual null, expected the task's command. The copy was deleted.

Metric: one init launch removed. Three runs before: 260ms, 257ms, 260ms for the test. Three runs after: 3.6ms, 3.6ms, 3.7ms.

Why it is safe: the finder reads only the to-do list, and the test writes that list twice, once with the task in the backlog and once in completed. Its checks were already exact, the command text and that it came from the task. The edit swaps one line, so no map refs moved.

Commands and artifacts: atris mission status; git status; reading the finder; three timed runs before and after; a mutant run; the test; frozen verifier; a line check on the two task lineage refs; atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 15; the unknown single-word command test is the next to check.
layer: capabilities
