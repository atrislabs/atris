The local task factory API check went from about 2.65s to 1.79s. Three owner tasks now get their plan and do steps through the task store. It passed five runs, a planted owner precedence bug failed it where the seeded tasks are read, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-factory-api-owner-tasks-store-staged.md.

Rerunnable verification command:
`node --test --test-name-pattern='^task serve exposes a local task factory API$' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task serve exposes a local task factory API (1793.506666ms)
✔ task serve exposes a local task factory API (1787.357084ms)
✔ task serve exposes a local task factory API (1785.78125ms)
✔ task serve exposes a local task factory API (1817.347875ms)
✔ task serve exposes a local task factory API (1789.347959ms)
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: nothing to move.
```

Change: the owner query cases set up three tasks with six plan and do runs. Those runs now make the same store call the plan and do commands make, once per step. Every server request is unchanged. That removes the last six command launches from this check.

Why it is safe: before editing, a scratch script ran plan and do both ways on fresh stores and compared the saved rows. Status, claim owner, and every Plan and Do field matched exactly once timestamps and the plan trace were set aside. The owner cases read the claim and those fields, not the trace.

Cost: the plan command's automatic owner pick and plan trace no longer run for these three tasks. Other checks cover the plan and do commands directly.

Proof the check still bites: the current step endpoint was patched to prefer the caller over the owner named in the request. The check failed at the owner precedence status line (expected 409, got 200), right after the seeded tasks are read. The source was restored from git and checked clean.

Metric: three runs before: 2624ms, plus suite totals of 2770ms, 2754ms, 2704ms. Five runs after: 1786ms to 1817ms.

Map refs: 41 refs shifted seven lines from the diff, each matched by line content, 0 mismatches.

next_push: Time every check in test/commands.test.js that starts a task server and pick the slowest one that still sets up state with command launches.
layer: capabilities
