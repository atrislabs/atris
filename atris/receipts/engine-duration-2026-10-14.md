# Final resource readings include run duration

Successful and failed engine runs now save elapsed milliseconds with their final memory and load readings, so builders can compare slow runs and failures. A monotonic clock measures only runner time, excluding starting and ending resource scans.

Task: EFM-4. Mission increment: 11.
Plan: start reading -> monotonic clock -> runner -> duration -> end reading.
Files edited: lib/fleet.js, lib/engine-resource.js, test/engine-resource.test.js, test/engine-dispatch.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md.
Artifacts produced: this receipt and atris/receipts/engine-duration-proof-2026-10-14.cjs.
Task commands regenerated atris/TODO.md, which remains unstaged. The preexisting exported-constant removal in lib/engine-resource.js is excluded from delivery. The member log remains in its existing ignored location.

## Proof

Failing first:
```sh
node --test --test-name-pattern='elapsed milliseconds|final resources measure|thrown and rejected' test/engine-resource.test.js test/engine-dispatch.test.js
```
Exit 1: 0 passed, 5 failed. The duration field was missing in the unit check, real waiting child, and synchronous and asynchronous killed-child checks.

Rerunnable verification:
```sh
node --test test/engine-resource.test.js test/engine-dispatch.test.js
```
Exit 0. Exact final output:
```text
ℹ tests 72
ℹ suites 0
ℹ pass 72
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3689.017875
```

Real dispatch invocation, using real Node children:
```sh
node atris/receipts/engine-duration-proof-2026-10-14.cjs
```
Exit 0. Exact output:
```json
{"phases":["start","end","start","end"],"end_duration_ms":[112,49],"failure_signal":"SIGKILL","original_error_preserved":true}
```
This reusable proof checks a child waiting 50 milliseconds, a killed child, two paired final records, missing start durations, and original error identity. Elapsed values vary on rerun.

git diff --check: exit 0, no output.
Independent read-only review approved with no defects; the reviewer did not rerun checks. This was an independent agent review, not a separately selected model.
Brain activation and compile returned plan-only output, exit 2. Generated policy adapters stay outside this bounded increment.
No dependencies added. Older resource records stay readable.

Metric: 72 checks passed, zero failed; two real child runs recorded final durations, including a killed run.
next_push: preserve resource history in the main project folder so removing an isolated build folder cannot erase machine diagnostics.
layer: capabilities
