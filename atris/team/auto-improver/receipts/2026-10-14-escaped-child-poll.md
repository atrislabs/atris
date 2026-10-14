## Escaped-child checks poll process completion

The two escaped-child checks now wait for the process to disappear instead of sleeping for three seconds total. Both affected checks and all 35 required checks passed, exit 0.

Files edited: test/one-lap-runtime.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Atris also regenerated atris/TODO.md through task commands. Receipt: atris/team/auto-improver/receipts/2026-10-14-escaped-child-poll.md.
Change: finish the interrupted polling change; pass the unique output path as a quoted positional shell argument so the process table can identify the child without interpreting path characters as code. Keep both empty-output and unchanged-master assertions. Poll every 25ms with a five-second bound and a bounded process scan. No product sandbox or authorization behavior changed.
Affected proof: node --test --test-name-pattern='new session|sandbox group leader' test/one-lap-runtime.test.js
Output: tests 2, pass 2, fail 0, duration_ms 18581.474667. Exit: 0.
Required proof: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, duration_ms 10086.6095. Exit: 0.
Baseline command: node --test --test-name-pattern='new session|sandbox group leader' test/.one-lap-timing-baseline.test.js, using the committed file copied beside the changed test. Output: tests 2, pass 2, fail 0, duration_ms 21788.130125. Exit: 0. Temporary baseline removed after use.
Metric: removed two unconditional 1500ms waits. One baseline/edited comparison fell from 21.79s to 18.58s, a 3.21s reduction; this is a single sample, not a stable benchmark.
Real-process probe: node invoked the actual polling helper against a shell child that waited 0.3s then wrote a marker whose path included spaces and quotes. Output: live child finished and wrote its marker before polling returned; absent child returned in 56ms. Exit: 0. This proves a surviving child can still reveal a cleanup failure before the assertion.
Slop: atris slop detect --diff -> clean, no slop tells in 3 files, exit 0 before navigation/receipt edits. Full-file scan found two pre-existing em dashes at lines 400 and 476, exit 1; no new tells added. Final changed-line scan and git diff --check recorded before commit.
Lesson: a negative late-write check can wait for the uniquely named real child to exit instead of hoping a fixed delay is long enough. Passing the path as an argument both exposes the marker to process inspection and preserves shell quoting.
Setup note: installed brain activate/compile commands returned plan-only output; optional generated brain files are absent. Existing workspace and policy were preserved.
Task proof: the initial proof-only submission refused to claim a command it had not run. The targeted command then failed inside atris task ready --verify (exit 1, pass 0, fail 2, duration_ms 308.311459); its truncated receipt does not contain the failure reasons. Direct invocation above passed both changed checks. The frozen verifier rerun through task ready passed, exit 0, and moved the task to Review. Receipts: atris/runs/2026-10-14-task-aic-17-2026-10-14T17-26-46-162Z.json (failed targeted wrapper) and atris/runs/2026-10-14-task-aic-17-2026-10-14T17-27-14-331Z.json (passed required check). Do not describe the wrapped targeted command as green.
Final slop check: atris slop detect --diff -> clean, no slop tells in 5 files, exit 0. git diff --check -> no output, exit 0.
next_push: Reproduce why the escaped-child tests pass directly but fail under task ready, capturing full output and checking inherited environment variables.
layer: capabilities
