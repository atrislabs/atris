Captured runner checks now retain outer declarations after sibling helpers close, verified by the frozen test command exiting 0.

Files changed: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, this receipt.

Change: blank sibling helper definitions before tracing runner and profile declarations. Preserve outer captures and exclude helper-local variables. Added sixteen regression assertions. Updated stale test pointers using matching test headers in git history.

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Exit: 0
Output:
```text
ℹ tests 148
ℹ suites 0
ℹ pass 148
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36739.177792
```

Other commands: targeted runner scan failed before the fix (exit 1), then passed (exit 0, eight actual repository launches, none unrecorded); targeted map reference check passed (exit 0); git diff --check passed (exit 0). Baseline full run failed only on stale map pointers. Full output: /tmp/executor-27-proof.tap; reproduction: /tmp/executor-27-regression.tap; targeted pass: /tmp/executor-27-targeted.tap.

Boot and state: atris brain activate --root . --verify and atris brain compile --root . both returned plan-only exit 2 because generated brain files are absent; no adapter regeneration was authorized by this bounded slice. Read mission status, task list, mission goal (no candidate), and git status. Existing scout, fleet, and rendered task-view edits were preserved and excluded from this commit.

Metric: sixteen new assertions; 148 tests passed; zero failed.
next_push: extend captured-runner regressions to runner arguments passed after a sibling helper closes.

Review: independent review found an uninitialized local variable could expose an outer runner. Bare and destructured declarations now stop lookup; six additional assertions cover those findings.


Readiness check runtime: the task command uses a login shell that selected /usr/local/bin/node and failed 21 checks. The bare frozen command uses /opt/homebrew/bin/node and passed all 148. Readiness rerun pins /opt/homebrew/bin/node with the same two test files.


Readiness: pinned Node check exited 0; task moved to Review. Receipt: atris/runs/2026-10-15-task-ecm-12-2026-10-15T00-25-57-978Z.json. Independent review confirmed both shadowing regressions resolved.

layer: capabilities
