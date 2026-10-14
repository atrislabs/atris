Nested helper recordings no longer hide an unrecorded parent launch, verified by the frozen checks: 148 passed, zero failed, exit 0.

Plan: saved context -> blank helper definitions -> check both real source scans -> frozen tests -> review -> commit and push.

Files edited: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt.

Rerun: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Actual output (exit 0):
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
ℹ duration_ms 64003.634375
```
Raw output: /tmp/engine-nested-final.log. Both checks scanned the real repository source. Twelve new assertions cover named, block-arrow and concise-arrow helpers, direct parent recordings, genuine nested recordings, and false parent recording wrappers. The first focused run failed only because two fixture line expectations were off by one; corrected expectations and focused checks passed before the frozen run.

Review: independent read-only review found no blocking issue and ran three direct helper probes successfully. This is a text scan, not a JavaScript parser: regex literals, template interpolation, unrecognized function syntax and semicolon-free concise arrows remain outside its guarantee. No runtime code or dependencies changed.

Commands: git status --short; atris mission status mission-2026-10-14-continue-machine-memory-load-5ec77704; atris mission goal --json (no candidate); atris task list --status open; atris task new, claim, note and ready; node --test --test-name-pattern='every launch of an engine|every engine started through' test/engine-resource.test.js (exit 0 after expectation correction); frozen command above (exit 0); git diff --check (exit 0, empty output); atris brain activate --root . --verify and atris brain compile --root . (plan-only, no adapter changes). Mission attach-task was locked by the active parent; no lock or mission policy was changed. Generated TODO snapshot was preserved from HEAD; task truth stays in its database.

Metric: twelve new assertions; 148 passing tests; thirteen recognized source launches with zero missing recordings.
next_push: stop a parent function's recording from covering an unrecorded launch inside a nested helper.
layer: capabilities

Saved review proof: atris/runs/2026-10-14-task-ecm-5-2026-10-14T21-26-08-139Z.json. The ready command required its own execution of the frozen checks, repeated them with exit 0, 148 passed and 0 failed, and moved the task to Review. Duration: 64097.534458 ms. Raw saving output: /tmp/engine-nested-ready.log. The initial prose-only ready attempt was rejected because that process had not executed the command; no policy or verifier was changed.
