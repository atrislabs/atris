Spaced helper calls now retain engine recording checks; the required test command passed with exit 0.

Files edited: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md.
Artifact: atris/receipts/engine-spaced-calls-2026-10-14.md.
Change: permit whitespace between a local helper name and its opening call parenthesis. Added eighteen assertions across spaces, tabs, and line breaks for literal runners, resolver runners, profile arguments, recorded runs, help probes, and unrelated programs.
Scope: prior uncommitted shell warning, task board, map, and member-log edits are preserved separately and excluded from this commit.

Verify command: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Actual output excerpt:
ℹ tests 151
ℹ suites 0
ℹ pass 151
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 42981.076333
Exit code: 0.
Additional check: git diff --check, exit 0, no output.
Review: separate read-only review found no correctness problems. It used the same available model; no different model was selected by the runtime.
State commands: atris mission status mission-2026-10-14-continue-machine-memory-load-5ec77704; atris mission goal --json; atris task list --status open; atris task new; atris task claim; atris task note. Mission attachment was lock-busy, so this bounded work uses its own task. Brain activate and compile were run in plan-only mode and wrote no generated policy files.
Metric: eighteen new assertions, all 151 tests passing, zero failures.
Stop: one increment completed and proven; no second slice started.
next_push: make the runner-variable launch expression itself recognize whitespace between the spawn helper name and its opening parenthesis.
layer: capabilities
