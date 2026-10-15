The conflicting receipt check now uses three command launches instead of four. The focused check and all 35 required checks passed, exit 0.

Changed surface: test/commands.test.js:13551. Inherited the unfinished setup-only claim change, inspected it, and completed its proof. Production claimTask seeds ownership; ready, accept and XP status still run through the real CLI. All receipt integrity, zero reward and readable label assertions remain.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt. Existing unrelated changes were preserved.

Plan: inspect inherited change -> focused CLI test -> frozen checks -> review and push.

Commands and actual output:
```text
node --test --test-name-pattern='^xp status fails closed on conflicting duplicate receipts with readable labels$' test/commands.test.js
✔ xp status fails closed on conflicting duplicate receipts with readable labels (571.536083ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 729.954125
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 11061.657
exit 0
```

Progress: one fewer child process, four to three (25% fewer launches in this check). No wall-clock improvement claimed without a baseline.
Readiness rerun: the task command initially resolved an older Node runtime without node:sqlite (exit 1). Use /opt/homebrew/bin/node in both commands above when rerunning through the task command. Direct proof above used Node v25.6.1. The task command then reran both checks with that absolute runtime, exit 0, and moved the work to Review. Proof artifact: atris/runs/2026-10-15-task-aic-64-2026-10-15T00-22-52-615Z.json.

Lesson: finish and verify an interrupted setup optimization before starting another; use the production store only for setup whose output the test never inspects.
next_push: Remove the setup-only claim launch in the tampered receipt ledger check, retaining real readiness, acceptance and tampered status checks.
layer: capabilities
