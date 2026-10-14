# Function expressions keep engine recordings visible

The launch check follows runners passed into functions assigned to variables, including anonymous, named, and async functions. The required tests passed: 148 passed, zero failed, exit 0.

Files edited: `test/engine-resource.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/executor/logs/2026-10-14.md`, and this receipt. Production runtime files and dependencies did not change.

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`.

Real invocation: that exact command ran on Node v25.6.1, exit 0. Raw output: `/tmp/engine-function-proof.log`.

```text
real engine launch scan: 5 launches by name, 0 unrecorded
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
ℹ tests 148
ℹ pass 148
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Metric: thirty new assertions cover runner and profile arguments, local aliases, argument positions, parameter shadowing, unrelated programs, help probes, and recording boundaries. Map links moved with their referenced test lines.

Review: a separate agent found no concrete correctness issue and passed the targeted runner/profile recording test, exit 0. `git diff --check` passed, exit 0.

Readiness: the task is in Review. The handoff ran `git diff --check`, exit 0, and retained the full required test proof above. Saved handoff: `atris/runs/2026-10-14-task-ecm-9-2026-10-14T21-56-56-426Z.json`. Two initial handoff attempts required plainer result and landing text before the successful attempt. No task acceptance was performed.

Prose check: `atris slop detect atris/team/executor/logs/2026-10-14-function-expression-receipt.md`, exit 0, `clean, no slop tells in 1 file`.

State notes: mission task attachment was refused because the active parent holds the mission lock. A separate claimed task records this slice. Brain activation and compilation returned plan-only output, exit 2; generated policy files were not written. The task command regenerated the legacy task view; that generated churn is excluded from this change.

Scope limit: this remains a text scan. Internal recursive names, destructuring, reassignment, and imported callers are not resolved.

next_push: follow engine runner parameters through named function expressions called by their internal recursive name.
layer: capabilities
