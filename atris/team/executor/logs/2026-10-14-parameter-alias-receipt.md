The launch check now follows copied runner and profile parameters, verified with 148 tests passed, 0 failed, exit 0.

Plan: inspect saved state -> follow parameter aliases -> scan real source -> run frozen checks -> save proof -> commit and push.

Files edited: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt.

Rerun: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Final exit: 0. Actual output:

```text
real engine launch scan: 5 launches by name, 0 unrecorded
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
ℹ tests 148
ℹ suites 0
ℹ pass 148
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 87083.652708
```

Raw output: /tmp/engine-parameter-alias-tests-final.log.

Real-surface proof: created a temporary commands/engine-alias-proof.js containing a launch through a copied profile parameter, then ran node --test --test-name-pattern="every engine started through" test/engine-resource.test.js. Exit 1 as expected, output named commands/engine-alias-proof.js:4 program. Removed only that temporary file in finally. Raw output: /tmp/engine-parameter-alias-rejection.log.

Initial frozen run: exit 1, 147 passed and 1 failed because the new map note pointed inside the test. Corrected both notes to the test start and reran the frozen command, yielding the passing output above. Raw initial output: /tmp/engine-parameter-alias-tests.log.

Review: independent read-only review found no blocking issue. Reassignments, destructuring, arrow parameters, imported callers, and chains across functions remain outside the source scan. No runtime behavior or dependency changes.

Other commands: git status --short --branch; atris mission status mission-2026-10-14-continue-machine-memory-load-5ec77704; atris mission goal --json (no goal candidate); atris task list --status open; atris task new, claim, note, and ready; git diff --check (exit 0, empty output). Mission attachment remained locked by its active parent and was left alone. Brain activation and compile returned plan-only, exit 2, without adapter changes. The generated TODO snapshot is preserved from before task bookkeeping; task truth remains in the database.

Metric: six new regression assertions; 148 passing tests; thirteen recognized source launches and zero missing recordings.
next_push: prevent a recording call inside a nested helper from covering its enclosing function's unrecorded launch.
layer: capabilities

Saved review proof: atris/runs/2026-10-14-task-ecm-4-2026-10-14T21-20-26-019Z.json. The local ready command repeated the frozen checks and exited 0; task is in Review. Raw saving output: /tmp/engine-parameter-alias-ready.log.

The first ready attempt rejected the result wording, and the next rejected a prose-only test claim because that process had not run the checks. Used the required local --verify command to produce executed evidence, with no policy changes.
