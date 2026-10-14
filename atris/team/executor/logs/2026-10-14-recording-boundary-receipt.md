Engine launch checks now reject recording calls borrowed from neighboring top-level functions, verified with 148 tests passed, 0 failed, exit 0.

Changed files:
- test/engine-resource.test.js: keep each recording window inside the launch's top-level function or top-level region; add 15 planted regression assertions.
- atris/MAP.md and atris/refs/MAP-NOTES.md: update shifted test references and document the boundary rule.
- atris/team/executor/logs/2026-10-14.md: save work and lessons.
- atris/team/executor/logs/2026-10-14-recording-boundary-receipt.md: this receipt.

Plan: inspect saved state -> close one recording boundary gap -> scan real launch files -> run frozen checks -> save proof -> commit and push.

Rerun: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Final exit: 0. Actual output excerpt:

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
ℹ duration_ms 63154.692125
```

Raw final output: /tmp/engine-recording-boundary-final-tests.log. Output was redirected without a pipe; process exit was checked directly.

Real-surface rejection proof: temporarily appended a recorder-only function and an unrecorded runner launch to commands/voice.js, then ran node --test --test-name-pattern="every engine started through" test/engine-resource.test.js. Actual output named commands/voice.js:228 runner, tests 1, pass 0, fail 1, exit 1 as expected. The original file was restored in finally and has no diff.

Additional checks: node --test --test-name-pattern='every launch of an engine|every engine started through' test/engine-resource.test.js passed both scans, exit 0; git diff --check returned no output, exit 0.

Independent review: gpt-6-sol read-only review passed after concise and multiline arrow regressions were added. Residual limits: semicolon-free or unusual formatting, nested scopes, and same-line adjacent definitions are not fully parsed. No dependencies or runtime launcher behavior changed.

Bookkeeping: the running parent holds the mission mutation lock, so mission state was left alone and ECM-3 carries the review proof. Brain activation and compile returned plan-only, exit 2, without changing unrelated adapters. The task commands regenerated TODO.md; its prior rendered snapshot is retained to avoid landing unrelated board churn, while the task database remains authoritative.

Metric: 15 new assertions; 148 tests passed; 13 real engine launches checked with zero missing recordings.
next_push: prevent a recorder inside a nested helper from covering its enclosing function's unrecorded launch.
Saved review proof: atris/runs/2026-10-14-task-ecm-3-2026-10-14T21-12-55-852Z.json, exit 0. Exact command: node bin/atris.js task ready ECM-3 --verify "node --test test/engine-resource.test.js test/engine-dispatch.test.js" with the result and receipt note above. Task state is Review, pending acceptance.

Proof environment lesson: the installed CLI uses a login shell that resolves Node 20.18.0; its save-proof run failed (127 passed, 21 failed, exit 1). The local CLI pins the running Node 25.6.1 after the login profile, and the same frozen command passed (148 passed, 0 failed, exit 0). This was resolved by invoking the existing local CLI, without changing verification policy or broadening the code slice.

Additional produced artifact: atris/runs/2026-10-14-task-ecm-3-2026-10-14T21-12-55-852Z.json, the machine-readable successful proof included with this change.
layer: capabilities
