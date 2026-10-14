# Resource history survives build folder cleanup

Resource records now belong to the main project, so deleting a linked build folder keeps start, end, and sweep evidence. One bounded slice; no dependencies added.

Plan: linked build folder -> main project log -> history survives cleanup.

Files edited: lib/engine-resource.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md. Artifacts: this receipt and atris/receipts/engine-resource-history-proof-2026-10-14.cjs. Preexisting TODO rendering changes and threshold export removals are excluded from the commit.

Failing first: `node --test --test-name-pattern='resource history survives' test/engine-resource.test.js`, exit 1. Output: `true !== false`, linked folder had its own resource log.

Rerunnable verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0.

Exact final summary:
```text
ℹ tests 73
ℹ suites 0
ℹ pass 73
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3199.877583
```

Real surface: `node atris/receipts/engine-resource-history-proof-2026-10-14.cjs`, exit 0. Starts a real Node child that kills itself, records live machine resources, invokes `node bin/atris.js engine sweep` from a real linked checkout, removes that checkout, and reads the surviving history. Sweep is read-only.

Output excerpt:
```text
nothing was stopped. run atris engine sweep --apply to stop them.
no sweep recorded yet
last SIGKILL: node on an unnamed task at 2026-10-14 12:57 UTC, killed (cause unknown), 75% memory free
0 of 1 SIGKILL ended with machine memory low
resource records retained after build folder removal: 2
recorded kills retained: 1
```

`git diff --check`, exit 0, no output. Brain activate and compile returned plan-only, exit 2, without writing unrelated adapters.

Review: independent review found no blocking issue; its test-fence suggestion now checks the resolved main-project log. Required checks reran after that assertion change and passed.

Progress: one new regression, 73 passing checks; start, end, and sweep records from real linked builds share main project storage. Previous folder-local records are not migrated.

next_push: bound resource log growth without losing paired run evidence.
layer: capabilities
