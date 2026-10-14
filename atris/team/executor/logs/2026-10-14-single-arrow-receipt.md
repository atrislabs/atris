# Single-input arrows keep engine recordings visible

The launch check now follows runners passed into arrow helpers whose single input has no parentheses. The required test command passed with 148 tests passed, zero failed, exit 0.

Files: `test/engine-resource.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/executor/logs/2026-10-14.md`, and this receipt.

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`.

Final proof: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0. Raw output: `/tmp/engine-single-arrow-final.log`.

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

`git diff --check` passed, exit 0. `atris slop detect atris/team/executor/logs/2026-10-14-single-arrow-receipt.md` returned `clean, no slop tells in 1 file`, exit 0.

Metric: twenty-one additional assertions cover direct and copied runners, profile members, async and concise arrows, shadowed parameters, help probes, and recording boundaries. The existing suite still contains 148 tests.

Review: a separate agent inspected the diff and found no concrete correctness issue. No production runtime code or dependencies changed.

First verification: exit 1, 147 passed and 1 failed because added lines moved existing map references. The references were corrected by matching each old test title to its current start line. Raw output: `/tmp/engine-single-arrow-proof.log`.

State notes: attaching the task to the mission was refused because its running parent holds the mission lock. The existing mission was preserved and a separate task records this slice. Brain activation and compilation returned plan-only output, exit 2; no generated policy files were written.

Scope limit: this remains a text scan. Destructured inputs, reassignment, and imported callers are not resolved.

next_push: detect runners passed into variable-bound function expressions.
layer: capabilities
